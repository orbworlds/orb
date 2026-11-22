// GET /lab/<key>/space: where the database's space goes, read-only. World files (orb_blobs) still
// used — by a tree a world, one of its kept versions, a build or a GitHub sync points at — against
// those nothing uses any more (a build's intermediate versions, an upload that never went in a
// world), and traces by age. Then by world: the worlds whose files take the most (all their
// versions; `now_bytes` their current one, `own_bytes` files no other world has), by kind of file,
// and the biggest files. Sizes are the files' own bytes (Postgres may store them compressed).
//
// POST /lab/<key>/space {do}: make room.
// - "github": the curated games whose files could come from GitHub, by bytes; with `world`, move
//   that one's (src/server/ghfiles.ts).
// - "prune": forget traces older than `days` (14; the nightly backup has them) and files nothing
//   uses (src/server/files.ts pruneFiles), as many as fit in a few minutes.
// - "vacuum": give a table's free space back (VACUUM FULL `table`): it copies what's left, so the
//   files table only once most of it has moved.

import { MOVE_MIN, moveToGitHub } from '@/server/ghfiles';
import { pruneFiles } from '@/server/files';
import { LAB_KEY } from '@/server/lab';
import { ready } from '@/server/schema';
import { SEEDS } from '@/server/seed';
import { pruneTraces } from '@/server/traces';
import { plain } from '../ndjson';

export const maxDuration = 300;

