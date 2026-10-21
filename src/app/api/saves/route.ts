// GET /api/saves — which worlds the signed-in person has game progress saved for, and when.

import { getViewer } from '@/server/auth';
import { fail, handle, json } from '@/server/http';
import { listSaves } from '@/server/saves';
import { ready } from '@/server/schema';

export const GET = handle(async (req: Request) => {
  const viewer = getViewer(req);
  if (!viewer.userId) fail(401, 'account_required', 'Sign in to keep your progress on every device.');
  return json({ saves: await listSaves(await ready(), viewer.userId) });
});
