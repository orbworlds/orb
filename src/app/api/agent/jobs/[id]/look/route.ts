// POST /api/agent/jobs/:id/look — a page watching an agent job answers one of its looks (see
// src/server/agent/look.ts): { id, result } with what it saw in the world, or { id, unavailable }
// when it can't (the world isn't on screen, the tab is in the background…). 409 when that look is
// already over. Only the page of whoever started the job answers (like following it).

import { getViewer } from '@/server/auth';
import { isJobId, ownsJob } from '@/server/buildjobs';
import { clientIp, error, handle, json, readJson } from '@/server/http';
import { rateLimit } from '@/server/ratelimit';
import { ready } from '@/server/schema';
import { answerLook, isLookId } from '@/server/agent/look';

/** A look's answer: up to a few screenshots (~100–400 KB each) plus text. */
const MAX_BODY = 4_000_000;

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  if (!isJobId(id)) return error(400, 'bad_request', 'Bad job id.');
  const body = await readJson<{ id?: unknown; result?: unknown; unavailable?: unknown }>(req, MAX_BODY);
  if (!body || !isLookId(body.id) || (typeof body.unavailable !== 'string' && (!body.result || typeof body.result !== 'object'))) {
    return error(400, 'bad_request', 'Expected { id, result } or { id, unavailable }.');
  }
  const db = await ready();
  const viewer = getViewer(req);
  const r = await rateLimit(db, `agentlook:${viewer.deviceHash ?? clientIp(req)}`, 600, 3600);
  if (!r.ok) return error(429, 'rate_limited', 'Slow down a little — try again in a moment.', { retryAfter: r.retryAfter });
  if (!(await ownsJob(db, id, viewer))) return error(404, 'not_found', 'That build is gone.');
  if (!(await answerLook(db, id, body.id, body))) return error(409, 'gone', 'That look is over.');
  return json({ ok: true });
});
