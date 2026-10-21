// Orb's plans with Stripe (docs/operations.md "Plans and credits"): checkouts for Pro and for credit packs, the
// customer portal, and each account's wallet (./credits.ts) kept in step with its subscription.
// Every change reaches Orb in up to three ways, all idempotent: Stripe's webhook, the page people
// come back to after paying (/api/billing/return), and a lookup when a Pro period is over. So the
// plans work even before the webhook is set up.

import type { BillingInfo, CreditPack } from '@/lib/types';
import type { Db } from './db';
import {
  allowanceOf,
  endPro,
  ensureWallet,
  grantTopup,
  markSynced,
  monthOf,
  plansConfig,
  readWallet,
  setCustomer,
  setProPeriod,
  toMicros,
  TYPICAL_BUILD_CREDITS,
  userOfPayer,
  walletOfCustomer,
  type PlansConfig,
  type Wallet,
} from './credits';
import { webhookUrl } from './billingurls';
import { connectReady, rememberCard, reverseBuyer, withPayouts } from './payouts';
import { shopShare } from './shop';
import { ensureWebhook, envSecret, paymentsOn, portalConfiguration, proPrice, registeredWebhook, stripe, StripeError, stripeTestMode } from './stripe';

/** How long a Pro period Stripe hasn't renewed stays Pro after its end (a renewal may come late). */
const GRACE_MS = 3 * 86400_000;
/** A Pro period that ended is looked up in Stripe once, then at most this often. */
const SYNC_EVERY_MS = 10 * 60_000;

/** The payer's wallet as it stands: guest and Free months refreshed, an ended Pro period checked with Stripe. */
export async function currentWallet(db: Db, payer: string, cfg: PlansConfig = plansConfig(), now: Date = new Date()): Promise<Wallet> {
  let w = await ensureWallet(db, payer, cfg, now);
  if (w.plan !== 'pro' || Date.parse(w.periodEnd) > now.getTime()) return w;
  const synced = w.syncedAt ? Date.parse(w.syncedAt) : 0;
  if (paymentsOn() && w.stripeSubscription && (synced < Date.parse(w.periodEnd) || now.getTime() - synced > SYNC_EVERY_MS)) {
    try {
      await markSynced(db, payer);
      w = (await applySubscription(db, await getSubscription(w.stripeSubscription), cfg, userOfPayer(payer))) ?? w;
    } catch (e) {
      console.error('[orb] looking up a Pro renewal failed', e instanceof Error ? e.message : e);
    }
  }
  if (w.plan === 'pro' && now.getTime() - Date.parse(w.periodEnd) > GRACE_MS) w = (await endPro(db, payer, 'lapsed', cfg, now)) ?? w;
  return w;
}

/**
 * Whether the account with this handle can pay here: Stripe is set up, and on the live site a
 * sandbox's key only takes the accounts in ORB_STRIPE_TEST_ACCOUNTS (anyone else would get Pro
 * for a test card).
 */
