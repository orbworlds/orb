// POST /api/admin/agent-cron — (admin) schedule the minute backstop for agent jobs inside the
// database: pg_cron calls /api/cron/agent through pg_net every minute while a build runs (every
// 10 minutes otherwise), so long jobs keep going with no page open (see the note in that route).
// Idempotent. GET shows the current schedule.

import { isAdmin } from '@/server/auth';
import { error, json } from '@/server/http';
import { ready } from '@/server/schema';

const JOB = 'orb-agent-backstop';

export async function POST(req: Request): Promise<Response> {
  if (!isAdmin(req)) return error(401, 'unauthorized', 'Admin token required.');
  const db = await ready();
  const url = `${new URL(req.url).origin}/api/cron/agent`;
  const steps: Array<[string, string]> = [
    ['pg_net', `create extension if not exists pg_net with schema extensions`],
    ['pg_cron', `create extension if not exists pg_cron with schema pg_catalog`],
  ];
  const log: Record<string, string> = {};
  for (const [name, sql] of steps) {
    try {
      await db.query(sql);
      log[name] = 'ok';
    } catch (e) {
      log[name] = (e as Error).message;
    }
  }
  try {
    // Only when it has something to do: a build is running (every minute), else every 10 minutes for
    // the housekeeping (hosting curated worlds). Each call is a function run, and those cost.
    const command = `select net.http_get(url := '${url.replace(/'/g, "''")}', timeout_milliseconds := 60000)
      where exists (select 1 from orb_agent_jobs where status = 'running') or extract(minute from now())::int % 10 = 0`;
    const rows = await db.query<{ id: number }>(`select cron.schedule($1, '* * * * *', $2) as id`, [JOB, command]);
    log.schedule = `ok (job ${rows[0]?.id})`;
  } catch (e) {
    log.schedule = (e as Error).message;
  }
  return json({ url, ...log });
}

export async function GET(req: Request): Promise<Response> {
  if (!isAdmin(req)) return error(401, 'unauthorized', 'Admin token required.');
  const db = await ready();
  try {
    const jobs = await db.query(`select jobid, jobname, schedule, command, active from cron.job where jobname = $1`, [JOB]);
    const runs = await db.query(
      `select status, return_message, start_time from cron.job_run_details where jobid in (select jobid from cron.job where jobname = $1) order by start_time desc limit 5`,
      [JOB],
    );
    return json({ jobs, runs });
  } catch (e) {
    return json({ error: (e as Error).message });
  }
}
