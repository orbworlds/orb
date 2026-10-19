// GET /api/cursor/models — the models (and their options) the caller's Cursor key can use.
// The key comes in the `x-orb-cursor-key` header, is used for this request only and never stored.
import { CursorError, listCursorModels } from '@/server/cursor';
import { error, json } from '@/server/http';

export async function GET(req: Request): Promise<Response> {
  const key = (req.headers.get('x-orb-cursor-key') ?? '').trim();
  if (!key || key.length > 300 || /\s/.test(key)) return error(400, 'bad_key', 'Add a Cursor API key first.');
  try {
    const models = await listCursorModels(key, req.signal);
    return json({ models }, { headers: { 'cache-control': 'private, max-age=600' } });
  } catch (e) {
    const status = e instanceof CursorError ? e.status : 0;
    if (status === 401 || status === 403) return error(401, 'bad_key', 'Cursor rejected that API key.');
    return error(502, 'cursor_unavailable', "Couldn't load Cursor's models right now.");
  }
}
