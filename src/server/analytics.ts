// What the analytics page (/lab/<key>/analytics) shows, read from orb_events (see ./events), over
// the last 7 or 30 days in UTC days: visitors (devices) and how many were new, visits (a tab's
// session), page views and how long visits last; the funnel of the people who first came in those
// days, from opening a world to coming back another day; worlds by opens and play time; events;
// where visits come from; phones and computers; countries; and everyone who came — each with their
// own timeline (person()).
// A person is a device: its display name is its account's, else the name it gave Orb, else its
// public id (the one at the bottom of the You tab).

import { publicDeviceId } from './auth';
import type { Db } from './db';
import type { PropValue } from './events';

export type Range = 7 | 30;

export interface AnalyticsDay {
  day: string;
  visitors: number;
  newVisitors: number;
  visits: number;
  pageViews: number;
  opens: number;
  prompts: number;
  builds: number;
  playSeconds: number;
}

export interface WorldRef {
  id: string;
  /** Null when the world is gone (deleted). */
  name: string | null;
  href: string;
}

export interface AnalyticsWorld extends WorldRef {
  author: string | null;
  opens: number;
  /** Everyone who opened it, spent time in it, prompted in it or liked it. */
  people: number;
  playSeconds: number;
  prompts: number;
  likes: number;
  /** How it was opened (world_open's source), most first. */
  sources: Array<[string, number]>;
}

export interface AnalyticsPerson {
  /** Public device id (12 hex): the person page's address. */
  id: string;
  name: string | null;
  signedIn: boolean;
  mobile: boolean | null;
  country: string | null;
  firstAt: string;
  lastAt: string;
  visits: number;
  prompts: number;
  builds: number;
  /** Worlds they own, made or remixed (all time). */
  worlds: number;
}

export interface Analytics {
  now: number;
  range: Range;
  totals: { visitors: number; newVisitors: number; visits: number; pageViews: number; events: number; avgVisitSeconds: number; medianVisitSeconds: number; playSeconds: number };
  days: AnalyticsDay[];
  /** People who first came in the range, and how many of them got through each step (and the ones before it). */
  funnel: { came: number; opened: number; prompted: number; built: number; cameBack: number };
  worlds: AnalyticsWorld[];
  events: Array<{ name: string; count: number; people: number }>;
  sources: Array<{ source: string; visits: number; people: number }>;
  devices: { phone: number; computer: number; unknown: number };
  countries: Array<{ country: string | null; people: number }>;
  people: AnalyticsPerson[];
}

export interface PersonEvent {
  id: string;
  at: string;
  name: string;
  session: string;
  path: string | null;
  world: WorldRef | null;
  /** The world it was remixed from (a remix's from_world). */
  from: WorldRef | null;
  props: Record<string, PropValue> | null;
  referrer: string | null;
  country: string | null;
  mobile: boolean | null;
}

export interface PersonDetail extends Omit<AnalyticsPerson, 'worlds'> {
  now: number;
  events: number;
  worlds: Array<WorldRef & { createdAt: string; remix: boolean; version: number; plays: number; likes: number }>;
  /** The latest events, newest first (at most TIMELINE). */
  timeline: PersonEvent[];
}

export const TIMELINE = 500;
const PEOPLE = 200;

const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();
const n = (v: unknown) => Number(v ?? 0);
const href = (id: string, handle: string | null, slug: string | null) => (handle && slug ? `/${handle}/${slug}` : `/w/${encodeURIComponent(id)}`);

/** A number in an event's props, kept to [0, max] (props are only checked to be flat). */
const num = (e: string, key: string, max = 21_600) => `case when jsonb_typeof(${e}.props->'${key}') = 'number' then greatest(0, least((${e}.props->>'${key}')::float8, ${max})) end`;
/** A build that finished and saved a new version (background builds don't say whether they saved). */
const built = (e: string) => `(${e}.name = 'build_done' and ${e}.props->>'status' = 'done' and coalesce(${e}.props->>'saved', 'true') = 'true')`;

/** Midnight (UTC) that starts the range: today and the days before it. */
function rangeStart(now: number, range: Range): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - (range - 1) * 86_400_000);
}