export function paymentsFor(handle: string | null, env: Record<string, string | undefined> = process.env): boolean {
  if (!paymentsOn()) return false;
  if (!stripeTestMode() || env.VERCEL_ENV !== 'production') return true;
  const allowed = (env.ORB_STRIPE_TEST_ACCOUNTS ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  return !!handle && allowed.includes(handle.toLowerCase());
}

/** The same for a payer (an account, by its handle; a device without one has none). */
export async function paymentsForPayer(db: Db, payer: string): Promise<boolean> {
  const userId = userOfPayer(payer);
  if (!paymentsOn() || !stripeTestMode() || process.env.VERCEL_ENV !== 'production') return paymentsOn();
  if (!userId) return false;
  const rows = await db.query<{ handle: string }>(`select handle from orb_handles where owner_user = $1`, [userId]);
  return paymentsFor(rows[0]?.handle ?? null);
}

/** A build on Orb's AI pays outside the free builder's budget: Pro, or credits someone bought. */
export const paidWallet = (w: Wallet): boolean => w.plan === 'pro' || w.topup > 0 || w.bonus > 0;

/** What the plans and the viewer's credits look like, for the page (GET /api/billing). */
export function billingInfo(w: Wallet | null, cfg: PlansConfig = plansConfig(), now: Date = new Date(), payments: boolean = paymentsOn()): BillingInfo {
  const plan = w?.plan ?? 'guest';
  const monthly = w?.monthly ?? allowanceOf(plan, cfg);
  return {
    plan,
    credits: {
      left: Math.round((w?.left ?? monthly) * 100) / 100,
      monthly,
      used: Math.round((w?.usedMonthly ?? 0) * 100) / 100,
      topup: Math.round((w?.topup ?? 0) * 100) / 100,
      bonus: Math.round((w?.bonus ?? 0) * 100) / 100,
      periodEnd: w?.periodEnd ?? monthOf(now).end.toISOString(),
      cancelAt: w?.cancelAt ?? null,
      pastDue: w?.status === 'past_due',
    },
    payments,
    manage: !!w?.stripeCustomer && paymentsOn(),
    earnings: w && w.payer.startsWith('u:') ? { credits: Math.round(w.earned * 100) / 100, total: Math.round(w.earnedTotal * 100) / 100 } : null,
    plans: { free: cfg.free, pro: cfg.pro, topups: cfg.topups, typicalBuild: TYPICAL_BUILD_CREDITS, shopShare: shopShare() },
  };
}

/** The billing answer for a payer, with their payouts in it (GET /api/billing and the earnings routes). */
export async function billingView(db: Db, wallet: Wallet | null, payer: string, cfg: PlansConfig, req: Request): Promise<BillingInfo> {
  return withPayouts(db, billingInfo(wallet, cfg, new Date(), await paymentsForPayer(db, payer)), payer, req);
}

// -- Stripe objects → wallets -----------------------------------------------------------------------

type Ref = string | { id?: string } | null | undefined;
const idOf = (v: Ref): string | null => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.id === 'string' ? v.id : null);

interface StripeSubscription {
  id: string;
  status: string;
  customer: Ref;
  metadata?: Record<string, string>;
  current_period_start?: number;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  cancel_at?: number | null;
  items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> };
}

interface CheckoutSession {
  id: string;
  mode: string;
  payment_intent?: Ref;
  status?: string;
  payment_status?: string;
  client_reference_id?: string | null;
  customer?: Ref;
  subscription?: Ref;
  metadata?: Record<string, string>;
}

const getSubscription = (id: string) => stripe<StripeSubscription>('GET', `/v1/subscriptions/${encodeURIComponent(id)}`);

/** The Orb account behind a Stripe object: the id it names, else its customer's; only one that exists. */
async function accountFor(db: Db, userId: string | null | undefined, customer: string | null): Promise<string | null> {
  let id = userId || null;
  if (!id && customer) id = userOfPayer((await walletOfCustomer(db, customer))?.payer ?? '');
  return id && (await db.query(`select 1 from orb_users where id = $1`, [id])).length ? id : null;
}

/**
 * The account's plan as its subscription says: active (or retrying a payment) is Pro for the
 * subscription's period; anything else ends Pro. Null if the subscription is no account's.
 */
export async function applySubscription(db: Db, sub: StripeSubscription, cfg: PlansConfig = plansConfig(), userHint: string | null = null): Promise<Wallet | null> {
  const customer = idOf(sub.customer);
  const userId = await accountFor(db, sub.metadata?.orb_user || userHint, customer);
  if (!userId) {
    console.error('[orb] a Stripe subscription that belongs to no Orb account', sub.id);
    return null;
  }
  const payer = `u:${userId}`;
  const item = sub.items?.data?.[0];
  const start = item?.current_period_start ?? sub.current_period_start;
  const end = item?.current_period_end ?? sub.current_period_end;
  if (['active', 'trialing', 'past_due'].includes(sub.status) && start && end) {
    const cancelAt = sub.cancel_at_period_end ? end : (sub.cancel_at ?? null);
    return setProPeriod(db, payer, {
      start: new Date(start * 1000),
      end: new Date(end * 1000),
      credits: cfg.pro.credits,
      customer,
      subscription: sub.id,
      status: sub.status,
      cancelAt: cancelAt ? new Date(cancelAt * 1000) : null,
    });
  }
  const w = await readWallet(db, payer);
  if (w?.plan === 'pro' && w.stripeSubscription === sub.id) return endPro(db, payer, sub.status, cfg);
  if (customer) await setCustomer(db, payer, customer, cfg);
  return w;
}

export interface Applied {
  kind: 'pro' | 'topup' | null;
  /** The plan or the credits are in the account now. */
  done: boolean;
}