export async function GET(_req: Request, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  const { key } = await ctx.params;
  if (key !== LAB_KEY) return plain(404, 'Not found');
  const db = await ready();
  const [files] = await db.query<Record<string, number>>(
    `with live_trees as (
       select tree as sha from orb_worlds where tree is not null
       union select tree from orb_world_versions where tree is not null
       union select unnest(array[base_tree, tree, committed_tree, saved_tree]) from orb_agent_jobs
       union select synced_tree from orb_world_repos where synced_tree is not null
     ), live_blobs as (
       select distinct f.value as sha from orb_trees t join live_trees l on l.sha = t.sha, jsonb_each_text(t.files) as f
     )
     select count(*)::float8 as blobs, coalesce(sum(b.size), 0)::float8 as bytes,
       count(lb.sha)::float8 as used, coalesce(sum(b.size) filter (where lb.sha is not null), 0)::float8 as used_bytes,
       coalesce(sum(b.size) filter (where lb.sha is null and b.created_at < now() - interval '2 days'), 0)::float8 as unused_old_bytes,
       (select count(*) from orb_trees)::float8 as trees, (select count(*) from orb_trees t where not exists (select 1 from live_trees l where l.sha = t.sha))::float8 as unused_trees
     from orb_blobs b left join live_blobs lb on lb.sha = b.sha`,
  );
  const [traces] = await db.query<Record<string, number>>(
    `select count(*)::float8 as traces, count(*) filter (where started_at < now() - interval '14 days')::float8 as older_14d,
       (select coalesce(sum(size), 0) from orb_trace_events)::float8 as event_bytes,
       (select coalesce(sum(size), 0) from orb_trace_events e join orb_traces t on t.id = e.trace_id where t.started_at < now() - interval '14 days')::float8 as event_bytes_older_14d,
       (select coalesce(sum(size), 0) from orb_trace_blobs)::float8 as blob_bytes,
       (select coalesce(sum(size), 0) from orb_trace_blobs where used_at < now() - interval '14 days')::float8 as blob_bytes_unused_14d
     from orb_traces`,
  );
  const [jobs] = await db.query<Record<string, number>>(
    `select count(*)::float8 as jobs, count(*) filter (where created_at < now() - interval '30 days')::float8 as older_30d,
       pg_total_relation_size('orb_agent_jobs')::float8 as bytes from orb_agent_jobs`,
  );
  // Each world's files: what its current tree, kept versions, builds and GitHub sync point at.
  const WB = `with refs as (
       select id as world_id, tree as sha, true as now from orb_worlds where tree is not null
       union all select world_id, tree, false from orb_world_versions where tree is not null
       union all select world_id, unnest(array[base_tree, tree, committed_tree, saved_tree]), false from orb_agent_jobs
       union all select world_id, synced_tree, false from orb_world_repos where synced_tree is not null
     ), wb as (
       select r.world_id, f.value as sha, bool_or(r.now) as now, min(f.key) as path
       from refs r join orb_trees t on t.sha = r.sha, jsonb_each_text(t.files) as f
       group by r.world_id, f.value
     ), shared as (select sha, count(*) as worlds, bool_or(now) as now, min(path) as path from wb group by sha)`;
  const worlds = await db.query(
    `${WB}
     select wb.world_id as id, w.name, w.kind, w.visibility, w.hidden, w.plays, w.version, w.owner_user is not null as account,
       to_char(w.created_at, 'YYYY-MM-DD') as created, count(*)::int as files, sum(b.size)::float8 as bytes,
       coalesce(sum(b.size) filter (where wb.now), 0)::float8 as now_bytes, coalesce(sum(b.size) filter (where s.worlds = 1), 0)::float8 as own_bytes
     from wb join orb_blobs b on b.sha = wb.sha join shared s on s.sha = wb.sha join orb_worlds w on w.id = wb.world_id
     group by wb.world_id, w.name, w.kind, w.visibility, w.hidden, w.plays, w.version, w.owner_user, w.created_at
     order by bytes desc limit 40`,
  );
  const [split] = await db.query<Record<string, number>>(
    `${WB}
     select coalesce(sum(b.size) filter (where s.now), 0)::float8 as current_bytes, coalesce(sum(b.size) filter (where not s.now), 0)::float8 as history_bytes,
       (select count(distinct world_id) from wb)::float8 as world_count
     from shared s join orb_blobs b on b.sha = s.sha`,
  );
  const types = await db.query(
    `${WB}
     select coalesce(lower(substring(s.path from '\\.([A-Za-z0-9]+)$')), '(none)') as ext, count(*)::int as files, sum(b.size)::float8 as bytes,
       coalesce(sum(b.size) filter (where s.now), 0)::float8 as current_bytes
     from shared s join orb_blobs b on b.sha = s.sha group by 1 order by bytes desc limit 15`,
  );
  const biggest = await db.query(
    `${WB}
     select s.path, b.size::float8 as bytes, s.worlds::int as worlds, s.now, (select min(world_id) from wb x where x.sha = s.sha) as world
     from shared s join orb_blobs b on b.sha = s.sha order by b.size desc limit 20`,
  );
  return Response.json({ files, traces, jobs, byWorld: { ...split, worlds, types, biggest } }, { headers: { 'cache-control': 'no-store' } });
}

const VACUUM = ['orb_blobs', 'orb_trees', 'orb_traces', 'orb_trace_events', 'orb_trace_blobs'];

