// Cost guards for Orb's free builder (POST /api/agent/jobs without the person's own AI key),
// counted in build units (1 per started 100k characters of input, so they bound tokens,
// not just requests). Like chatgpt.com, each person has limits of their own:
// - Signed in: a short burst limit, an hourly quota and a daily one per account (an IP full of
//   accounts — a home, a school — gets several times an IP's anonymous share).
// - Without an account: the same per device and per IP (device keys are free to mint, so the IP
//   quotas are the backstop).
// - Paying for their credits (Pro, top-ups): only the burst and an hourly limit.
// How much each person builds in a month is their credits (./credits.ts); these quotas guard
// against abuse. What all free builds together may cost in a day is the budget in US dollars
// (./budget.ts).
// Daily windows end at UTC midnight. Pure module (no imports), unit-tested in
// src/lib/engine/__tests__/freetier.test.mjs.

export interface FreeTierConfig {
  /** Build units per UTC day per device, without an account (ORB_FREE_DAILY_PER_DEVICE). */
  perDeviceDay: number;
  /** Build units per UTC day per IP address without an account (ORB_FREE_DAILY_PER_IP). */
  perIpDay: number;
  /** Build units per UTC day per account (ORB_FREE_DAILY_PER_ACCOUNT). */
  perAccountDay: number;
  /** Longest reply one free build may generate (ORB_FREE_MAX_OUTPUT_TOKENS). */
  maxOutputTokens: number;
}

export const FREE_TIER_DEFAULTS: FreeTierConfig = { perDeviceDay: 12, perIpDay: 40, perAccountDay: 30, maxOutputTokens: 12_000 };

/**
 * When the free builder runs on Orb's own Cursor key (src/server/ai.ts), each build is a Cursor
 * agent that may work for minutes: fewer of them a day (one build is one unit).
 */
export const CURSOR_FREE_TIER_DEFAULTS: FreeTierConfig = { perDeviceDay: 10, perIpDay: 25, perAccountDay: 25, maxOutputTokens: 12_000 };

/** An IP's daily share with accounts, as a multiple of its share without (homes and schools share an IP). */
const SIGNED_IN_IP_SHARE = 3;

/** The mock AI costs nothing, so it has no daily caps unless they are set explicitly. */
const UNCAPPED = 1_000_000;

function intEnv(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number): number {
  const raw = (env[key] ?? '').trim();
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function freeTierConfig(env: Record<string, string | undefined> = process.env, mock = false, cursor = false): FreeTierConfig {
  const defaults = cursor ? CURSOR_FREE_TIER_DEFAULTS : FREE_TIER_DEFAULTS;
  const day = (fallback: number) => (mock ? UNCAPPED : fallback);
  return {
    perDeviceDay: intEnv(env, 'ORB_FREE_DAILY_PER_DEVICE', day(defaults.perDeviceDay), 1, UNCAPPED),
    perIpDay: intEnv(env, 'ORB_FREE_DAILY_PER_IP', day(defaults.perIpDay), 1, UNCAPPED),
    perAccountDay: intEnv(env, 'ORB_FREE_DAILY_PER_ACCOUNT', day(defaults.perAccountDay), 1, UNCAPPED),
    maxOutputTokens: intEnv(env, 'ORB_FREE_MAX_OUTPUT_TOKENS', defaults.maxOutputTokens, 2_000, 32_000),
  };
}

// ---------------------------------------------------------------------------------------------
// Quotas

export interface LimitCheck {
  key: string;
  limit: number;
  windowSec: number;
  /** Build units this request counts for; checks without a cost count 1 and are never refunded. */
  cost?: number;
  /** The window ends at UTC midnight (Retry-After never points past it). */
  daily?: boolean;
  message: string;
}

const BURST = 'Whoa, speedy! Give Orb a few seconds between builds.';
const HOURLY = "You've built a lot this hour! Take a little break — or add your own AI key in You → Model to keep going.";
const ACCOUNT_DAY = "That's all the free building for today — come back tomorrow for more! Or add your own AI key in You → Model to keep going.";
const DEVICE_DAY = "That's all the free building without an account for today — sign in (You → Account) for more, or come back tomorrow!";

export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

export function secondsUntilUtcMidnight(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

interface Builder {
  deviceHash: string | null;
  ip: string;
  /** The signed-in account, if any: its own quotas instead of the device's. */
  userId?: string | null;
}

/** Builds an hour for someone who pays for their credits (Pro, or top-ups): an abuse limit only. */
const PAID_HOURLY = 120;

/**
 * The quotas one free build is checked against, in order. Someone paying for their credits (`paid`)
 * only has the burst and hourly limits: their credits are the daily limit.
 */
export function freeTierChecks(who: Builder, cost: number, cfg: FreeTierConfig, now: Date = new Date(), paid = false): LimitCheck[] {
  const day = utcDay(now);
  const { deviceHash, ip, userId } = who;
  if (userId && paid) {
    return [
      { key: `build:burst:u:${userId}`, limit: 4, windowSec: 20, message: BURST },
      { key: `build:paid:u:${userId}`, limit: PAID_HOURLY, windowSec: 3600, cost, message: HOURLY },
    ];
  }
  if (userId) {
    return [
      { key: `build:burst:u:${userId}`, limit: 4, windowSec: 20, message: BURST },
      { key: `build:userday:${userId}:${day}`, limit: cfg.perAccountDay, windowSec: 86400, cost, daily: true, message: ACCOUNT_DAY },
      { key: `build:ipday:${ip}:${day}`, limit: cfg.perIpDay * SIGNED_IN_IP_SHARE, windowSec: 86400, cost, daily: true, message: ACCOUNT_DAY },
      { key: `build:ip:${ip}`, limit: 40, windowSec: 3600, cost, message: HOURLY },
      { key: `build:user:${userId}`, limit: 40, windowSec: 3600, cost, message: HOURLY },
    ];
  }
  const device = (check: LimitCheck): LimitCheck[] => (deviceHash ? [check] : []);
  return [
    { key: `build:burst:${deviceHash ?? `ip:${ip}`}`, limit: 4, windowSec: 20, message: BURST },
    ...device({ key: `build:devday:${deviceHash}:${day}`, limit: cfg.perDeviceDay, windowSec: 86400, cost, daily: true, message: DEVICE_DAY }),
    { key: `build:ipday:${ip}:${day}`, limit: cfg.perIpDay, windowSec: 86400, cost, daily: true, message: DEVICE_DAY },
    { key: `build:ip:${ip}`, limit: 40, windowSec: 3600, cost, message: HOURLY },
    ...device({ key: `build:dev:${deviceHash}`, limit: 40, windowSec: 3600, cost, message: HOURLY }),
  ];
}

/** Another unit for a long free build (every 10 steps), counted against its maker like a new build. */
export function longBuildChecks(owner: { deviceHash: string | null; userId: string | null }, cfg: FreeTierConfig, now: Date = new Date()): LimitCheck[] {
  const day = utcDay(now);
  if (owner.userId) return [{ key: `build:userday:${owner.userId}:${day}`, limit: cfg.perAccountDay, windowSec: 86400, daily: true, message: ACCOUNT_DAY }];
  return owner.deviceHash ? [{ key: `build:devday:${owner.deviceHash}:${day}`, limit: cfg.perDeviceDay, windowSec: 86400, daily: true, message: DEVICE_DAY }] : [];
}
