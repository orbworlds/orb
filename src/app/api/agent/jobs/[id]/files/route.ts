// GET/PUT /api/agent/jobs/:id/files?t=… — a Cursor agent (the free builder on Orb's own Cursor
// key, or a person's own key) downloads the world's files here and saves its work back (see
// src/server/agent/sync.ts). `t` is the job's files token; both work only while the job runs.
// GET: the files as a .tar.gz with .orb/save and .orb/look. PUT (?base=<tree it downloaded>): a
// save, answered in plain words for the agent's terminal.

import { FileError, getTree, isSha } from '@/server/files';
import { handle } from '@/server/http';
import { requestOrigin } from '@/server/origins';
import { rateLimit } from '@/server/ratelimit';
import { filesUrl, linkedJob, lookUrl, packWorld, readSave, sayText as say } from '@/server/agent/sync';

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const found = await linkedJob(req, id);
  if ('answer' in found) return found.answer;
  const { db, job } = found;
  const r = await rateLimit(db, `agentfiles:${id}`, 120, 3600);
  if (!r.ok) return say(429, 'Too many downloads: keep working on the files you have.');
  const sha = job.inbox ?? job.tree;
  const files = (sha && (await getTree(db, sha))) || {};
  const { origin } = requestOrigin(req);
  const links = job.mode === 'build' ? { save: `${filesUrl(origin, id)}&base=${sha ?? ''}`, look: `${lookUrl(origin, id)}&base=${sha ?? ''}` } : null;
  return new Response(packWorld(db, files, links), { headers: { 'content-type': 'application/gzip', 'cache-control': 'no-store' } });
});

export const PUT = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const found = await linkedJob(req, id);
  if ('answer' in found) return found.answer;
  const { db, job } = found;
  if (job.mode !== 'build') return say(403, 'Not saved: this build only answers questions about the world.');
  const r = await rateLimit(db, `agentsave:${id}`, 300, 3600);
  if (!r.ok) return say(429, 'Not saved: too many saves — wait a minute, then save again.');
  if (!req.body) return say(400, 'Not saved: send the files as a .tar.gz (sh .orb/save does).');
  const base = new URL(req.url).searchParams.get('base');
  const baseTree = (isSha(base) && (await getTree(db, base))) || {};
  let saved;
  try {
    saved = await readSave(db, req.body, baseTree);
  } catch (e) {
    if (e instanceof FileError) return say(400, `Not saved: ${e.message}`);
    throw e;
  }
  if (!saved.files) return say(400, 'Not saved: there are no files.');
  if (saved.tree === base) return say(200, 'Nothing to save yet: the files are the same as when you got them. If you just changed some, save again once they are written.');
  await db.query(`update orb_agent_jobs set inbox = $2 where id = $1 and status = 'running'`, [id, saved.tree]);
  const files = `${saved.files} file${saved.files === 1 ? '' : 's'}, ${saved.changed} changed`;
  return say(200, saved.entry ? `Saved to Orb (${files}). The person sees it now.` : `Saved to Orb (${files}), but there is no index.html yet: the world needs it to run.`);
});