export async function analytics(db: Db, range: Range): Promise<Analytics> {
  const now = Date.now();
  const start = rangeStart(now, range);
  const since = [start.toISOString()];
  const [daily, totals, funnel, worlds, events, sources, devices, countries, people] = await Promise.all([
    db.query<Record<string, unknown> & { day: string }>(
      `with ev as (
         select (e.at at time zone 'utc')::date as day, e.device, e.session, e.name, e.props
         from orb_events e where e.at >= $1::timestamptz
       ), firsts as (
         select s.device, ((select min(x.at) from orb_events x where x.device = s.device) at time zone 'utc')::date as first_day
         from (select distinct device from ev) s
       )
       select to_char(ev.day, 'YYYY-MM-DD') as day,
         count(distinct ev.device)::int as visitors,
         count(distinct ev.device) filter (where f.first_day = ev.day)::int as new_visitors,
         count(distinct ev.session)::int as visits,
         count(*) filter (where ev.name = 'page_view')::int as page_views,
         count(*) filter (where ev.name = 'world_open')::int as opens,
         count(*) filter (where ev.name = 'prompt_send')::int as prompts,
         count(*) filter (where ${built('ev')})::int as builds,
         coalesce(sum(${num('ev', 'seconds')}) filter (where ev.name = 'world_leave'), 0)::float8 as play_seconds
       from ev join firsts f on f.device = ev.device
       group by ev.day`,
      since,
    ),
    db.query<Record<string, unknown>>(
      `with s as (
         select e.session, min(e.at) as first_at, max(e.at) as last_at from orb_events e where e.at >= $1::timestamptz group by e.session
       )
       select (select count(distinct e.device) from orb_events e where e.at >= $1::timestamptz)::int as visitors,
              (select count(*) from orb_events e where e.at >= $1::timestamptz)::int as events,
              (select count(*) from orb_events e where e.at >= $1::timestamptz and e.name = 'page_view')::int as page_views,
              (select count(*) from s)::int as visits,
              coalesce((select avg(extract(epoch from s.last_at - s.first_at)) from s), 0)::float8 as avg_visit,
              coalesce((select percentile_cont(0.5) within group (order by extract(epoch from s.last_at - s.first_at)) from s), 0)::float8 as median_visit`,
      since,
    ),
    // A world you made never says world_open, but leaving it says world_leave.
    db.query<Record<string, unknown>>(
      `with v as (
         select e.device, min(e.at) as first_at, max(e.at) as last_at,
           bool_or(e.name in ('world_open', 'world_leave')) as opened, bool_or(e.name = 'prompt_send') as prompted, bool_or(${built('e')}) as built
         from orb_events e where e.at >= $1::timestamptz group by e.device
       ), d as (
         select v.* from v where not exists (select 1 from orb_events x where x.device = v.device and x.at < $1::timestamptz)
       )
       select count(*)::int as came, count(*) filter (where opened)::int as opened, count(*) filter (where opened and prompted)::int as prompted,
              count(*) filter (where opened and prompted and built)::int as built,
              count(*) filter (where opened and prompted and built and (last_at at time zone 'utc')::date > (first_at at time zone 'utc')::date)::int as came_back
       from d`,
      since,
    ),
    db.query<Record<string, unknown> & { world_id: string; name: string | null; author_name: string | null; handle: string | null; slug: string | null; sources: Record<string, number> | null }>(
      `with ev as (
         select e.world_id, e.name, e.device, e.props from orb_events e
         where e.at >= $1::timestamptz and e.world_id is not null and e.name in ('world_open', 'world_leave', 'prompt_send', 'like')
       ), src as (
         select s.world_id, jsonb_object_agg(s.source, s.n) as sources
         from (select ev.world_id, coalesce(ev.props->>'source', 'other') as source, count(*)::int as n from ev where ev.name = 'world_open' group by 1, 2) s
         group by s.world_id
       ), agg as (
         select ev.world_id,
           count(*) filter (where ev.name = 'world_open')::int as opens,
           count(distinct ev.device)::int as people,
           coalesce(sum(${num('ev', 'seconds')}) filter (where ev.name = 'world_leave'), 0)::float8 as play_seconds,
           count(*) filter (where ev.name = 'prompt_send')::int as prompts,
           count(*) filter (where ev.name = 'like' and ev.props->>'liked' = 'true')::int as likes
         from ev group by ev.world_id
       )
       select agg.*, src.sources, w.name, w.author_name, w.handle, w.slug
       from agg left join src on src.world_id = agg.world_id left join orb_worlds w on w.id = agg.world_id
       order by agg.opens desc, agg.play_seconds desc, agg.world_id limit 20`,
      since,
    ),
    db.query<{ name: string; count: number; people: number }>(
      `select e.name, count(*)::int as count, count(distinct e.device)::int as people
       from orb_events e where e.at >= $1::timestamptz group by e.name order by count desc, e.name limit 40`,
      since,
    ),
    db.query<{ source: string; visits: number; people: number }>(
      `select coalesce(nullif(e.props->>'utm_source', ''), regexp_replace(substring(e.referrer from '://([^/:]+)'), '^www\\.', ''), 'Direct') as source,
              count(*)::int as visits, count(distinct e.device)::int as people
       from orb_events e where e.at >= $1::timestamptz and e.name = 'page_view' and e.props->>'landing' = 'true'
       group by 1 order by visits desc, source limit 12`,
      since,
    ),
    db.query<Record<string, unknown>>(
      `select count(distinct e.device) filter (where e.mobile)::int as phone,
              count(distinct e.device) filter (where e.mobile = false)::int as computer,
              count(distinct e.device) filter (where e.mobile is null)::int as unknown
       from orb_events e where e.at >= $1::timestamptz`,
      since,
    ),
    db.query<{ country: string | null; people: number }>(
      `select e.country, count(distinct e.device)::int as people from orb_events e where e.at >= $1::timestamptz group by e.country order by people desc, e.country limit 12`,
      since,
    ),
    db.query<Record<string, unknown> & { device: string; name: string | null; country: string | null; mobile: boolean | null; first_at: Date | string; last_at: Date | string; user_id: string | null }>(
      `with p as (
         select e.device,
           count(distinct e.session)::int as visits,
           count(*) filter (where e.name = 'prompt_send')::int as prompts,
           count(*) filter (where ${built('e')})::int as builds,
           max(e.at) as last_at,
           (array_agg(e.mobile order by e.at desc) filter (where e.mobile is not null))[1] as mobile,
           (array_agg(e.country order by e.at desc) filter (where e.country is not null))[1] as country,
           (array_agg(e.user_id order by e.at desc) filter (where e.user_id is not null))[1] as event_user
         from orb_events e where e.at >= $1::timestamptz group by e.device
         order by last_at desc limit ${PEOPLE}
       )
       select p.*, coalesce(p.event_user, d.user_id) as user_id,
         coalesce(nullif(btrim(u.name), ''), nullif(btrim(d.name), '')) as name,
         (select min(x.at) from orb_events x where x.device = p.device) as first_at,
         (select count(*) from orb_worlds w where w.owner_device = p.device or w.owner_user = coalesce(p.event_user, d.user_id))::int as worlds
       from p left join orb_devices d on d.hash = p.device
       left join orb_users u on u.id = coalesce(p.event_user, d.user_id)
       order by p.last_at desc`,
      since,
    ),
  ]);

  const byDay = new Map(daily.map((r) => [r.day, r]));
  const days: AnalyticsDay[] = [];
  for (let i = range - 1; i >= 0; i--) {
    const day = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const r = byDay.get(day);
    days.push({
      day,
      visitors: n(r?.visitors),
      newVisitors: n(r?.new_visitors),
      visits: n(r?.visits),
      pageViews: n(r?.page_views),
      opens: n(r?.opens),
      prompts: n(r?.prompts),
      builds: n(r?.builds),
      playSeconds: n(r?.play_seconds),
    });
  }
  const t = totals[0] ?? {};
  const f = funnel[0] ?? {};
  const dv = devices[0] ?? {};
  return {
    now,
    range,
    totals: {
      visitors: n(t.visitors),
      newVisitors: days.reduce((s, d) => s + d.newVisitors, 0),
      visits: n(t.visits),
      pageViews: n(t.page_views),
      events: n(t.events),
      avgVisitSeconds: n(t.avg_visit),
      medianVisitSeconds: n(t.median_visit),
      playSeconds: days.reduce((s, d) => s + d.playSeconds, 0),
    },
    days,
    funnel: { came: n(f.came), opened: n(f.opened), prompted: n(f.prompted), built: n(f.built), cameBack: n(f.came_back) },
    worlds: worlds.map((w) => ({
      id: w.world_id,
      name: w.name,
      href: href(w.world_id, w.handle, w.slug),
      author: w.author_name,
      opens: n(w.opens),
      people: n(w.people),
      playSeconds: n(w.play_seconds),
      prompts: n(w.prompts),
      likes: n(w.likes),
      sources: Object.entries(w.sources ?? {})
        .map(([k, v]): [string, number] => [k, n(v)])
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    })),
    events: events.map((e) => ({ name: e.name, count: n(e.count), people: n(e.people) })),
    sources: sources.map((s) => ({ source: s.source, visits: n(s.visits), people: n(s.people) })),
    devices: { phone: n(dv.phone), computer: n(dv.computer), unknown: n(dv.unknown) },
    countries: countries.map((c) => ({ country: c.country, people: n(c.people) })),
    people: people.map((p) => ({
      id: publicDeviceId(p.device),
      name: p.name,
      signedIn: !!p.user_id,
      mobile: p.mobile,
      country: p.country,
      firstAt: iso(p.first_at),
      lastAt: iso(p.last_at),
      visits: n(p.visits),
      prompts: n(p.prompts),
      builds: n(p.builds),
      worlds: n(p.worlds),
    })),
  };
}

