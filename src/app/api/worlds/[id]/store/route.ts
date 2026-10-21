// POST /api/worlds/:id/store — the shared world store behind `orb.store` (SPEC §7).
// Body: StoreRequest { op: get|set|incr|push|merge|list, key, value?, by?, max? } → { value }
// (list: key is the prefix; value comes back as { key: value } of up to 200 keys).
// Native worlds only; private worlds only for their owner; 120 ops/min per device per world (a list counts 5).

import { getViewer } from '@/server/auth';
import { clientIp, fail, handle, json, readJson } from '@/server/http';
import { ready } from '@/server/schema';
import { storeOp, worldIdParam, type IdContext } from '@/server/worlds';

export const POST = handle(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  // Values are capped at 8 KB; leave room for the envelope and JSON escaping.
  const body = await readJson<unknown>(req, 64_000);
  if (body === null) fail(400, 'bad_request', 'Expected a JSON body (or it was too large).');
  const db = await ready();
  const value = await storeOp(db, getViewer(req), id, body, clientIp(req));
  return json({ value });
});
