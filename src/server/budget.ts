// The free builder's daily budget in US dollars (ORB_FREE_DAILY_USD): what all free builds together
// may cost Orb in a UTC day. It is the hard cap on money, as Cursor has no spend limit per API key.
// Builds without an account may use part of it (ORB_FREE_DAILY_USD_ANON, half by default): an
// attack without accounts then only asks people to sign in, and those signed in keep building
// until the whole budget is spent.
//
// Builds are charged as they go, not only checked when they start, so many builds at once can't
// run far past the budget: each stops at its next model call once the day's money is spent. A
// build's cost is its tokens at the model's list price: exact where the AI SDK reports usage
// (Anthropic, the AI Gateway), estimated for Cursor agents, whose stream only counts the tokens the
// model writes (see CursorTokens), and for a model call cut short (a stopped build pays for what it
// used, see cutCallUsd). Spend per day is in orb_spend and on the Pulse page.

import type { Db } from './db';
import { utcDay } from './freetier';

// -- prices -------------------------------------------------------------------------------------

/** US$ per million tokens: uncached input, 5-minute cache write, cache read, output. */
export interface Price {
  input: number;
  write: number;
  read: number;
  output: number;
}

/** Anthropic's list prices (October 2026), which Cursor charges for its agents too. */
const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, write: 5, read: 0.2, output: 20 },
  'claude-opus-5': { input: 5, write: 6.25, read: 0.5, output: 25 },
  'claude-sonnet-5-5': { input: 2, write: 2.5, read: 0.1, output: 10 },
  'claude-sonnet-5': { input: 2, write: 2.5, read: 0.2, output: 10 },
  // Haiku 5.5 costs five times as much for prompts over 100k tokens: priced at that, to be safe.
  'claude-haiku-5-5': { input: 0.5, write: 0.625, read: 0.05, output: 2.5 },
};
const BY_LENGTH = Object.keys(PRICES).sort((a, b) => b.length - a.length);

/** Any other model is priced like the dearest Claude (Fable 5.1), so the budget errs on the safe side. */
export const UNKNOWN_PRICE: Price = { input: 10, write: 12.5, read: 1, output: 50 };
const NO_COST: Price = { input: 0, write: 0, read: 0, output: 0 };

/** "anthropic/claude-sonnet-5.5", "claude-sonnet-5-5-20260928" → Sonnet 5.5's price. The mock costs nothing. */
export function priceOf(model: string | null | undefined): Price {
  const id = (model ?? '').toLowerCase().trim().replace(/^[\w-]+\//, '').replace(/\./g, '-');
  if (id === 'mock') return NO_COST;
  const key = BY_LENGTH.find((k) => id === k || id.startsWith(`${k}-`));
  return key ? PRICES[key] : UNKNOWN_PRICE;
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
/** Text the model reads or writes, as tokens (about 3.5 characters each). */
const tokensOfText = (chars: number) => Math.ceil(count(chars) / 3.5);

interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

/** What model calls cost (US$), from the usage the AI SDK reports. */
export function usageUsd(model: string | null | undefined, u: UsageLike | null | undefined): number {
  if (!u) return 0;
  const p = priceOf(model);
  const read = count(u.inputTokenDetails?.cacheReadTokens);
  const write = count(u.inputTokenDetails?.cacheWriteTokens);
  const plain = u.inputTokenDetails?.noCacheTokens !== undefined ? count(u.inputTokenDetails.noCacheTokens) : Math.max(0, count(u.inputTokens) - read - write);
  return (plain * p.input + write * p.write + read * p.read + count(u.outputTokens) * p.output) / 1e6;
}

// -- calls cut short ----------------------------------------------------------------------------

/** A picture in a prompt, as tokens (Anthropic counts width × height / 750: a 1024 × 768 screenshot is ~1,050). */
const IMAGE_TOKENS = 1_600;
const BINARY_KEYS = new Set(['data', 'image']);

/** About how many tokens a prompt is: its text, and each picture in it. */
export function promptTokens(system: string, messages: unknown): number {
  let chars = system.length;
  let images = 0;
  const walk = (v: unknown, key: string): void => {
    if (typeof v === 'string') {
      if (BINARY_KEYS.has(key)) images++;
      else chars += v.length;
    } else if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
      images++;
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) if (k !== 'providerOptions') walk(x, k);
    }
  };
  walk(messages, '');
  return tokensOfText(chars) + images * IMAGE_TOKENS;
}

/**
 * What a model call that was cut short cost (US$): providers only report usage when a call ends,
 * so a call stopped partway (Stop, a time limit, a failure) is estimated from the prompt it read —
 * `input` tokens, of which `cached` were in the prompt cache — and the characters it had written.
 */
export function cutCallUsd(model: string | null | undefined, t: { input: number; cached: number; written: number }): number {
  const p = priceOf(model);
  const read = Math.min(count(t.input), count(t.cached));
  const fresh = count(t.input) - read;
  return (fresh * p.write + read * p.read + tokensOfText(t.written) * p.output) / 1e6;
}

// -- Cursor agents ------------------------------------------------------------------------------

/**
 * A Cursor agent's tokens as far as Orb can tell, kept with the job between ticks. The stream
 * counts the tokens the model writes; what it reads is estimated: Cursor's own instructions and
 * tools, Orb's prompt, and everything written and seen since (tool results), each model call
 * reading what earlier calls cached and caching the rest.
 */
export interface CursorTokens {
  /** The conversation so far. */
  context: number;
  /** How much of it is in the prompt cache. */
  cached: number;
  read: number;
  written: number;
  output: number;
}

/** Cursor's own instructions and tool definitions, which Orb doesn't see: a generous guess. */
export const CURSOR_HARNESS_TOKENS = 20_000;

