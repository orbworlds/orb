// Problems worth a look, kept in orb_errors for the pulse page (/lab/<key>/pulse) and sent to a chat
// when ORB_ALERT_WEBHOOK is set (a Slack or Discord incoming-webhook URL; production only):
// - page: a crash in one of Orb's own pages, reported by the browser (POST /api/errors);
// - server: an unexpected error in a route or a page render;
// - builder: the free builder can't build for anyone (the AI provider refused: billing, budget).
// Repeats of a problem count up in its row; each problem alerts at most once an hour.

import { createHash } from 'node:crypto';
import { after } from 'next/server';
import { SITE } from '@/lib/site';
import type { Db } from './db';
import { LAB_KEY } from './lab';
import { rateLimit } from './ratelimit';
import { ready } from './schema';

export type ErrorKind = 'page' | 'server' | 'builder';

export interface ErrorReport {
  kind: ErrorKind;
  message: string;
  stack?: string | null;
  /** Anything else worth keeping (e.g. the browser), stored after the stack. */
  context?: string | null;
  /** Page or API path, without the query string. */
  path?: string | null;
}

const MAX = { message: 500, detail: 4000, path: 200 };
/**
 * Alerts per hour. Page crashes are reported by anyone's browser, so they get their own small
 * budget: they can never use up the one the server's own problems (and builder outages) alert from.
 */
const ALERT_BUDGET: Record<ErrorKind, [key: string, perHour: number]> = {
  page: ['alerts:page', 5],
  server: ['alerts:server', 30],
  builder: ['alerts:server', 30],
};

const clip = (s: string | null | undefined, n: number) => (s ?? '').trim().slice(0, n);

/** One row per problem: its kind and message, digits blanked (ids, sizes and counts vary). */
export function errorKey(kind: ErrorKind, message: string): string {
  return createHash('sha1').update(`${kind}\n${message.replace(/\d+/g, '#')}`).digest('hex').slice(0, 32);
}

export async function recordError(db: Db, r: ErrorReport): Promise<void> {
  const message = clip(r.message, MAX.message) || 'Unknown error';
  const detail = clip([r.stack, r.context].filter(Boolean).join('\n\n'), MAX.detail) || null;
  const path = clip(r.path, MAX.path) || null;
  const key = errorKey(r.kind, message);
  await db.query(
    `insert into orb_errors as e (key, kind, message, detail, path) values ($1, $2, $3, $4, $5)
     on conflict (key) do update set count = e.count + 1, last_at = now(),
       detail = coalesce(excluded.detail, e.detail), path = coalesce(excluded.path, e.path)`,
    [key, r.kind, message, detail, path],
  );
  if (Math.random() < 0.02) await db.query(`delete from orb_errors where last_at < now() - interval '30 days'`);
  if (!alertsOn()) return;
  const due = await db.query<{ count: number }>(
    `update orb_errors set alerted_at = now()
     where key = $1 and (alerted_at is null or alerted_at < now() - interval '1 hour') returning count`,
    [key],
  );
  if (!due[0]) return;
  const [budget, perHour] = ALERT_BUDGET[r.kind];
  if (!(await rateLimit(db, budget, perHour, 3600)).ok) {
    // Not sent: the next occurrence may alert once the budget allows.
    await db.query(`update orb_errors set alerted_at = null where key = $1`, [key]);
    return;
  }
  await later(() => sendAlert(r.kind, message, path, Number(due[0].count)));
}

let lastOfflineAlert = 0;

/** An unexpected server error. Never throws; if the database is the problem, alerts directly. */
export async function recordServerError(e: unknown, path?: string): Promise<void> {
  const err = e instanceof Error ? e : new Error(String(e));
  try {
    await recordError(await ready(), { kind: 'server', message: `${err.name}: ${err.message}`, stack: err.stack, path });
  } catch (x) {
    console.error('[orb] recording an error failed', x);
    // Nowhere to count it: at most one alert per server instance every 10 minutes.
    if (alertsOn() && Date.now() - lastOfflineAlert > 10 * 60_000) {
      lastOfflineAlert = Date.now();
      await sendAlert('server', `Problems can't be recorded, so the database may be down: ${String((x as Error)?.message ?? x)}`, path ?? null, 1);
    }
  }
}

function webhook(): string {
  return (process.env.ORB_ALERT_WEBHOOK ?? '').trim();
}

/** Alerts come from production only (not previews or local runs that share the variable). */
function alertsOn(): boolean {
  return !!webhook() && (!process.env.VERCEL || process.env.VERCEL_ENV === 'production');
}

/** After the response when there is one (a webhook can take seconds), else right away. */
async function later(task: () => Promise<void>): Promise<void> {
  try {
    after(task);
  } catch {
    await task();
  }
}

/** Untrusted text in a chat message: one line, no markup or mentions, shown as code. */
function quote(s: string, slack: boolean): string {
  const line = s.replace(/\s+/g, ' ').replace(/`/g, "'").trim().slice(0, 300);
  return `\`${slack ? line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : line}\``;
}

async function sendAlert(kind: ErrorKind, message: string, path: string | null, count: number): Promise<void> {
  const url = webhook();
  const discord = /^https:\/\/([\w-]+\.)?discord(app)?\.com\//.test(url);
  const q = (s: string) => quote(s, !discord);
  const times = count > 1 ? ` (${count} times so far)` : '';
  const head =
    kind === 'builder'
      ? `Orb: the free builder is down — ${q(message)}`
      : kind === 'page'
        ? `Orb: a page crashed${path ? ` on ${q(path)}` : ''}${times} — ${q(message)}`
        : `Orb: server error${path ? ` in ${q(path)}` : ''}${times} — ${q(message)}`;
  const text = LAB_KEY ? `${head}\n${SITE}/lab/${LAB_KEY}/pulse` : head;
  // Discord takes `content` (and must not ping anyone); Slack and most others take `text`.
  const body = discord ? { content: text, allowed_mentions: { parse: [] } } : { text };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!res.ok) console.error('[orb] alert webhook answered', res.status);
  } catch (e) {
    console.error('[orb] alert webhook failed', e);
  }
}
