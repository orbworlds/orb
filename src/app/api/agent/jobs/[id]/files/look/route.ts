// POST /api/agent/jobs/:id/files/look?t=…&base=… — a Cursor agent looks at the world (sh .orb/look,
// see src/server/agent/sync.ts). It sends its files the way it saves them, with what to do first;
// they are shown, not saved. The job's tick asks a page that watches the build to play them
// (src/server/agent/look.ts), and this answers with what the page saw: a .tar.gz of report.txt and
// the screenshots, or plain words when there is nothing to see.

import { cleanProbeActions, probeDuration } from '@/lib/probe';
import { FileError, getTree, isSha } from '@/server/files';
import { handle } from '@/server/http';
import { rateLimit } from '@/server/ratelimit';
import { LOOK_OVERHEAD_MS, lookCount, lookRefusal, MAX_LOOKS, missedLook, openLook, seenFiles, trimLooks, waitForLook } from '@/server/agent/look';
import { linkedJob, packSeen, readSave, sayText as say } from '@/server/agent/sync';

export const maxDuration = 150;

/** The job's tick passes a look on to the pages within seconds (a little longer while one tick hands over to the next). */
const PICKUP_MS = 15_000;

/** What the agent asked to do first: JSON — an object with actions and viewport, or just the actions. */
function parseRequest(raw: string | undefined): { input: { actions?: unknown; viewport?: unknown } } | { error: string } {
  const text = (raw ?? '').trim();
  if (!text) return { input: {} };
  try {
    const v: unknown = JSON.parse(text);
    if (Array.isArray(v)) return { input: { actions: v } };
    if (v && typeof v === 'object') return { input: v };
  } catch {
    /* not JSON */
  }
  return { error: `Can't look: what to do first must be JSON, like {"actions":[{"type":"key","key":"w","ms":800}]} — not ${JSON.stringify(text.slice(0, 80))}.` };
}

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const found = await linkedJob(req, id);
  if ('answer' in found) return found.answer;
  const { db, job } = found;
  if (job.mode !== 'build') return say(403, "Can't look: this build only answers questions about the world.");
  const r = await rateLimit(db, `agentlooks:${id}`, MAX_LOOKS, 3600);
  if (!r.ok) return say(429, "Can't look: that's a lot of looks — wait a minute, then look again.");
  if (!req.body) return say(400, "Can't look: send the files as a .tar.gz (sh .orb/look does).");
  const base = new URL(req.url).searchParams.get('base');
  const baseTree = (isSha(base) && (await getTree(db, base))) || {};
  let sent;
  try {
    sent = await readSave(db, req.body, baseTree, { look: true });
  } catch (e) {
    if (e instanceof FileError) return say(400, `Can't look: ${e.message}`);
    throw e;
  }
  if (!sent.entry) return say(400, "Can't look yet: there is no index.html, and the world needs it to run.");
  const asked = parseRequest(sent.request);
  if ('error' in asked) return say(400, asked.error);
  const { actions, skipped } = cleanProbeActions(asked.input.actions);

  const looks = await lookCount(db, id);
  const refused = await lookRefusal(db, id, looks);
  if (refused) return say(200, refused);
  const lookId = await openLook(db, id, { tree: sent.tree, actions, skipped, ...(asked.input.viewport === 'phone' ? { viewport: 'phone' as const } : {}) });
  const answer = await waitForLook(db, id, lookId, { timeoutMs: probeDuration(actions) + LOOK_OVERHEAD_MS + PICKUP_MS, signal: req.signal });
  if (!('result' in answer)) return say(200, missedLook(answer, req.signal.aborted));
  await trimLooks(db, id).catch((e) => console.error('[orb] agent looks trim failed', e));
  const seen = packSeen(seenFiles(lookId, answer.result, skipped, MAX_LOOKS - looks - 1));
  return new Response(new Uint8Array(seen), { headers: { 'content-type': 'application/gzip', 'cache-control': 'no-store' } });
});
