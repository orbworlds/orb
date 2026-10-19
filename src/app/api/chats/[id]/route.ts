// PUT /api/chats/:id — save one chat thread to the signed-in person's account (last write wins).
import { getViewer } from '@/server/auth';
import { error, handle, json, readJson } from '@/server/http';
import { rateLimit } from '@/server/ratelimit';
import { ready } from '@/server/schema';

const MAX_BYTES = 600_000;

export const PUT = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const viewer = getViewer(req);
  if (!viewer.userId) return error(401, 'account_required', 'Sign in to sync chats.');
  const { id } = await ctx.params;
  if (!/^[\w-]{1,64}$/.test(id)) return error(400, 'bad_request', 'Bad chat id.');
  const body = await readJson<{ worldId?: unknown; title?: unknown; messages?: unknown; updatedAt?: unknown }>(req, MAX_BYTES);
  if (!body || typeof body.worldId !== 'string' || !Array.isArray(body.messages) || !Number.isSafeInteger(body.updatedAt)) return error(400, 'bad_request', 'Expected { worldId, title, messages, updatedAt }.');
  // A clock far in the future would freeze the thread (last write wins): clamp it.
  const updatedAt = Math.min(Number(body.updatedAt), Date.now() + 86400e3);
  const db = await ready();
  const r = await rateLimit(db, `chats:${viewer.userId}`, 600, 3600);
  if (!r.ok) return error(429, 'rate_limited', 'Too many saves.', { retryAfter: r.retryAfter });
  await db.query(
    `insert into orb_chats (user_id, thread_id, world_id, title, messages, updated_at) values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict (user_id, thread_id) do update set world_id = excluded.world_id, title = excluded.title, messages = excluded.messages, updated_at = excluded.updated_at
     where orb_chats.updated_at <= excluded.updated_at`,
    [viewer.userId, id, body.worldId.slice(0, 64), typeof body.title === 'string' ? body.title.slice(0, 200) : '', JSON.stringify(body.messages.slice(-120)), updatedAt],
  );
  return json({ ok: true });
});
