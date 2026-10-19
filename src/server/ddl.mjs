// Idempotent schema DDL, shared by the app (src/server/schema.ts) and the build-time
// production check (scripts/prod-check.mjs). Additive changes only ("if not exists").
import { createHash } from 'node:crypto';

export const DDL = `
create table if not exists orb_users (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);
-- Accounts with a username (their handle, orb_handles) and password: an scrypt hash (src/server/accounts.ts).
alter table orb_users add column if not exists password_hash text;
-- The account's blob in worlds: { "color", "wear": [look ids] } (src/server/looks.ts).
alter table orb_users add column if not exists look jsonb;
create table if not exists orb_passkeys (
  id text primary key,
  user_id text not null references orb_users(id) on delete cascade,
  public_key bytea not null,
  counter bigint not null default 0,
  transports text,
  created_at timestamptz not null default now()
);
create table if not exists orb_devices (
  hash text primary key,
  user_id text references orb_users(id) on delete set null,
  name text,
  created_at timestamptz not null default now()
);
create table if not exists orb_challenges (
  key text primary key,
  challenge text not null,
  data jsonb,
  expires_at timestamptz not null
);
create table if not exists orb_worlds (
  id text primary key,
  name text not null default 'Untitled world',
  description text not null default '',
  kind text not null default 'native',
  code text,
  external_url text,
  source_url text,
  owner_device text,
  owner_user text references orb_users(id) on delete set null,
  author_name text not null default 'Someone',
  visibility text not null default 'public',
  forkable boolean not null default true,
  forked_from text,
  template text,
  verified boolean not null default false,
  featured integer not null default 0,
  tags text[] not null default '{}',
  thumb bytea,
  thumb_type text,
  thumb_version integer not null default 0,
  thumb_url text,
  plays integer not null default 0,
  likes integer not null default 0,
  forks integer not null default 0,
  version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orb_worlds_owner_device on orb_worlds(owner_device);
create index if not exists orb_worlds_owner_user on orb_worlds(owner_user);
create index if not exists orb_worlds_public_new on orb_worlds(visibility, created_at desc);
-- External worlds that stopped loading or allowing embeds (checked daily); hidden from Explore.
alter table orb_worlds add column if not exists broken_at timestamptz;
alter table orb_worlds add column if not exists handle text;
alter table orb_worlds add column if not exists slug text;
-- Open-source worlds imported from a repository: their license (shown with the credit).
alter table orb_worlds add column if not exists license text;
-- Trending: recent engagement (plays, likes, remixes) that fades with a half-life of ~2 days.
alter table orb_worlds add column if not exists heat double precision not null default 0;
alter table orb_worlds add column if not exists heat_at timestamptz not null default now();
-- Curated worlds kept out of Explore: still playable by link, and listed on a secret page.
alter table orb_worlds add column if not exists hidden boolean not null default false;
-- Curated worlds: where they came from (the maker's post and its views, the prompt they shared).
alter table orb_worlds add column if not exists origin jsonb;
create table if not exists orb_handles (
  handle text primary key,
  owner_user text unique,
  owner_device text unique,
  created_at timestamptz not null default now()
);
create table if not exists orb_world_paths (
  handle text not null,
  slug text not null,
  world_id text not null references orb_worlds(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (handle, slug)
);
-- Chats of signed-in people, so they follow them across devices.
create table if not exists orb_chats (
  user_id text not null references orb_users(id) on delete cascade,
  thread_id text not null,
  world_id text not null,
  title text not null default '',
  messages jsonb not null default '[]',
  updated_at bigint not null,
  primary key (user_id, thread_id)
);
create index if not exists orb_chats_recent on orb_chats(user_id, updated_at desc);
create table if not exists orb_world_versions (
  world_id text not null references orb_worlds(id) on delete cascade,
  version integer not null,
  code text not null,
  prompt text,
  created_at timestamptz not null default now(),
  primary key (world_id, version)
);
create table if not exists orb_kv (
  world_id text not null references orb_worlds(id) on delete cascade,
  key text not null,
  value jsonb,
  updated_at timestamptz not null default now(),
  primary key (world_id, key)
);
create table if not exists orb_likes (
  world_id text not null references orb_worlds(id) on delete cascade,
  device_hash text not null,
  created_at timestamptz not null default now(),
  primary key (world_id, device_hash)
);
create table if not exists orb_rate (
  key text primary key,
  window_start timestamptz not null,
  count integer not null default 0
);
create index if not exists orb_rate_window on orb_rate(window_start);
-- Friends (src/server/friends.ts): two accounts, the smaller id first (byte order, as JavaScript
-- compares them). A request is 'pending' (requested_by says who asked) until the other accepts.
create table if not exists orb_friends (
  a text not null references orb_users(id) on delete cascade,
  b text not null references orb_users(id) on delete cascade,
  requested_by text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (a, b),
  check (a < b collate "C")
);
create index if not exists orb_friends_b on orb_friends(b);
-- Where each signed-in person is: the world on their screen at their page's last heartbeat, and
-- whether that page has gone away since.
create table if not exists orb_presence (
  user_id text primary key references orb_users(id) on delete cascade,
  world_id text,
  at timestamptz not null default now(),
  away boolean not null default false
);
-- The world's rooms that page is in, with its peer id in each: [{ room, peer }] (friends see it there).
alter table orb_presence add column if not exists rooms jsonb;
-- What friends did for someone: asked to be friends, accepted, invited them into a world.
create table if not exists orb_notifications (
  id bigserial primary key,
  user_id text not null references orb_users(id) on delete cascade,
  kind text not null,
  actor_id text not null references orb_users(id) on delete cascade,
  world_id text references orb_worlds(id) on delete cascade,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists orb_notifications_user on orb_notifications(user_id, created_at desc);
-- 'remix': someone remixed your world (world_id: their remix); without an account, no actor.
alter table orb_notifications alter column actor_id drop not null;
-- 'sale': things sold in your world: detail { count, credits, item } (one note per world adds up until read).
alter table orb_notifications add column if not exists detail jsonb;
-- Things bought in worlds with credits (orb.shop, src/server/shop.ts): one row per item an account
-- owns in a world. paid_micros: what of the price came from paid credits (Pro's, packs); the
-- world's maker earned earned_micros of it. Kept when the world goes (world_id has no reference).
create table if not exists orb_purchases (
  id bigserial primary key,
  world_id text not null,
  item_id text not null,
  item_name text not null,
  buyer_user text not null references orb_users(id) on delete cascade,
  seller_user text,
  price_micros bigint not null,
  paid_micros bigint not null default 0,
  earned_micros bigint not null default 0,
  status text not null default 'pending',
  test boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists orb_purchases_once on orb_purchases(world_id, item_id, buyer_user);
create index if not exists orb_purchases_buyer on orb_purchases(buyer_user, created_at desc);
create index if not exists orb_purchases_seller on orb_purchases(seller_user, created_at desc) where seller_user is not null;
create index if not exists orb_worlds_forked_from on orb_worlds(forked_from) where forked_from is not null;
-- What the free builder cost Orb per UTC day, in millionths of a US dollar (src/server/budget.ts):
-- scope 'free' for all free builds, 'free:anon' for those without an account.
create table if not exists orb_spend (
  day date not null,
  scope text not null,
  micros bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (day, scope)
);
create table if not exists orb_build_jobs (
  id text primary key,
  output text not null default '',
  done boolean not null default false,
  cancelled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orb_build_jobs_created on orb_build_jobs(created_at);
create table if not exists orb_build_chunks (
  job_id text not null references orb_build_jobs(id) on delete cascade,
  seq integer not null,
  text text not null,
  primary key (job_id, seq)
);
-- Multi-file worlds: content-addressed blobs, trees (path → blob manifests) and agent jobs.
alter table orb_worlds add column if not exists tree text;
alter table orb_world_versions add column if not exists tree text;
create table if not exists orb_blobs (
  sha text primary key,
  data bytea not null,
  size integer not null,
  created_at timestamptz not null default now()
);
create table if not exists orb_trees (
  sha text primary key,
  files jsonb not null,
  size bigint not null default 0,
  count integer not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists orb_agent_jobs (
  id text primary key references orb_build_jobs(id) on delete cascade,
  world_id text not null references orb_worlds(id) on delete cascade,
  owner_device text,
  owner_user text,
  mode text not null default 'build',
  status text not null default 'running',
  provider text not null default 'free',
  model text,
  key_enc text,
  origin text,
  messages jsonb not null default '[]',
  base_tree text,
  tree text,
  committed_tree text,
  prompt text,
  title text,
  steps integer not null default 0,
  max_steps integer not null default 60,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  pos bigint not null default 0,
  seq integer not null default 0,
  lease_until timestamptz,
  ticks integer not null default 0,
  failures integer not null default 0,
  error text,
  committed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- ext: the agent's state (Cursor builds). repo and gh_enc: no longer written (Cursor builds once
-- ran on a world's repository).
alter table orb_agent_jobs add column if not exists repo text;
alter table orb_agent_jobs add column if not exists gh_enc text;
alter table orb_agent_jobs add column if not exists ext jsonb;
-- Cursor builds without GitHub (Orb's own Cursor key): the newest files the agent saved to Orb,
-- for the job's tick to pick up (see src/server/agent/sync.ts).
alter table orb_agent_jobs add column if not exists inbox text;
create index if not exists orb_agent_jobs_running on orb_agent_jobs(status, lease_until);
create index if not exists orb_agent_jobs_world on orb_agent_jobs(world_id, created_at desc);
-- The agent looking at the world in a page that watches the job (its look tool): when a page last
-- followed the job, and each look's request and what the page saw (screenshots included).
alter table orb_agent_jobs add column if not exists watched_at timestamptz;
create table if not exists orb_agent_looks (
  job_id text not null references orb_agent_jobs(id) on delete cascade,
  id text not null,
  status text not null default 'pending',
  result jsonb,
  declined text,
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  primary key (job_id, id)
);
-- A Cursor agent's look (sh .orb/look, see src/server/agent/sync.ts): what it asked to see (its
-- files' tree, actions, viewport), when the job's tick passed it on to the pages, and when the
-- tick closed it in the job's output.
alter table orb_agent_looks add column if not exists request jsonb;
alter table orb_agent_looks add column if not exists asked_at timestamptz;
alter table orb_agent_looks add column if not exists closed_at timestamptz;
-- Problems worth a look (page crashes, server errors, the free builder going down), one row per
-- kind of problem: how often and when it happened, and when it was last sent as an alert.
create table if not exists orb_errors (
  key text primary key,
  kind text not null,
  message text not null,
  detail text,
  path text,
  count integer not null default 1,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  alerted_at timestamptz
);
create index if not exists orb_errors_last on orb_errors(last_at desc);
-- Traces of AI builds, to look back at how they went (src/server/traces.ts): one row per build run
-- (an agent job; older rows also /api/build requests and browser-direct rounds), its timeline of events (gzipped JSON
-- payloads) and the content-addressed blobs they point to (system prompts, world files,
-- screenshots). No foreign keys: traces outlive the jobs and worlds they describe.
create table if not exists orb_traces (
  id text primary key,
  group_id text,
  kind text not null,
  world_id text,
  owner_device text,
  owner_user text,
  provider text not null,
  model text,
  mode text not null default 'build',
  prompt text not null default '',
  status text not null default 'running',
  error text,
  steps integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  reasoning_tokens bigint not null default 0,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_ms bigint,
  meta jsonb not null default '{}'::jsonb
);
create index if not exists orb_traces_started on orb_traces(started_at desc);
create index if not exists orb_traces_group on orb_traces(group_id);
create table if not exists orb_trace_events (
  trace_id text not null,
  seq integer not null,
  at timestamptz not null default now(),
  type text not null,
  summary jsonb not null default '{}'::jsonb,
  payload bytea,
  size integer not null default 0,
  primary key (trace_id, seq)
);
create table if not exists orb_trace_blobs (
  sha text primary key,
  data bytea not null,
  size integer not null,
  media_type text,
  created_at timestamptz not null default now(),
  used_at timestamptz not null default now()
);
create index if not exists orb_trace_blobs_used on orb_trace_blobs(used_at);
-- Product analytics (src/lib/analytics.ts → POST /api/events; read by /lab/<key>/analytics): one
-- row per event — what happened (name, small props), who (device hash, account), the tab's visit
-- (session), where (path, world), and the referrer of a visit's first page. Kept for 180 days.
create table if not exists orb_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  name text not null,
  device text not null,
  user_id text,
  session text not null,
  path text,
  world_id text,
  props jsonb,
  referrer text,
  country text,
  mobile boolean
);
create index if not exists orb_events_at on orb_events(at);
create index if not exists orb_events_name_at on orb_events(name, at);
create index if not exists orb_events_device_at on orb_events(device, at);
-- Moving to a new address (src/server/move.ts): what a browser brings along from a former address
-- (its account, device and packed saved things, opaque to the server), waiting under a single-use
-- code for that same browser to pick it up at the new address. Kept 10 minutes.
create table if not exists orb_moves (
  code_hash text primary key,
  state_key text not null,
  state_hash text not null,
  user_id text references orb_users(id) on delete cascade,
  device_hash text,
  data bytea,
  pack text not null default 'none',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists orb_moves_expires on orb_moves(expires_at);
-- Plans and credits (src/server/credits.ts, src/server/billing.ts): each payer's wallet ('u:' an
-- account, 'd:' a device without one), in millionths of a US dollar (a credit is 10,000). This
-- period's plan credits (allowance, used) reset when the period ends; top-ups stay until used.
-- Pro accounts carry their Stripe customer and subscription.
create table if not exists orb_wallets (
  payer text primary key,
  plan text not null default 'free',
  period_start timestamptz not null,
  period_end timestamptz not null,
  allowance_micros bigint not null default 0,
  used_micros bigint not null default 0,
  topup_micros bigint not null default 0,
  stripe_customer text,
  stripe_subscription text,
  sub_status text,
  cancel_at timestamptz,
  synced_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists orb_wallets_customer on orb_wallets(stripe_customer);
-- What makers earned in their worlds' shops (src/server/shop.ts): earned_micros is theirs to use
-- or cash out (src/server/payouts.ts), earned_total_micros all they ever earned.
alter table orb_wallets add column if not exists earned_micros bigint not null default 0;
alter table orb_wallets add column if not exists earned_total_micros bigint not null default 0;
-- Credits Orb gave that nobody bought (src/server/credits.ts): earnings a maker put into building, and
-- plan credits a refund gives back after their period ended. They pay for builds (after the period's
-- plan credits, before top-ups) and buy things in worlds, but there, like free credits, they earn
-- nobody anything: only bought credits do (so earnings can't be passed on to be cashed out elsewhere).
alter table orb_wallets add column if not exists bonus_micros bigint not null default 0;
-- What moved credits: a build's cost, a refund, a top-up (ref: the job or the Stripe checkout).
create table if not exists orb_credit_log (
  id bigserial primary key,
  payer text not null,
  kind text not null,
  micros bigint not null,
  ref text,
  at timestamptz not null default now()
);
create unique index if not exists orb_credit_log_ref on orb_credit_log(kind, ref) where ref is not null;
create index if not exists orb_credit_log_payer on orb_credit_log(payer, at desc);
-- What a free-builder job has charged its maker so far (refunded if it fails without saving).
alter table orb_agent_jobs add column if not exists charged_micros bigint not null default 0;
-- …and how much of it came from top-ups: a refund gives back only that much to them (src/server/credits.ts).
alter table orb_agent_jobs add column if not exists charged_topup_micros bigint not null default 0;
-- Game progress of signed-in people (a world's localStorage, src/server/saves.ts), so it follows
-- them to every device: the saved data as JSON text, its size, and when the browser saved it (the
-- newer copy wins).
create table if not exists orb_saves (
  user_id text not null references orb_users(id) on delete cascade,
  world_id text not null references orb_worlds(id) on delete cascade,
  data text not null,
  size integer not null default 0,
  at bigint not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, world_id)
);
-- Cash payouts of makers' earnings through Stripe Connect (src/server/payouts.ts): each maker's
-- Express account (ready: Stripe last said transfers are active and its bank can be paid), and each
-- payout: micros of earnings (credit value, US$ millionths) sent as amount (the currency's cents) at
-- usd_per (US$ per unit of it); 'pending' until Stripe answers, then 'paid' (transfer) or 'failed'
-- (the earnings went back). Payouts outlive their account, for the books (no reference).
create table if not exists orb_payout_accounts (
  user_id text primary key references orb_users(id) on delete cascade,
  stripe_account text not null unique,
  country text not null,
  ready boolean not null default false,
  created_at timestamptz not null default now(),
  synced_at timestamptz
);
create table if not exists orb_payouts (
  id text primary key,
  user_id text not null,
  stripe_account text not null,
  micros bigint not null,
  amount bigint not null,
  currency text not null,
  usd_per numeric not null,
  status text not null default 'pending',
  transfer text,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists orb_payouts_user on orb_payouts(user_id, created_at desc);
-- A cash-out is a request Orb checks first ('requested'), then 'pending', 'paid', 'failed' or
-- 'rejected'; one open at a time per maker.
alter table orb_payouts add column if not exists reviewed_at timestamptz;
create unique index if not exists orb_payouts_open on orb_payouts(user_id) where status in ('requested', 'pending');
-- What tells a maker's own accounts apart from other players (src/server/payouts.ts): the cards
-- each payer paid with (Stripe's fingerprints), and the devices accounts use (orb_events.user_id).
create table if not exists orb_cards (
  payer text not null,
  fingerprint text not null,
  at timestamptz not null default now(),
  primary key (payer, fingerprint)
);
create index if not exists orb_cards_fingerprint on orb_cards(fingerprint);
create index if not exists orb_events_user on orb_events(user_id) where user_id is not null;
-- A refunded or disputed payment: the payer is flagged (nothing they buy in worlds earns cashable
-- credits again) and what their purchases earned makers is reversed.
alter table orb_wallets add column if not exists flagged_at timestamptz;
alter table orb_wallets add column if not exists flag_reason text;
alter table orb_purchases add column if not exists reversed boolean not null default false;
-- A world kept in sync with a GitHub repository's branch (src/server/reposync.ts): the commit and
-- the world's tree both sides last agreed on, and where in the repository the world's files are.
create table if not exists orb_world_repos (
  world_id text primary key references orb_worlds(id) on delete cascade,
  repo text not null,
  branch text not null,
  root text not null default '',
  synced_sha text,
  synced_tree text,
  checked_at timestamptz,
  pulled_at timestamptz,
  pushed_at timestamptz,
  state text not null default 'ok',
  note text,
  created_at timestamptz not null default now()
);
create index if not exists orb_world_repos_checked on orb_world_repos(checked_at);
-- A person's GitHub token, sealed (./agent/secrets.ts), so Orb can push their worlds' new versions
-- and read their private repositories while no tab is open. owner: 'u:<account>' or 'd:<device>'.
create table if not exists orb_github_tokens (
  owner text primary key,
  login text not null,
  token_enc text not null,
  updated_at timestamptz not null default now()
);
-- auto: every world of theirs gets a private repository of its own, kept in sync, at its first save
alter table orb_github_tokens add column if not exists auto boolean not null default false;
-- The Orb kit asking to push as someone (orb push, src/server/kit.ts): code is what they approve
-- in their browser, poll_hash the kit's secret for picking up the token (sealed, once), for 10 minutes.
create table if not exists orb_kit_logins (
  code text primary key,
  poll_hash text not null unique,
  token_enc text,
  name text,
  created_at timestamptz not null default now()
);
-- What this database has applied, by fingerprint ('schema': this DDL, 'seeds': the curated
-- catalog), so a start skips work that is already done. Delete a row to have it redone.
create table if not exists orb_meta (
  key text primary key,
  value text not null,
  at timestamptz not null default now()
);
-- Supabase's Data API serves the public schema to anyone with the project's public key, which
-- every browser gets for Realtime. Orb never uses that API (only its server reads and writes these
-- tables, as their owner), so its roles get nothing here, and row-level security is on with no
-- policies in case a grant comes back. Off Supabase there are no such roles; once done, a no-op.
do $$
declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'orb\\_%' and not c.relrowsecurity loop
    execute format('alter table public.%I enable row level security', t.relname);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') and exists (select 1 from pg_roles where rolname = 'authenticated') then
    if exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated')) then
      revoke all on all tables in schema public from anon, authenticated;
      revoke all on all sequences in schema public from anon, authenticated;
    end if;
    alter default privileges in schema public revoke all on tables from anon, authenticated;
    alter default privileges in schema public revoke all on sequences from anon, authenticated;
  end if;
end $$;
`;

/** Fingerprint of the DDL, kept in orb_meta ('schema') once applied. */
export const SCHEMA_VERSION = createHash('sha1').update(DDL).digest('hex').slice(0, 16);

/**
 * The DDL as one transaction that records its fingerprint. Its `alter table` and `create index`
 * statements lock their tables even when there is nothing to change, and every query on a table
 * queues behind a waiting lock: run it only when the fingerprint changed, one migrator at a time,
 * and give up after a short wait (the next start retries) rather than stall the site behind a
 * slow query.
 */
export const MIGRATION = `set local lock_timeout = '3s';
select pg_advisory_xact_lock(hashtext('orb:schema'));
${DDL}
insert into orb_meta (key, value) values ('schema', '${SCHEMA_VERSION}')
  on conflict (key) do update set value = excluded.value, at = now();
`;
