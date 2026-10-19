// Where a build's output lives: every build is an agent job (./agent/runner.ts) whose output —
// Orb protocol text plus control frames — is appended to orb_build_chunks as it goes, so any page
// can follow it from any offset (GET /api/agent/jobs/:id?from=N), after a reload, on any device.
// Only an explicit Stop (POST …/cancel) ends a job early. Job ids are unguessable (128 random
// bits), and only whoever started a job follows, stops or answers it; rows are swept after eight days.

import { randomBytes } from 'node:crypto';
import type { Viewer } from './auth';
import type { Db } from './db';
import { pruneTraces } from './traces';

/** Control frames inside a build stream (never model text; the client strips them). */
export const CONTROL = '\u001e';
export const control = (frame: Record<string, unknown>) => `${CONTROL}${JSON.stringify(frame)}\n`;

export const newJobId = () => randomBytes(16).toString('base64url');
export const isJobId = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{20,40}$/.test(s);

/** Output chunks after `afterSeq`, in order. */
export async function jobChunks(db: Db, id: string, afterSeq: number): Promise<Array<{ seq: number; text: string }>> {
  return db.query<{ seq: number; text: string }>(`select seq, text from orb_build_chunks where job_id = $1 and seq > $2 order by seq`, [id, afterSeq]);
}

/**
 * Whether the viewer started this agent job: its device, its account, or an account that device
 * belongs to (the same rule as owning a world). False when there's no such job.
 */
export async function ownsJob(db: Db, id: string, viewer: Viewer): Promise<boolean> {
  if (!viewer.deviceHash && !viewer.userId) return false;
  const rows = await db.query(
    `select 1 from orb_agent_jobs j where j.id = $1 and (j.owner_device = $2::text or j.owner_user = $3::text
       or j.owner_user = (select d.user_id from orb_devices d where d.hash = $2::text)
       or j.owner_device in (select d.hash from orb_devices d where d.user_id = $3::text))`,
    [id, viewer.deviceHash, viewer.userId],
  );
  return rows.length > 0;
}

export async function cancelJob(db: Db, id: string): Promise<void> {
  await db.query(`update orb_build_jobs set cancelled = true where id = $1`, [id]);
}

export async function sweepJobs(db: Db): Promise<number> {
  // A long agent job (it can run for days) is kept while it is still alive.
  const rows = await db.query<{ id: string }>(
    `delete from orb_build_jobs where created_at < now() - interval '8 days' and (done or updated_at < now() - interval '1 day') returning id`,
  );
  await pruneTraces(db).catch((e) => console.error('[orb] trace prune failed', e instanceof Error ? e.message : e));
  return rows.length;
}
