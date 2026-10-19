// GET /api/chats — the signed-in person's chats (most recent 100), so they follow them across devices.
import { getViewer } from '@/server/auth';
import { error, handle, json } from '@/server/http';
import { ready } from '@/server/schema';

export const GET = handle(async (req: Request) => {
  const viewer = getViewer(req);
  if (!viewer.userId) return error(401, 'account_required', 'Sign in to sync chats.');
  const db = await ready();
  const rows = await db.query<{ thread_id: string; world_id: string; title: string; messages: unknown; updated_at: string | number }>(
    `select thread_id, world_id, title, messages, updated_at from orb_chats where user_id = $1 order by updated_at desc limit 100`,
    [viewer.userId],
  );
  return json({
    chats: rows.map((r) => ({
      thread: { id: r.thread_id, worldId: r.world_id, title: r.title, updatedAt: Number(r.updated_at), createdAt: Number(r.updated_at) },
      messages: typeof r.messages === 'string' ? JSON.parse(r.messages) : r.messages,
    })),
  });
});
