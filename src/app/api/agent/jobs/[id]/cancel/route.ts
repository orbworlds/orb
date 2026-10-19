// POST /api/agent/jobs/:id/cancel — the user pressed Stop. The running tick notices within a
// moment, saves what was built so far and ends the job (closing the page does not stop it).

import { after } from 'next/server';
import { getViewer } from '@/server/auth';
import { cancelJob, isJobId, ownsJob } from '@/server/buildjobs';
import { error, handle, json } from '@/server/http';
import { ready } from '@/server/schema';
import { jobInfo, kick } from '@/server/agent/runner';

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  if (!isJobId(id)) return error(400, 'bad_request', 'Bad job id.');
  const db = await ready();
  if (!(await ownsJob(db, id, getViewer(req)))) return error(404, 'not_found', 'That build is gone.');
  await cancelJob(db, id);
  // No tick running right now: start one, so the job is wrapped up (and its work saved).
  const info = await jobInfo(db, id);
  if (info?.idle) after(() => kick(info.origin, id));
  return json({ ok: true });
});
