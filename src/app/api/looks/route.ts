// GET /api/looks — Orb's things for the blob, what the account owns and wears, and its credits.
// PATCH /api/looks { color?, wear? } (signed in) — the blob's color (null: this device's) and what it
// wears, of the things the account has (src/server/looks.ts).

import { getViewer } from '@/server/auth';
import { handle, json, readJson } from '@/server/http';
import { looksView, setLook } from '@/server/looks';
import { ready } from '@/server/schema';
import { limitOrThrow } from '@/server/worlds';

export const GET = handle(async (req: Request) => {
  const db = await ready();
  return json(await looksView(db, getViewer(req)), { headers: { 'cache-control': 'private, no-store' } });
});

export const PATCH = handle(async (req: Request) => {
  const viewer = getViewer(req);
  const body = await readJson<unknown>(req, 10_000);
  const db = await ready();
  await limitOrThrow(db, `looks:${viewer.userId ?? viewer.deviceHash ?? 'anon'}`, 60, 600);
  return json(await setLook(db, viewer, body));
});
