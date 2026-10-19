// GET /api/agent/jobs/:id?from=N — follow an agent job's output from character N (after a reload,
// a dropped connection, or the previous request's time limit). See src/server/agent/follow.ts.

import { getViewer } from '@/server/auth';
import { isJobId, ownsJob } from '@/server/buildjobs';
import { clientIp, error, handle } from '@/server/http';
import { rateLimit } from '@/server/ratelimit';
import { ready } from '@/server/schema';
import { followJob } from '@/server/agent/follow';

export const maxDuration = 300;

export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  if (!isJobId(id)) return error(400, 'bad_request', 'Bad job id.');
  const fromRaw = Number(new URL(req.url).searchParams.get('from') ?? 0);
  const from = Number.isFinite(fromRaw) ? Math.max(0, Math.floor(fromRaw)) : 0;
  const db = await ready();
  const viewer = getViewer(req);
  const r = await rateLimit(db, `jobfollow:${viewer.deviceHash ?? clientIp(req)}`, 240, 3600);
  if (!r.ok) return error(429, 'rate_limited', 'Slow down a little — try again in a moment.', { retryAfter: r.retryAfter });
  if (!(await ownsJob(db, id, viewer))) return error(404, 'not_found', 'That build is gone.');
  return followJob(req, db, id, from);
});