export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  const { key } = await ctx.params;
  if (key !== LAB_KEY) return plain(404, 'Not found');
  const body = (await req.json().catch(() => null)) as { do?: unknown; world?: unknown; days?: unknown; table?: unknown } | null;
  const db = await ready();
  const answer = (v: unknown) => Response.json(v, { headers: { 'cache-control': 'no-store' } });
  if (body?.do === 'github') {
    if (typeof body.world === 'string') {
      try {
        return answer(await moveToGitHub(db, body.world));
      } catch (e) {
        return plain(502, `Moving ${body.world}'s files failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const curated = SEEDS.filter((s) => s.source_url?.startsWith('https://github.com/')).map((s) => s.id);
    const worlds = await db.query(
      `select w.id, w.name, sum(b.size)::float8 as bytes from orb_worlds w join orb_trees t on t.sha = w.tree
         cross join lateral (select distinct value from jsonb_each_text(t.files)) f join orb_blobs b on b.sha = f.value
       where w.id = any($1::text[]) and b.source is null and b.size >= $2 group by w.id, w.name order by bytes desc`,
      [curated, MOVE_MIN],
    );
    return answer({ worlds });
  }
  if (body?.do === 'prune') {
    const days = typeof body.days === 'number' && body.days >= 7 ? body.days : 14;
    const until = Date.now() + 240_000;
    let traces = 0;
    for (let n = 1; n && Date.now() < until; traces += n) n = await pruneTraces(db, days);
    // Files traces copied that no trace has used since (pruneTraces takes a few per call).
    let traceFiles = 0;
    for (let n = 1; n && Date.now() < until; traceFiles += n) {
      n = (await db.query(`delete from orb_trace_blobs where sha in (select sha from orb_trace_blobs where used_at < now() - ($1::float8 * interval '1 day') limit 5000) returning sha`, [days])).length;
    }
    const files = { trees: 0, blobs: 0, bytes: 0 };
    for (let more = true; more && Date.now() < until; ) {
      const r = await pruneFiles(db, 2000);
      files.trees += r.trees;
      files.blobs += r.blobs;
      files.bytes += r.bytes;
      more = r.trees + r.blobs > 0;
    }
    return answer({ traces, traceFiles, files, done: Date.now() < until });
  }
  if (body?.do === 'vacuum' && typeof body.table === 'string' && VACUUM.includes(body.table)) {
    if (body.table === 'orb_blobs') {
      const [kept] = await db.query<{ bytes: number }>(`select coalesce(sum(size), 0)::float8 as bytes from orb_blobs where source is null`);
      if (kept.bytes > 400e6) return plain(409, `The files table still holds ${Math.round(kept.bytes / 1e6)} MB: a full vacuum copies that, more than the disk has free.`);
    }
    const size = async () => Number((await db.query<{ b: number }>(`select pg_total_relation_size($1::regclass)::float8 as b`, [body.table]))[0].b);
    const before = await size();
    await db.query(`vacuum full ${body.table}`);
    return answer({ table: body.table, before, after: await size() });
  }
  if (body?.do === 'disk') {
    // Read-only: why the database may be read-only (Supabase turns it so at 95% of the disk).
    const ask = async (label: string, sql: string) => {
      try {
        return [label, await db.query(sql)] as const;
      } catch (e) {
        return [label, `failed: ${e instanceof Error ? e.message : String(e)}`] as const;
      }
    };
    return answer(Object.fromEntries(await Promise.all([
      ask('database', `select pg_database_size(current_database())::float8 as bytes, current_setting('default_transaction_read_only') as read_only`),
      ask('wal', `select count(*)::int as files, coalesce(sum(size), 0)::float8 as bytes from pg_ls_waldir()`),
      ask('slots', `select slot_name, slot_type, active, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::float8 as retained from pg_replication_slots`),
      ask('settings', `select name, setting, unit from pg_settings where name in ('max_wal_size', 'min_wal_size', 'wal_keep_size', 'checkpoint_timeout', 'max_slot_wal_keep_size')`),
    ])));
  }
  if (body?.do === 'clear-traces') {
    // Every build trace at once (the nightly backup has them): TRUNCATE gives their disk back
    // straight away, which a DELETE can't, even with the database read-only (one transaction may write).
    try {
      await db.query(`begin read write; truncate orb_trace_events, orb_trace_blobs, orb_traces; commit;`);
      return answer({ cleared: true });
    } catch (e) {
      return plain(502, `clearing traces failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (body?.do === 'checkpoint') {
    // Lets Postgres drop the write-ahead log it no longer needs (frees disk, changes no data).
    try {
      await db.query(`checkpoint`);
      return answer({ checkpoint: true });
    } catch (e) {
      return plain(502, `checkpoint failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return plain(400, 'Expected {do: "github" | "prune" | "vacuum" | "disk" | "checkpoint" | "clear-traces", world?, days?, table?}.');
}
