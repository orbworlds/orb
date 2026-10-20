// GET /api/tree/:sha/<path> — one file of a multi-file world (see src/server/files.ts).
//
// Worlds run in an opaque-origin sandboxed frame whose page carries <base href="/api/tree/<sha>/">,
// so their relative modules, styles and assets load from here: CORS is open, and responses are
// immutable (a tree never changes). A file opened directly (not inside the world frame) is still
// sandboxed by its CSP, so it can never act as Orb's own origin.

import { contentType, ENTRY, getBlob, getTree, isSha } from '@/server/files';
import { ready } from '@/server/schema';

const SANDBOX_CSP = 'sandbox allow-scripts allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads';

const BASE_HEADERS = {
  'access-control-allow-origin': '*',
  'cross-origin-resource-policy': 'cross-origin',
  'x-content-type-options': 'nosniff',
  'content-security-policy': SANDBOX_CSP,
};

/** Vercel buffers a whole response up to 4.5 MB; bigger files (models) go out as a stream. */
const STREAM_OVER = 4_000_000;
function chunked(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      c.enqueue(bytes.slice(at, (at += 1_000_000)));
      if (at >= bytes.length) c.close();
    },
  });
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=60' } });
}

export async function GET(_req: Request, ctx: { params: Promise<{ sha: string; path: string[] }> }): Promise<Response> {
  const { sha, path } = await ctx.params;
  if (!isSha(sha)) return notFound();
  // A world loads many files at once (dozens of modules): ride out a busy database instead of
  // failing one of them (a single failed module stops the whole world).
  for (let attempt = 0; ; attempt++) {
    try {
      const db = await ready();
      const tree = await getTree(db, sha);
      if (!tree) return notFound();
      let p = (path ?? []).map((s) => decodeURIComponent(s)).join('/');
      if (!tree[p]) p = p ? `${p.replace(/\/$/, '')}/${ENTRY}` : ENTRY;
      const blobSha = tree[p];
      if (!blobSha) return notFound();
      const bytes = await getBlob(db, blobSha);
      if (!bytes) return notFound();
      return new Response(bytes.length > STREAM_OVER ? chunked(bytes) : new Uint8Array(bytes), {
        headers: {
          ...BASE_HEADERS,
          'content-type': contentType(p),
          // Immutable: browsers and Vercel's CDN keep it, so each file is read from the database once.
          'cache-control': 'public, max-age=31536000, immutable',
          'cdn-cache-control': 'public, max-age=31536000, immutable',
          etag: `"${blobSha}"`,
        },
      });
    } catch (e) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt + Math.random() * 200));
        continue;
      }
      console.error('[orb] tree file failed', e);
      return new Response('Unavailable', { status: 503, headers: { ...BASE_HEADERS, 'cache-control': 'no-store', 'retry-after': '1' } });
    }
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { ...BASE_HEADERS, 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '86400' } });
}