/** A finished checkout: Pro starts, or the bought credits are added (once). */
export async function applyCheckoutSession(db: Db, session: CheckoutSession, cfg: PlansConfig = plansConfig()): Promise<Applied> {
  const userId = await accountFor(db, session.client_reference_id || session.metadata?.orb_user, null);
  if (!userId) return { kind: null, done: false };
  const payer = `u:${userId}`;
  const customer = idOf(session.customer);
  if (session.mode === 'subscription') {
    const subId = idOf(session.subscription);
    if (session.status !== 'complete' || !subId) return { kind: 'pro', done: false };
    const w = await applySubscription(db, await getSubscription(subId), cfg, userId);
    await rememberCardOf(db, payer, () => stripe<{ default_payment_method?: { card?: { fingerprint?: string } } | string | null }>('GET', `/v1/subscriptions/${encodeURIComponent(subId)}`, { expand: ['default_payment_method'] }).then((s) => (typeof s.default_payment_method === 'object' ? s.default_payment_method?.card?.fingerprint : null)));
    return { kind: 'pro', done: w?.plan === 'pro' };
  }
  if (session.mode === 'payment' && session.metadata?.kind === 'topup') {
    const credits = Number(session.metadata.credits);
    if (session.payment_status !== 'paid' || !Number.isFinite(credits) || credits <= 0 || credits > 1_000_000) return { kind: 'topup', done: false };
    if (customer) await setCustomer(db, payer, customer, cfg);
    await grantTopup(db, payer, credits, session.id, cfg);
    const pi = idOf(session.payment_intent);
    if (pi) await rememberCardOf(db, payer, () => stripe<PaymentIntent>('GET', `/v1/payment_intents/${encodeURIComponent(pi)}`, { expand: ['latest_charge'] }).then((p) => (typeof p.latest_charge === 'object' ? p.latest_charge?.payment_method_details?.card?.fingerprint : null)));
    return { kind: 'topup', done: true };
  }
  return { kind: null, done: false };
}

/** The card a payment was made with, remembered to tell a maker's own accounts apart (./payouts.ts). Best effort. */
async function rememberCardOf(db: Db, payer: string, read: () => Promise<string | null | undefined>): Promise<void> {
  try {
    await rememberCard(db, payer, await read());
  } catch (e) {
    console.error('[orb] reading a payment’s card failed', e instanceof Error ? e.message : e);
  }
}

interface Charge {
  id: string;
  amount?: number;
  amount_refunded?: number;
  refunded?: boolean;
  disputed?: boolean;
  customer?: Ref;
  payment_intent?: PaymentIntent | string | null;
  payment_method_details?: { card?: { fingerprint?: string } };
}
interface PaymentIntent {
  id: string;
  metadata?: Record<string, string>;
  latest_charge?: Charge | string | null;
}

/**
 * A payment was refunded or disputed (the charge as Stripe has it now): the credits it bought are
 * taken back (a pack's, in proportion; the balance may go below zero), and its payer is flagged and
 * what their purchases in worlds earned makers is reversed (./payouts.ts).
 */
export async function applyChargeTrouble(db: Db, chargeId: string, why: 'refund' | 'dispute'): Promise<void> {
  const charge = await stripe<Charge>('GET', `/v1/charges/${encodeURIComponent(chargeId)}`, { expand: ['payment_intent'] });
  if (why === 'refund' && !(charge.amount_refunded && charge.amount_refunded > 0)) return;
  if (why === 'dispute' && !charge.disputed) return;
  const pi = typeof charge.payment_intent === 'object' ? charge.payment_intent : null;
  const userId = await accountFor(db, pi?.metadata?.orb_user, idOf(charge.customer));
  if (!userId) return;
  const payer = `u:${userId}`;
  const credits = Number(pi?.metadata?.credits);
  if (pi?.metadata?.kind === 'topup' && credits > 0 && charge.amount) {
    const share = why === 'dispute' ? 1 : Math.min(1, (charge.amount_refunded ?? 0) / charge.amount);
    await db.query(
      `with logged as (
         insert into orb_credit_log (payer, kind, micros, ref) values ($1, 'topup_back', $2::bigint, $3)
         on conflict (kind, ref) where ref is not null do nothing returning micros
       )
       update orb_wallets set topup_micros = topup_micros - (select micros from logged), updated_at = now() where payer = $1 and exists (select 1 from logged)`,
      [payer, Math.round(toMicros(credits) * share), charge.id],
    );
  }
  const reversed = await reverseBuyer(db, userId, `${why} ${charge.id}`);
  console.error(`[orb] a ${why} of ${charge.id}: flagged its payer, reversed ${reversed} credits of makers' earnings`);
}