export function cursorTokens(promptChars: number): CursorTokens {
  return { context: CURSOR_HARNESS_TOKENS + tokensOfText(promptChars), cached: 0, read: 0, written: 0, output: 0 };
}

/** A model call starts: it reads what is cached and caches the rest. */
export function cursorCall(t: CursorTokens): void {
  t.read += t.cached;
  t.written += Math.max(0, t.context - t.cached);
  t.cached = t.context;
}

/** Tokens the model wrote (later calls read them again). */
export function cursorOutput(t: CursorTokens, tokens: number): void {
  t.output += count(tokens);
  t.context += count(tokens);
}

/** Text the agent was given (a tool's result, a follow-up prompt): later calls read it. */
export function cursorInput(t: CursorTokens, chars: number): void {
  t.context += tokensOfText(chars);
}

/** What the run cost so far (US$), counting at least the call that read its prompt. */
export function cursorUsd(model: string | null | undefined, t: CursorTokens): number {
  const p = priceOf(model);
  const written = t.written || t.context;
  return (t.read * p.read + written * p.write + t.output * p.output) / 1e6;
}

// -- the day's budget ---------------------------------------------------------------------------

export interface BudgetConfig {
  /** US$ per UTC day for all free builds together (ORB_FREE_DAILY_USD). 0 turns free building off. */
  dailyUsd: number;
  /** …of which builds without an account may use this much (ORB_FREE_DAILY_USD_ANON). */
  anonUsd: number;
}

export const BUDGET_DEFAULT_USD = 20;

function usdEnv(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = (env[key] ?? '').trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function budgetConfig(env: Record<string, string | undefined> = process.env): BudgetConfig {
  const dailyUsd = usdEnv(env, 'ORB_FREE_DAILY_USD', BUDGET_DEFAULT_USD);
  return { dailyUsd, anonUsd: Math.min(dailyUsd, usdEnv(env, 'ORB_FREE_DAILY_USD_ANON', dailyUsd / 2)) };
}

export interface Spent {
  /** US$ spent today by all free builds… */
  all: number;
  /** …and by those without an account. */
  anon: number;
  /** Builds paid for with credits people bought (Pro, top-ups): outside the budget. */
  paid: number;
}

/** Which part of the budget is spent for this builder: everyone's, the part without an account, or neither. */
export function overBudget(spent: Spent, cfg: BudgetConfig, anonymous: boolean): 'all' | 'anon' | null {
  if (spent.all >= cfg.dailyUsd) return 'all';
  if (anonymous && spent.anon >= cfg.anonUsd) return 'anon';
  return null;
}

export const BUDGET_SPENT = "Orb's free builder has used up today's budget — it's back tomorrow. Add your own AI key in You → Model to keep building now.";
export const ANON_SPENT = 'Lots of people are building without an account right now — sign in (You → Account) to keep building!';
export const BUDGET_PAUSE = "Orb's free builder has used up today's budget, so I'll pause here — it's back tomorrow. Add your own AI key in You → Model to keep going now.";
export const ANON_PAUSE = "Lots of people are building without an account right now, so I'll pause here — sign in (You → Account) to keep going!";

const MICROS = 1_000_000;
const toSpent = (rows: Array<{ scope: string; micros: string | number }>): Spent => ({
  all: Number(rows.find((r) => r.scope === 'free')?.micros ?? 0) / MICROS,
  anon: Number(rows.find((r) => r.scope === 'free:anon')?.micros ?? 0) / MICROS,
  paid: Number(rows.find((r) => r.scope === 'paid')?.micros ?? 0) / MICROS,
});

export async function spentToday(db: Db, now: Date = new Date()): Promise<Spent> {
  return toSpent(await db.query<{ scope: string; micros: string | number }>(`select scope, micros from orb_spend where day = $1::date`, [utcDay(now)]));
}

/** Add what a free build cost (US$) to today's spend; what's spent after it. */
export async function chargeFree(db: Db, usd: number, anonymous: boolean, now: Date = new Date()): Promise<Spent> {
  const micros = Math.round(count(usd) * MICROS);
  if (!micros) return spentToday(db, now);
  await db.query(
    `insert into orb_spend (day, scope, micros) select $1::date, s, $3::bigint from unnest($2::text[]) as s
     on conflict (day, scope) do update set micros = orb_spend.micros + excluded.micros, updated_at = now()`,
    [utcDay(now), anonymous ? ['free', 'free:anon'] : ['free'], micros],
  );
  return spentToday(db, now);
}

/** Add what a build paid for with bought credits cost (US$) to today's spend, outside the budget. */
export async function chargePaid(db: Db, usd: number, now: Date = new Date()): Promise<void> {
  const micros = Math.round(count(usd) * MICROS);
  if (!micros) return;
  await db.query(
    `insert into orb_spend (day, scope, micros) values ($1::date, 'paid', $2::bigint)
     on conflict (day, scope) do update set micros = orb_spend.micros + excluded.micros, updated_at = now()`,
    [utcDay(now), micros],
  );
}

/** Free spend per UTC day (US$), for the Pulse page. */
export async function spendByDay(db: Db, days: number): Promise<Map<string, Spent>> {
  const rows = await db.query<{ day: string; scope: string; micros: string | number }>(
    `select to_char(day, 'YYYY-MM-DD') as day, scope, micros from orb_spend where day > (now() at time zone 'utc')::date - $1::int order by day`,
    [days],
  );
  const out = new Map<string, Spent>();
  for (const day of new Set(rows.map((r) => r.day))) out.set(day, toSpent(rows.filter((r) => r.day === day)));
  return out;
}
