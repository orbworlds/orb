// Product analytics events (orb_events): sent in batches by Orb's pages (src/lib/analytics.ts →
// POST /api/events), read by the analytics page (./analytics). A batch holds at most 50 events;
// each needs a snake_case name and the tab's visit (session) id. Props are a flat object of
// strings, numbers, booleans and nulls, 2 KB at most; paths keep no query string or fragment
// (prompts and sign-in tokens ride there), and events from the secret pages (/lab, /dev) are
// dropped. When an event happened comes from the server's clock: the client only says how long
// before sending the batch. Rows older than 180 days are swept now and then.

import type { Db } from './db';

export type PropValue = string | number | boolean | null;

export interface EventRow {
  name: string;
  /** Milliseconds between the event and the batch being sent. */
  ago: number;
  session: string;
  path: string | null;
  world_id: string | null;
  props: Record<string, PropValue> | null;
  referrer: string | null;
}

export interface EventBatch {
  rows: EventRow[];
  /** Events dropped as malformed. */
  rejected: number;
  /** The device key, when sent with navigator.sendBeacon (which can't set the x-orb-device header). */
  device: string | null;
  mobile: boolean | null;
}

/** Who sent a batch: the device (hashed), the account, and what the request says about them. */
export interface EventSource {
  deviceHash: string;
  userId: string | null;
  country: string | null;
  mobile: boolean | null;
}

export const MAX_BATCH = 50;
export const MAX_PROPS_BYTES = 2048;
export const MAX_BODY_BYTES = 128_000;
const MAX_KEYS = 24;
const MAX_AGO_MS = 10 * 60_000;
const KEEP = '180 days';
const NAME = /^[a-z][a-z0-9_]{1,39}$/;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION = /^[A-Za-z0-9_-]{6,40}$/;
const SECRET = /^\/(lab|dev)(\/|$)/;
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed/i;
const MOBILE = /Mobi|Android|iPhone|iPad|iPod/i;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Crawlers that run scripts, and headless browsers (tests, monitors). */
export const isBot = (userAgent: string | null): boolean => !!userAgent && BOT.test(userAgent);

/** Phone or tablet, from the browser's own word or else its user agent. */
export function isMobile(claimed: boolean | null, userAgent: string | null): boolean | null {
  return claimed ?? (userAgent ? MOBILE.test(userAgent) : null);
}

/** A batch from the browser, or null when it isn't one (malformed, or more than 50 events). */
export function parseBatch(body: unknown): EventBatch | null {
  if (!isObject(body) || !Array.isArray(body.events) || body.events.length > MAX_BATCH) return null;
  const sent = typeof body.sent === 'number' && Number.isFinite(body.sent) ? body.sent : null;
  const rows: EventRow[] = [];
  for (const e of body.events) {
    const row = parseEvent(e, sent);
    if (row) rows.push(row);
  }
  return {
    rows,
    rejected: body.events.length - rows.length,
    device: typeof body.device === 'string' ? body.device : null,
    mobile: typeof body.mobile === 'boolean' ? body.mobile : null,
  };
}

function parseEvent(e: unknown, sent: number | null): EventRow | null {
  if (!isObject(e) || typeof e.name !== 'string' || !NAME.test(e.name)) return null;
  if (typeof e.session !== 'string' || !SESSION.test(e.session)) return null;
  const path = e.path == null ? null : cleanPath(e.path);
  const props = e.props == null ? null : cleanProps(e.props);
  if (path === undefined || props === undefined) return null;
  const t = typeof e.t === 'number' && Number.isFinite(e.t) ? e.t : null;
  return {
    name: e.name,
    ago: sent !== null && t !== null ? Math.round(Math.min(MAX_AGO_MS, Math.max(0, sent - t))) : 0,
    session: e.session,
    path,
    world_id: typeof e.world === 'string' && ID.test(e.world) ? e.world : null,
    props,
    referrer: cleanReferrer(e.ref),
  };
}

/** The pathname alone; undefined (drop the event) when it isn't a path or is a secret page. */
function cleanPath(v: unknown): string | null | undefined {
  if (typeof v !== 'string' || !v.startsWith('/')) return undefined;
  try {
    const path = new URL(v, 'http://orb').pathname.slice(0, 200);
    return SECRET.test(path) ? undefined : path;
  } catch {
    return undefined;
  }
}

function cleanProps(v: unknown): Record<string, PropValue> | null | undefined {
  if (!isObject(v)) return undefined;
  const entries = Object.entries(v);
  if (entries.length > MAX_KEYS) return undefined;
  for (const [k, x] of entries) {
    if (!KEY.test(k)) return undefined;
    if (!(x === null || typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)))) return undefined;
  }
  if (Buffer.byteLength(JSON.stringify(v)) > MAX_PROPS_BYTES) return undefined;
  return entries.length ? (v as Record<string, PropValue>) : null;
}

/** Another site's address, without its query string or fragment. */
function cleanReferrer(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    const u = new URL(v);
    return u.host ? `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300) : null;
  } catch {
    return null;
  }
}

export async function recordEvents(db: Db, src: EventSource, rows: EventRow[]): Promise<void> {
  if (!rows.length) return;
  await db.query(
    `insert into orb_events (at, name, device, user_id, session, path, world_id, props, referrer, country, mobile)
     select now() - x.ago * interval '1 millisecond', x.name, $2::text, $3::text, x.session, x.path, x.world_id, x.props, x.referrer, $4::text, $5::boolean
     from jsonb_to_recordset($1::jsonb) as x(ago integer, name text, session text, path text, world_id text, props jsonb, referrer text)`,
    [JSON.stringify(rows), src.deviceHash, src.userId, src.country, src.mobile],
  );
  if (Math.random() < 0.01) {
    await db.query(`delete from orb_events where id in (select id from orb_events where at < now() - interval '${KEEP}' limit 5000)`);
  }
}
