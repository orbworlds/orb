// Backstop for agent jobs: restart jobs that are running but that no tick holds — a tick that
// died, or a hand-over the platform refused (Vercel stops a function from calling itself more
// than a few times in a row, so long jobs rely on a request from outside every so often).
// Called by a database cron (pg_cron + pg_net, see /api/admin/agent-cron): every minute while a
// build runs, every 10 minutes otherwise. Safe to call by anyone: it only kicks idle jobs (as
// watching pages do), and it is rate limited.

import { error, json } from '@/server/http';
import { rateLimit } from '@/server/ratelimit';
import { ready } from '@/server/schema';
import { idleJobs, kick } from '@/server/agent/runner';
import { convertSeeds } from '@/server/seed';

export const maxDuration = 300; // hosting a big open-source world takes a while

export async function GET(): Promise<Response> {
  const db = await ready();
  const r = await rateLimit(db, 'cron:agent', 4, 60);
  if (!r.ok) return error(429, 'rate_limited', 'Too often.', { retryAfter: r.retryAfter });
  const jobs = await idleJobs(db);
  const kicked = await Promise.all(jobs.map((j) => kick(j.origin, j.id, db)));
  // Housekeeping while we're here: host one more curated open-source world, if any is waiting.
  const seeds = await convertSeeds(db, 1).catch((e) => ({ error: (e as Error).message }));
  return json({ idle: jobs.length, kicked: kicked.filter(Boolean).length, seeds });
}

export const POST = GET;
