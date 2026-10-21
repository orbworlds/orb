// GET /api/paths?handle=…&slug=… → { id } — which world lives at /<handle>/<slug> (used when the
// app navigates between readable URLs without a page load).
import { error, handle, json } from '@/server/http';
import { resolvePath } from '@/server/paths';
import { ready } from '@/server/schema';

export const GET = handle(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const id = await resolvePath(await ready(), (sp.get('handle') ?? '').toLowerCase(), (sp.get('slug') ?? '').toLowerCase());
  if (!id) return error(404, 'not_found', 'No world lives at that address.');
  return json({ id });
});