/** One person (by public device id) and their latest events; null when they never sent any. */
export async function person(db: Db, id: string): Promise<PersonDetail | null> {
  if (!/^[0-9a-f]{12}$/.test(id)) return null;
  // Hashes are lowercase hex, so every hash starting with `id` sorts before `id` + "g".
  const [s] = await db.query<Record<string, unknown> & { device: string; user_id: string | null; name: string | null; first_at: Date | string; last_at: Date | string; country: string | null; mobile: boolean | null }>(
    `with dev as (select device from orb_events where device >= $1 and device < $2 order by device limit 1),
     e as (select x.* from orb_events x join dev on dev.device = x.device),
     who as (
       select dev.device, d.name as device_name, coalesce((select e.user_id from e where e.user_id is not null order by e.at desc limit 1), d.user_id) as user_id
       from dev left join orb_devices d on d.hash = dev.device
     )
     select who.device, who.user_id, coalesce(nullif(btrim(u.name), ''), nullif(btrim(who.device_name), '')) as name,
       (select min(e.at) from e) as first_at, (select max(e.at) from e) as last_at,
       (select count(*) from e)::int as events, (select count(distinct e.session) from e)::int as visits,
       (select count(*) from e where e.name = 'prompt_send')::int as prompts, (select count(*) from e where ${built('e')})::int as builds,
       (select e.country from e where e.country is not null order by e.at desc limit 1) as country,
       (select e.mobile from e where e.mobile is not null order by e.at desc limit 1) as mobile
     from who left join orb_users u on u.id = who.user_id`,
    [id, `${id}g`],
  );
  if (!s) return null;
  const [worlds, timeline] = await Promise.all([
    db.query<{ id: string; name: string; handle: string | null; slug: string | null; created_at: Date | string; forked_from: string | null; version: number; plays: number; likes: number }>(
      `select w.id, w.name, w.handle, w.slug, w.created_at, w.forked_from, w.version, w.plays, w.likes from orb_worlds w
       where w.owner_device = $1 or w.owner_user = $2::text order by w.created_at desc limit 100`,
      [s.device, s.user_id],
    ),
    db.query<{ id: string | number; at: Date | string; name: string; session: string; path: string | null; world_id: string | null; props: Record<string, PropValue> | null; referrer: string | null; country: string | null; mobile: boolean | null; world_name: string | null; handle: string | null; slug: string | null; from_world: string | null; from_name: string | null; from_handle: string | null; from_slug: string | null }>(
      `select e.id, e.at, e.name, e.session, e.path, e.world_id, e.props, e.referrer, e.country, e.mobile, w.name as world_name, w.handle, w.slug,
         e.props->>'from_world' as from_world, f.name as from_name, f.handle as from_handle, f.slug as from_slug
       from orb_events e left join orb_worlds w on w.id = e.world_id left join orb_worlds f on f.id = e.props->>'from_world'
       where e.device = $1 order by e.at desc, e.id desc limit ${TIMELINE}`,
      [s.device],
    ),
  ]);
  return {
    now: Date.now(),
    id,
    name: s.name,
    signedIn: !!s.user_id,
    mobile: s.mobile,
    country: s.country,
    firstAt: iso(s.first_at),
    lastAt: iso(s.last_at),
    events: n(s.events),
    visits: n(s.visits),
    prompts: n(s.prompts),
    builds: n(s.builds),
    worlds: worlds.map((w) => ({ id: w.id, name: w.name, href: href(w.id, w.handle, w.slug), createdAt: iso(w.created_at), remix: !!w.forked_from, version: n(w.version), plays: n(w.plays), likes: n(w.likes) })),
    timeline: timeline.map((e) => ({
      id: String(e.id),
      at: iso(e.at),
      name: e.name,
      session: e.session,
      path: e.path,
      world: e.world_id ? { id: e.world_id, name: e.world_name, href: href(e.world_id, e.handle, e.slug) } : null,
      from: e.from_world ? { id: e.from_world, name: e.from_name, href: href(e.from_world, e.from_handle, e.from_slug) } : null,
      props: e.props,
      referrer: e.referrer,
      country: e.country,
      mobile: e.mobile,
    })),
  };
}
