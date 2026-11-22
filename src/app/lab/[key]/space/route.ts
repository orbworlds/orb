// GET /lab/<key>/space: where the database's space goes, read-only. World files (orb_blobs) still
// used — by a tree a world, one of its kept versions, a build or a GitHub sync points at — against
// those nothing uses any more (a build's intermediate versions, an upload that never went in a
// world), and traces by age. Then by world: the worlds whose files take the most (all their
// versions; `now_bytes` their current one, `own_bytes` files no other world has), by kind of file,
// and the biggest files. Sizes are the files' own bytes (Postgres may store them compressed).

import { LAB_KEY } from '@/server/lab';
import { ready } from '@/server/schema';
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
