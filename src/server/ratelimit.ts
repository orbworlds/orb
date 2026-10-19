// Fixed-window rate limiting in Postgres (orb_rate).
//
// One row per key: { window_start, count }. Every hit is a single atomic upsert that either
// starts a fresh window (first hit, or the previous window has expired) or increments the
// counter of the current one, so concurrent requests can never both slip past the limit.
// Stale rows are swept occasionally (see `maybeCleanup`). Other one-shot markers that live in
// orb_rate (e.g. per-day play dedupe keys in ./worlds) are swept by the same cleanup.

import type { Db } from './db';

export interface RateResult {
  ok: boolean;
  remaining: number;
  /** Seconds until the window resets (0 if ok). */
  retryAfter: number;
}

/** Longest supported window (rows idle for longer than STALE_AFTER are deleted by cleanup). */
const MAX_WINDOW_SEC = 2 * 86400;
const STALE_AFTER = '3 days';
const CLEANUP_EVERY_MS = 15 * 60_000;
const CLEANUP_BATCH = 5000;

let lastCleanup = 0;

/**
 * Count one hit for `key` (weighing `cost` units, default 1); allow at most `limit` units per
 * `windowSec`. Atomic.
 */
export async function rateLimit(db: Db, key: string, limit: number, windowSec: number, cost = 1): Promise<RateResult> {
  const max = Math.max(0, Math.floor(limit));
  const win = Math.min(MAX_WINDOW_SEC, Math.max(1, Math.ceil(windowSec)));
  const units = Math.min(max + 1, Math.max(1, Math.floor(cost) || 1));
  // All SET expressions see the *old* row, so the rollover test is identical in both branches.
  // The counter is capped at limit+1: we only need to know "over the limit", and capping keeps a
  // hammered key from ever overflowing the integer column.
  const rows = await db.query<{ count: number; reset_in: number }>(
    `insert into orb_rate as r (key, window_start, count) values ($1, now(), $4::int)
     on conflict (key) do update set
       window_start = case when r.window_start <= now() - $2::int * interval '1 second' then now() else r.window_start end,
       count = case when r.window_start <= now() - $2::int * interval '1 second' then $4::int else least(r.count + $4::int, $3::int + 1) end
     returning count, extract(epoch from (window_start + $2::int * interval '1 second' - now()))::float8 as reset_in`,
    [key, win, max, units],
  );
  await maybeCleanup(db);
  const count = Number(rows[0]?.count ?? 1);
  const ok = count <= max;
  return {
    ok,
    remaining: Math.max(0, max - count),
    retryAfter: ok ? 0 : Math.max(1, Math.ceil(Number(rows[0]?.reset_in ?? win))),
  };
}

/** Whether one more hit for `key` would stay within `limit`, without counting it (rateLimit() counts). */
export async function underLimit(db: Db, key: string, limit: number, windowSec: number): Promise<boolean> {
  const win = Math.min(MAX_WINDOW_SEC, Math.max(1, Math.ceil(windowSec)));
  const rows = await db.query<{ count: number }>(`select count from orb_rate where key = $1 and window_start > now() - $2::int * interval '1 second'`, [key, win]);
  return Number(rows[0]?.count ?? 0) < Math.max(0, Math.floor(limit));
}

/**
 * Give back `cost` units that rateLimit() counted for `key`, for work that never happened (e.g. the
 * AI failed before answering). Never goes below zero.
 */
export async function refundRate(db: Db, key: string, cost = 1): Promise<void> {
  const units = Math.max(1, Math.floor(cost) || 1);
  await db.query(`update orb_rate set count = greatest(0, count - $2::int) where key = $1`, [key, units]);
}

/**
 * Best-effort sweep of rows whose window ended long ago. Runs at most once per process every
 * CLEANUP_EVERY_MS, and only on a fraction of eligible calls so a fleet of fresh serverless
 * instances doesn't sweep in lockstep. Bounded per run; failures are logged and ignored.
 */
async function maybeCleanup(db: Db): Promise<void> {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_EVERY_MS || Math.random() > 0.1) return;
  lastCleanup = now;
  try {
    await db.query(
      `delete from orb_rate where ctid in (
         select ctid from orb_rate where window_start < now() - interval '${STALE_AFTER}' limit ${CLEANUP_BATCH}
       )`,
    );
  } catch (e) {
    console.warn('[orb] rate-limit cleanup failed', e);
  }
}
