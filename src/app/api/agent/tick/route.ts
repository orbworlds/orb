// POST /api/agent/tick { id } — run the next tick of an agent job (internal: called by the job
// itself, by watching pages' follow requests and by the cron, with an HMAC token). Answers at once;
// the tick runs on after the response (up to the function's time limit), then chains the next one.

import { after } from 'next/server';
import { isJobId } from '@/server/buildjobs';
import { error, json, readJson } from '@/server/http';
import { ready } from '@/server/schema';
import { checkTickToken, jobInfo, kick, runTick } from '@/server/agent/runner';

export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const body = await readJson<{ id?: unknown }>(req, 1000);
  const id = body?.id;
  if (!isJobId(id) || !checkTickToken(id, req.headers.get('x-orb-tick'))) return error(403, 'forbidden', 'Not allowed.');
  const db = await ready();
  const work = runTick(db, id)
    .then(async (r) => {
      if (r === 'continue') await kick((await jobInfo(db, id))?.origin ?? null, id, db);
    })
    .catch((e) => console.error('[orb] agent tick failed', e));
  after(() => work);
  return json({ ok: true }, { status: 202 });
}
