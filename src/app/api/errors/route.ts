// POST /api/errors { message, stack?, path? } — a crash in one of Orb's pages, reported by the
// browser (src/lib/report.ts). Always 204. Only Orb's own pages report (same-origin JSON); at most
// 20 reports per IP every 10 minutes and 300 an hour in all are kept.

import { recordError } from '@/server/errors';
import { clientIp, ownPageJson, readJson } from '@/server/http';
import { rateLimit } from '@/server/ratelimit';
import { ready } from '@/server/schema';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function pathname(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    return new URL(s, 'http://orb').pathname;
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  const body = ownPageJson(req) ? await readJson<Record<string, unknown>>(req, 16_000) : null;
  const message = str(body?.message);
  if (message) {
    try {
      const db = await ready();
      if ((await rateLimit(db, `errors:ip:${clientIp(req)}`, 20, 600)).ok && (await rateLimit(db, 'errors:page', 300, 3600)).ok) {
        const browser = req.headers.get('user-agent')?.slice(0, 240);
        await recordError(db, { kind: 'page', message, stack: str(body?.stack), context: browser && `Browser: ${browser}`, path: pathname(body?.path) });
      }
    } catch (e) {
      console.error('[orb] /api/errors failed', e);
    }
  }
  return new Response(null, { status: 204 });
}
