// POST /api/admin/seeds — (admin) host the code of curated open-source worlds that are still
// embedded by URL (see convertSeeds in src/server/seed.ts). Body { limit? (default 3), again?: ids
// to import once more }.
// The minute cron does the same one world at a time, so this is only needed to hurry it.

import { isAdmin } from '@/server/auth';
import { error, json, readJson } from '@/server/http';
import { ready } from '@/server/schema';
import { convertSeeds } from '@/server/seed';

export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  if (!isAdmin(req)) return error(401, 'unauthorized', 'Admin token required.');
  const body = await readJson<{ limit?: number; again?: unknown }>(req, 2000);
  const limit = Math.min(10, Math.max(1, Number(body?.limit) || 3));
  const again = Array.isArray(body?.again) ? body.again.filter((x): x is string => typeof x === 'string').slice(0, 20) : [];
  return json(await convertSeeds(await ready(), limit, again));
}
