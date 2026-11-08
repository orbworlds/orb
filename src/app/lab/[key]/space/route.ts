// GET /lab/<key>/space: where the database's space goes, read-only. World files (orb_blobs) still
// used — by a tree a world, one of its kept versions, a build or a GitHub sync points at — against
// those nothing uses any more (a build's intermediate versions, an upload that never went in a
// world), and traces by age. Sizes are the files' own bytes (Postgres may store them compressed).

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
  return Response.json({ files, traces, jobs }, { headers: { 'cache-control': 'no-store' } });
}
