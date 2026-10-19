// POST /api/here { worldId } — "I'm in this world" (a public one on screen), the heartbeat a visible
// page sends every 45 s while a world is open; { worldId: null } when it isn't any more → { ok }.
// Explore shows how many are in each world right now (WorldCard.live).
import { getViewer } from '@/server/auth';
import { clientIp, json, readJson } from '@/server/http';
import { ready } from '@/server/schema';
import { actorKey, limitOrThrow, markHere, route } from '@/server/worlds';

export const POST = route(async (req: Request) => {
  const viewer = getViewer(req);
  const body = await readJson<{ worldId?: unknown }>(req, 1000);
  const db = await ready();
  await limitOrThrow(db, `here:${actorKey(viewer, clientIp(req))}`, 12, 60);
  await markHere(db, viewer, typeof body?.worldId === 'string' ? body.worldId : null);
  return json({ ok: true });
});
