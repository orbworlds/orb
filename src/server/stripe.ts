// Stripe, for Orb's plans (./billing.ts): a small REST client (form-encoded, as Stripe's own
// libraries send it), webhook signatures, and what Orb sets up in a Stripe account by itself so
// that a secret key (STRIPE_SECRET_KEY) is all it needs: the Pro price (found by its lookup key),
// the customer portal's settings and, without STRIPE_WEBHOOK_SECRET, its own webhook endpoint.
// What it made is remembered in orb_meta per secret key, so a sandbox and the live account each
// get their own.

import crypto from 'node:crypto';
import type { Db } from './db';

const API = (process.env.ORB_STRIPE_API || 'https://api.stripe.com').replace(/\/+$/, '');

/**
 * The secret key: ORB_STRIPE_SECRET_KEY when set (a Stripe account of Orb's own choosing), else
 * STRIPE_SECRET_KEY (what Vercel's Stripe integration manages, and may overwrite).
 */
export const stripeKey = (): string | null => process.env.ORB_STRIPE_SECRET_KEY?.trim() || process.env.STRIPE_SECRET_KEY?.trim() || null;

/** Whether Orb can sell plans here (a Stripe secret key is set). */
export const paymentsOn = (): boolean => !!stripeKey();

/** A Stripe sandbox's key (`sk_test_…`): its checkouts take test cards. */
export const stripeTestMode = (): boolean => /^(sk|rk)_test_/.test(stripeKey() ?? '');