export async function applyCheckoutById(db: Db, sessionId: string, cfg: PlansConfig = plansConfig()): Promise<Applied> {
  return applyCheckoutSession(db, await stripe<CheckoutSession>('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`), cfg);
}

/** What Stripe itself has under this id, or null when it has nothing (a made-up id). */
async function fromStripe<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) return null;
    throw e;
  }
}

/**
 * A webhook event from Stripe (signature already checked). Its checkout or subscription is read
 * back from Stripe, so events may come in any order — and an event can only say what to look at:
 * even one signed with a leaked secret grants nothing that Stripe doesn't have.
 */
export async function handleStripeEvent(db: Db, event: { type?: string; data?: { object?: Record<string, unknown> } }, cfg: PlansConfig = plansConfig()): Promise<void> {
  const obj = (event.data?.object ?? {}) as Record<string, unknown>;
  const id = typeof obj.id === 'string' && obj.id ? obj.id : null;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (id) await fromStripe(() => applyCheckoutById(db, id, cfg));
      return;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = id ? await fromStripe(() => getSubscription(id)) : null;
      if (sub) await applySubscription(db, sub, cfg);
      return;
    }
    case 'charge.refunded':
      if (id) await fromStripe(() => applyChargeTrouble(db, id, 'refund'));
      return;
    case 'charge.dispute.created': {
      const charge = idOf(obj.charge as Ref);
      // The dispute as Stripe has it, then its charge.
      const dispute = id ? await fromStripe(() => stripe<{ charge?: Ref }>('GET', `/v1/disputes/${encodeURIComponent(id)}`)) : null;
      const chargeId = idOf(dispute?.charge);
      if (chargeId && (!charge || charge === chargeId)) await fromStripe(() => applyChargeTrouble(db, chargeId, 'dispute'));
      return;
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const parent = obj.parent as { subscription_details?: { subscription?: Ref } } | undefined;
      const subId = idOf(obj.subscription as Ref) ?? idOf(parent?.subscription_details?.subscription);
      if (subId) await applySubscription(db, await getSubscription(subId), cfg);
      return;
    }
  }
}

// -- checkouts and the portal -----------------------------------------------------------------------

export type CheckoutItem = { kind: 'pro' } | { kind: 'topup'; pack: CreditPack };

export interface CheckoutUrls {
  /** Where Stripe sends people after paying ({CHECKOUT_SESSION_ID} is filled in). */
  success: string;
  cancel: string;
}

/** Stripe doesn't know this customer: one of another Stripe account's (Orb's key changed since). */
export const missingCustomer = (e: unknown): boolean => e instanceof StripeError && e.code === 'resource_missing' && e.param === 'customer';

/** Forget a customer Stripe doesn't know, so the account starts afresh with this Stripe account. */
export async function forgetCustomer(db: Db, payer: string, customer: string): Promise<void> {
  await db.query(`update orb_wallets set stripe_customer = null, updated_at = now() where payer = $1 and stripe_customer = $2`, [payer, customer]);
}

/** A Stripe Checkout page for Pro or a credit pack; its address. */
export async function createCheckout(db: Db, w: Wallet, item: CheckoutItem, urls: CheckoutUrls, cfg: PlansConfig = plansConfig()): Promise<string> {
  const userId = userOfPayer(w.payer);
  if (!userId) throw new StripeError(400, 'Checkouts need an account.');
  await ensureWebhook(db, webhookUrl()).catch((e) => console.error('[orb] Stripe webhook setup failed', e));
  const open = async (customer: string | null) => {
    const common = { client_reference_id: userId, success_url: urls.success, cancel_url: urls.cancel, ...(customer ? { customer } : {}) };
    return item.kind === 'pro'
      ? stripe<{ id: string; url?: string }>('POST', '/v1/checkout/sessions', {
          ...common,
          mode: 'subscription',
          line_items: [{ price: await proPrice(cfg.pro.usd), quantity: 1 }],
          subscription_data: { metadata: { orb_user: userId } },
          metadata: { orb_user: userId, kind: 'pro' },
        })
      : stripe<{ id: string; url?: string }>('POST', '/v1/checkout/sessions', {
          ...common,
          mode: 'payment',
          ...(customer ? {} : { customer_creation: 'always' }),
          line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: Math.round(item.pack.usd * 100), product_data: { name: `${item.pack.credits.toLocaleString('en-US')} Orb credits` } } }],
          metadata: { orb_user: userId, kind: 'topup', credits: String(item.pack.credits), pack: item.pack.id },
          payment_intent_data: { metadata: { orb_user: userId, kind: 'topup', credits: String(item.pack.credits) } },
        });
  };
  let session: { id: string; url?: string };
  try {
    session = await open(w.stripeCustomer);
  } catch (e) {
    if (!w.stripeCustomer || !missingCustomer(e)) throw e;
    await forgetCustomer(db, w.payer, w.stripeCustomer);
    session = await open(null);
  }
  if (!session.url) throw new StripeError(502, 'Stripe returned no checkout page.');
  return session.url;
}

