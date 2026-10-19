// GET /api/admin/users?q= — (admin) find accounts by name or handle.
import { isAdmin } from '@/server/auth';
import { error, json } from '@/server/http';
import { ready } from '@/server/schema';
import { adminFindUsers } from '@/server/worlds';

export async function GET(req: Request): Promise<Response> {
  if (!isAdmin(req)) return error(401, 'unauthorized', 'Admin token required.');
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
  if (!q) return error(400, 'bad_request', 'Give a name or handle (?q=).');
  return json({ users: await adminFindUsers(await ready(), q) });
}