export class StripeError extends Error {
  status: number;
  code?: string;
  /** The request parameter Stripe complained about (e.g. `customer`). */
  param?: string;
  constructor(status: number, message: string, code?: string, param?: string) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

/** `{a: {b: 1}, c: [x]}` → `a[b]=1&c[0]=x`, Stripe's way of nesting form fields. */
export function formEncode(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  const add = (key: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => add(`${key}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) add(`${key}[${k}]`, x);
    else out.append(key, String(v));
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out;
}

export async function stripe<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, unknown> = {}, opts: { idempotencyKey?: string } = {}): Promise<T> {
  const key = stripeKey();
  if (!key) throw new StripeError(503, 'Stripe is not set up (STRIPE_SECRET_KEY).');
  const body = formEncode(params);
  const query = method === 'GET' && [...body.keys()].length ? `?${body}` : '';
  let res: Response;
  try {
    res = await fetch(`${API}${path}${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
      },
      body: method === 'POST' ? body.toString() : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new StripeError(502, `Stripe unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const err = (json.error ?? {}) as { message?: string; code?: string; param?: string };
    throw new StripeError(res.status, `Stripe ${res.status} (${method} ${path}): ${err.message ?? text.slice(0, 200)}`, err.code, err.param);
  }
  return json as T;
}

// -- webhook signatures ---------------------------------------------------------------------------

/**
 * Whether `header` (Stripe-Signature: `t=<unix>,v1=<hex>[,v1=…]`) signs `payload` with `secret`,
 * made within `toleranceSec` of now (replays of old deliveries are refused).
 */
export function verifySignature(payload: string, header: string | null, secret: string, toleranceSec = 300, now = Date.now()): boolean {
  if (!header || !secret) return false;
  let t = '';
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') sigs.push(v);
  }
  const ts = Number(t);
  if (!t || !Number.isFinite(ts) || !sigs.length || Math.abs(now / 1000 - ts) > toleranceSec) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${payload}`, 'utf8').digest('hex'));
  return sigs.some((s) => {
    const got = Buffer.from(s);
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

/** A Stripe-Signature header for `payload` (the fake Stripe in tests signs this way too). */
export function signPayload(payload: string, secret: string, at = Math.floor(Date.now() / 1000)): string {
  return `t=${at},v1=${crypto.createHmac('sha256', secret).update(`${at}.${payload}`, 'utf8').digest('hex')}`;
}

// -- what Orb sets up in the account ----------------------------------------------------------------

/** Short fingerprint of the secret key: what Orb made in one Stripe account is kept apart from another's. */
function account(): string {
  return crypto.createHash('sha256').update(stripeKey() ?? '').digest('hex').slice(0, 12);
}

async function getMeta(db: Db, key: string): Promise<{ value: string; at: Date } | null> {
  const rows = await db.query<{ value: string; at: Date | string }>(`select value, at from orb_meta where key = $1`, [key]);
  return rows[0] ? { value: rows[0].value, at: new Date(rows[0].at) } : null;
}

async function setMeta(db: Db, key: string, value: string): Promise<void> {
  await db.query(`insert into orb_meta (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, at = now()`, [key, value]);
}

const prices = new Map<string, string>();

/** The monthly Pro price (made the first time, then found again by its lookup key). */
export async function proPrice(usd: number): Promise<string> {
  const cents = Math.round(usd * 100);
  const lookup = `orb_pro_month_usd_${cents}`;
  const cacheKey = `${account()}:${lookup}`;
  const known = prices.get(cacheKey);
  if (known) return known;
  const found = await stripe<{ data?: Array<{ id: string }> }>('GET', '/v1/prices', { lookup_keys: [lookup], active: true, limit: 1 });
  let id = found.data?.[0]?.id;
  if (!id) {
    const made = await stripe<{ id: string }>(
      'POST',
      '/v1/prices',
      { currency: 'usd', unit_amount: cents, recurring: { interval: 'month' }, lookup_key: lookup, product_data: { name: 'Orb Pro' }, metadata: { orb: 'pro' } },
      { idempotencyKey: `orb-price-${lookup}` },
    );
    id = made.id;
  }
  prices.set(cacheKey, id);
  return id;
}

/** The customer portal's settings for Orb: cancel at the period's end, cards, invoices. */
export async function portalConfiguration(db: Db): Promise<string | null> {
  const key = `stripe:portal:${account()}`;
  const known = await getMeta(db, key);
  if (known) return known.value;
  try {
    const made = await stripe<{ id: string }>('POST', '/v1/billing_portal/configurations', {
      business_profile: { headline: 'Orb — your plan' },
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: 'at_period_end' },
      },
    });
    await setMeta(db, key, made.id);
    return made.id;
  } catch (e) {
    // The account's own default settings (saved in Stripe's dashboard) still work.
    console.error('[orb] creating the Stripe portal settings failed', e instanceof Error ? e.message : e);
    return null;
  }
}

export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
];

interface Endpoint {
  id: string;
  url: string;
  secret: string;
  /** The events it was registered for (none: before Orb remembered them). */
  events?: string[];
}

/** How Orb's own webhook endpoints are described in Stripe (how Orb knows them again). */
const ORB_ENDPOINT = 'Orb plans and credits';

/** The secrets webhook deliveries may be signed with: STRIPE_WEBHOOK_SECRET, and the endpoint Orb registered. */
export async function webhookSecrets(db: Db): Promise<string[]> {
  const out: string[] = [];
  const fromEnv = (process.env.STRIPE_WEBHOOK_SECRET ?? '').trim();
  if (fromEnv) out.push(fromEnv);
  if (stripeKey()) {
    const known = await getMeta(db, `stripe:webhook:${account()}`);
    try {
      const ep = known ? (JSON.parse(known.value) as Partial<Endpoint>) : null;
      if (ep?.secret) out.push(ep.secret);
    } catch {
      /* 'pending' */
    }
  }
  return out;
}

/** The webhook endpoint Orb registered in this key's account (its address), if it has one. */
export async function registeredWebhook(db: Db): Promise<{ id: string; url: string } | null> {
  if (!stripeKey()) return null;
  const known = await getMeta(db, `stripe:webhook:${account()}`);
  try {
    const ep = known ? (JSON.parse(known.value) as Partial<Endpoint>) : null;
    return ep?.id && ep.url ? { id: ep.id, url: ep.url } : null;
  } catch {
    return null;
  }
}

/**
 * Without STRIPE_WEBHOOK_SECRET, register Orb's webhook endpoint at `url` (once per account and
 * address; a new address replaces the old endpoint). Best effort: checkouts also confirm
 * themselves when people come back, and Pro renewals are looked up when a period ends.
 */
export async function ensureWebhook(db: Db, url: string | null): Promise<void> {
  if (!url || (process.env.STRIPE_WEBHOOK_SECRET ?? '').trim() || !stripeKey()) return;
  const key = `stripe:webhook:${account()}`;
  const known = await getMeta(db, key);
  let previous: Endpoint | null = null;
  if (known) {
    try {
      previous = JSON.parse(known.value) as Endpoint;
    } catch {
      previous = null;
    }
    if (previous?.url === url) {
      // Orb listens to more events now: the endpoint (and its secret) stays, with the new list.
      if (previous.events?.join() === WEBHOOK_EVENTS.join()) return;
      try {
        await stripe('POST', `/v1/webhook_endpoints/${encodeURIComponent(previous.id)}`, { enabled_events: WEBHOOK_EVENTS });
        await setMeta(db, key, JSON.stringify({ ...previous, events: WEBHOOK_EVENTS } satisfies Endpoint));
      } catch (e) {
        console.error('[orb] updating the Stripe webhook’s events failed', e instanceof Error ? e.message : e);
      }
      return;
    }
    // Someone else is registering it right now (a minute is plenty for that).
    if (!previous && Date.now() - known.at.getTime() < 60_000) return;
  }
  // Claim the registration, so two first checkouts at once make one endpoint.
  const claimed = known
    ? await db.query(`update orb_meta set value = 'pending', at = now() where key = $1 and value = $2 and (value <> 'pending' or at < now() - interval '60 seconds') returning key`, [key, known.value])
    : await db.query(`insert into orb_meta (key, value) values ($1, 'pending') on conflict (key) do nothing returning key`, [key]);
  if (!claimed.length) return;
  try {
    const made = await stripe<{ id: string; secret?: string }>('POST', '/v1/webhook_endpoints', { url, enabled_events: WEBHOOK_EVENTS, description: ORB_ENDPOINT });
    if (!made.secret) throw new StripeError(502, 'Stripe returned no webhook secret');
    await setMeta(db, key, JSON.stringify({ id: made.id, url, secret: made.secret, events: WEBHOOK_EVENTS } satisfies Endpoint));
    // Orb's earlier endpoints at this address (made with another key of the account, or remembered by
    // a database that's gone): nothing knows their secrets any more, so their deliveries would only fail.
    const listed = await stripe<{ data?: Array<{ id: string; url?: string; description?: string | null }> }>('GET', '/v1/webhook_endpoints', { limit: 100 }).catch(() => null);
    const stale = new Set((listed?.data ?? []).filter((ep) => ep.id !== made.id && ep.url === url && ep.description === ORB_ENDPOINT).map((ep) => ep.id));
    if (previous?.id) stale.add(previous.id);
    for (const id of stale) await stripe('DELETE', `/v1/webhook_endpoints/${encodeURIComponent(id)}`).catch(() => undefined);
  } catch (e) {
    console.error('[orb] registering the Stripe webhook failed', e instanceof Error ? e.message : e);
    if (previous) await setMeta(db, key, JSON.stringify(previous));
    else await db.query(`delete from orb_meta where key = $1 and value = 'pending'`, [key]);
  }
}