export interface StripeStatus {
  /** A live key (real cards), not a sandbox's. */
  live: boolean;
  /** The Stripe account the key reaches: what Checkout and card statements show. */
  account: { id: string; name: string | null; descriptor: string | null; country: string | null; currency: string | null; charges: boolean; payouts: boolean; due: string[] } | null;
  price: string | null;
  portal: string | null;
  /** Where Stripe sends events: Orb's registered endpoint, or "STRIPE_WEBHOOK_SECRET" when one is set by hand. */
  webhook: string | null;
  /** Makers' cash payouts are open: the account has Stripe Connect (./payouts.ts). */
  connect: boolean;
  problems: string[];
}

interface StripeAccount {
  id: string;
  country?: string;
  default_currency?: string;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  business_profile?: { name?: string | null };
  settings?: { payments?: { statement_descriptor?: string | null }; dashboard?: { display_name?: string | null } };
  requirements?: { currently_due?: string[] };
}

/**
 * What Orb's Stripe key reaches, with everything a first checkout sets up made now: the Pro
 * price, the portal's settings and (from the production deployment) the webhook endpoint. For
 * checking a new key (POST /api/admin/stripe). What doesn't work is listed, not thrown.
 */
export async function stripeSetup(db: Db, cfg: PlansConfig = plansConfig()): Promise<StripeStatus> {
  const problems: string[] = [];
  const out: StripeStatus = { live: paymentsOn() && !stripeTestMode(), account: null, price: null, portal: null, webhook: null, connect: false, problems };
  if (!paymentsOn()) {
    problems.push('No Stripe key is set (ORB_STRIPE_SECRET_KEY or STRIPE_SECRET_KEY).');
    return out;
  }
  const step = async <T>(what: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (e) {
      problems.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  const a = await step('account', () => stripe<StripeAccount>('GET', '/v1/account'));
  if (a) {
    out.account = {
      id: a.id,
      name: a.business_profile?.name ?? a.settings?.dashboard?.display_name ?? null,
      descriptor: a.settings?.payments?.statement_descriptor ?? null,
      country: a.country ?? null,
      currency: a.default_currency ?? null,
      charges: a.charges_enabled === true,
      payouts: a.payouts_enabled === true,
      due: a.requirements?.currently_due ?? [],
    };
    if (!out.account.charges) problems.push('The Stripe account can’t take payments yet (charges are off): finish its setup in Stripe.');
  }
  out.price = await step('Pro price', () => proPrice(cfg.pro.usd));
  out.portal = await step('portal settings', () => portalConfiguration(db));
  if (!out.portal) problems.push('portal settings: couldn’t be made (the account’s own default portal settings apply).');
  if (envSecret()) out.webhook = 'STRIPE_WEBHOOK_SECRET';
  else {
    const webhook = webhookUrl();
    await step('webhook', () => ensureWebhook(db, webhook));
    out.webhook = await registeredWebhook(db);
    if (!out.webhook) problems.push(webhook ? 'webhook: couldn’t be registered (see the logs)' : 'webhook: only the production deployment registers one');
  }
  out.connect = await connectReady();
  if (!out.connect) problems.push('payouts: closed — the Stripe account has no Connect yet (Stripe dashboard → Connect), or ORB_PAYOUTS=0.');
  return out;
}

/** Stripe's customer portal for the account (cancel, card, invoices); its address. */
export async function createPortal(db: Db, customer: string, returnUrl: string): Promise<string> {
  const configuration = await portalConfiguration(db);
  const session = await stripe<{ url?: string }>('POST', '/v1/billing_portal/sessions', { customer, return_url: returnUrl, ...(configuration ? { configuration } : {}) });
  if (!session.url) throw new StripeError(502, 'Stripe returned no portal page.');
  return session.url;
}
