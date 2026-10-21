// POST /api/friends/read { ids? } — mark notifications read (these, or all) → { ok }.

import { getViewer } from '@/server/auth';
import { accountId, markRead } from '@/server/friends';
import { handle, json, readJson } from '@/server/http';
import { ready } from '@/server/schema';
import { limitOrThrow } from '@/server/worlds';

export const POST = handle(async (req: Request) => {
  const db = await ready();
  const me = await accountId(db, getViewer(req));
  const body = await readJson<{ ids?: unknown }>(req, 20_000);
  await limitOrThrow(db, `friends:act:${me}`, 60, 60);
  await markRead(db, me, body?.ids);
  return json({ ok: true });
});
