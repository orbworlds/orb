// How Orb is doing, for the secret pulse page: the last 7 days (UTC), totals, the free builder, the
// plans and recent problems (orb_errors). Who the visitors are and what they do: ./analytics.

import { aiBackend, modelLabel } from './ai';
import { budgetConfig, spendByDay, type BudgetConfig, type Spent } from './budget';
import { toCredits } from './credits';
import type { Db } from './db';
import { paymentsOn, stripeTestMode } from './stripe';

export interface PulseDay {
  day: string;
  /** Devices that sent analytics events (orb_events). */
  visitors: number;
  /** People's new worlds (not remixes)… */
  started: number;
  /** …of which the AI built at least once. */
  built: number;
  remixes: number;
  /** Requests to the builders (free and people's own keys). */
  builds: number;
  /** Multi-step builds that ended in failure. */
  failed: number;
  accounts: number;
  /** What free builds cost Orb, US$ (Cursor agents' cost is estimated, see ./budget.ts). */
  spend: number;
}

export interface PulseProblem {
  kind: string;
  message: string;
  detail: string | null;
  path: string | null;
  count: number;
  firstAt: string;
  lastAt: string;
}

export interface Pulse {
  /** When this was read (epoch ms). */
  now: number;
  days: PulseDay[];
  totals: { worlds: number; accounts: number; devices: number; plays: number; likes: number };
  builder: { backend: string; model: string; lastDown: { at: string; message: string } | null; budget: BudgetConfig; today: Spent };
  /** The server's own problems and builder outages, apart from what browsers report (pages). */
  problems: { server: PulseProblem[]; pages: PulseProblem[] };
  /** Plans (./billing.ts): Stripe set up, Pro accounts (and how many of them end), credit packs sold. */
  plans: { payments: boolean; testMode: boolean; pro: number; ending: number; packs: number; packCredits: number };
}

const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();

type ProblemRow = { kind: string; message: string; detail: string | null; path: string | null; count: number; first_at: Date | string; last_at: Date | string };
const toProblem = (p: ProblemRow): PulseProblem => ({ kind: p.kind, message: p.message, detail: p.detail, path: p.path, count: Number(p.count), firstAt: iso(p.first_at), lastAt: iso(p.last_at) });

export async function pulse(db: Db): Promise<Pulse> {
  const people = `(w.owner_user is not null or w.owner_device is not null)`;
  const on = (col: string) => `${col} >= d.day and ${col} < d.day + interval '24 hours'`;
  const [days, totals, down, server, pages, spend, plans] = await Promise.all([
    db.query<{ day: string; visitors: number; started: number; built: number; remixes: number; builds: number; failed: number; accounts: number }>(
      `with d as (select generate_series(date_trunc('day', now() at time zone 'utc') - interval '6 days', date_trunc('day', now() at time zone 'utc'), interval '1 day') at time zone 'utc' as day)
       select to_char(d.day at time zone 'utc', 'YYYY-MM-DD') as day,
         (select count(distinct e.device) from orb_events e where ${on('e.at')})::int as visitors,
         (select count(*) from orb_worlds w where ${people} and w.forked_from is null and ${on('w.created_at')})::int as started,
         (select count(*) from orb_worlds w where ${people} and w.forked_from is null and w.version > 1 and ${on('w.created_at')})::int as built,
         (select count(*) from orb_worlds w where w.forked_from is not null and ${on('w.created_at')})::int as remixes,
         (select count(*) from orb_build_jobs j where ${on('j.created_at')})::int as builds,
         (select count(*) from orb_agent_jobs a where a.status = 'failed' and ${on('a.created_at')})::int as failed,
         (select count(*) from orb_users u where ${on('u.created_at')})::int as accounts
       from d order by d.day desc`,
    ),
    db.query<{ worlds: number; accounts: number; devices: number; plays: number; likes: number }>(
      `select (select count(*) from orb_worlds w where ${people})::int as worlds,
              (select count(*) from orb_users)::int as accounts,
              (select count(*) from orb_devices)::int as devices,
              (select coalesce(sum(plays), 0) from orb_worlds)::int as plays,
              (select coalesce(sum(likes), 0) from orb_worlds)::int as likes`,
    ),
    db.query<{ message: string; last_at: Date | string }>(`select message, last_at from orb_errors where kind = 'builder' order by last_at desc limit 1`),
    db.query<ProblemRow>(`select kind, message, detail, path, count, first_at, last_at from orb_errors where kind <> 'page' order by last_at desc limit 25`),
    db.query<ProblemRow>(`select kind, message, detail, path, count, first_at, last_at from orb_errors where kind = 'page' order by last_at desc limit 25`),
    spendByDay(db, 7),
    db.query<{ pro: number; ending: number; packs: number; micros: string | number }>(
      `select (select count(*) from orb_wallets where plan = 'pro')::int as pro,
              (select count(*) from orb_wallets where plan = 'pro' and cancel_at is not null)::int as ending,
              (select count(*) from orb_credit_log where kind = 'topup')::int as packs,
              (select coalesce(sum(micros), 0) from orb_credit_log where kind = 'topup') as micros`,
    ),
  ]);
  return {
    now: Date.now(),
    days: days.map((r) => ({ ...r, visitors: Number(r.visitors), started: Number(r.started), built: Number(r.built), remixes: Number(r.remixes), builds: Number(r.builds), failed: Number(r.failed), accounts: Number(r.accounts), spend: spend.get(r.day)?.all ?? 0 })),
    totals: Object.fromEntries(Object.entries(totals[0]).map(([k, v]) => [k, Number(v)])) as Pulse['totals'],
    builder: {
      backend: aiBackend(),
      model: modelLabel(),
      lastDown: down[0] ? { at: iso(down[0].last_at), message: down[0].message } : null,
      budget: budgetConfig(),
      today: spend.get(days[0]?.day ?? '') ?? { all: 0, anon: 0, paid: 0 },
    },
    problems: { server: server.map(toProblem), pages: pages.map(toProblem) },
    plans: { payments: paymentsOn(), testMode: stripeTestMode(), pro: Number(plans[0]?.pro) || 0, ending: Number(plans[0]?.ending) || 0, packs: Number(plans[0]?.packs) || 0, packCredits: toCredits(Number(plans[0]?.micros) || 0) },
  };
}
