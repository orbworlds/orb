// POST /lab/<key>/hide {worlds: "<ids or links, one per line>", hidden: boolean}: keep worlds out of
// Explore, or let them back in (src/server/moderation.ts). Answers with the ids it changed.

import { LAB_KEY } from '@/server/lab';
import { hideWorlds } from '@/server/moderation';
import { ready } from '@/server/schema';
import { plain } from '../ndjson';

export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  const { key } = await ctx.params;
  if (key !== LAB_KEY) return plain(404, 'Not found');
  const body = (await req.json().catch(() => null)) as { worlds?: unknown; hidden?: unknown } | null;
  if (!body || typeof body.worlds !== 'string' || typeof body.hidden !== 'boolean') return plain(400, 'Expected {worlds: string, hidden: boolean}.');
  const refs = body.worlds.split(/[\s,]+/).filter(Boolean).slice(0, 500);
  const ids = await hideWorlds(await ready(), refs, body.hidden);
  return Response.json({ ids }, { headers: { 'cache-control': 'no-store' } });
}
