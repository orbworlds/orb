// POST /api/kit/approve { code } → { name }: the viewer lets the Orb kit that showed this code push
// worlds as them (this device, and their account if signed in). See src/server/kit.ts.

import { getViewer } from '@/server/auth';
import { clientIp, json, readJson } from '@/server/http';
import { approveLogin } from '@/server/kit';
import { ready } from '@/server/schema';
import { actorKey, fail, limitOrThrow, route } from '@/server/worlds';

export const POST = route(async (req: Request) => {
  const body = await readJson<{ code?: unknown }>(req, 1000);
  if (typeof body?.code !== 'string') fail(400, 'bad_request', 'Expected { code }.');
  const viewer = getViewer(req);
  const db = await ready();
  await limitOrThrow(db, `kitapprove:${actorKey(viewer, clientIp(req))}`, 20, 600);
  return json(await approveLogin(db, viewer, body.code));
});
