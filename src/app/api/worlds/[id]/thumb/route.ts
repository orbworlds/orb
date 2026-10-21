// PUT /api/worlds/:id/thumb — owner uploads a thumbnail (raw image/webp|jpeg|png body, ≤ 500 KB).
// GET /api/worlds/:id/thumb?v= — the image bytes. Versioned URLs (?v = current thumb_version) are
// immutable and cached for a year; anything else gets a short max-age. External worlds redirect
// to their curated thumbnail URL.

import { getViewer } from '@/server/auth';
import { clientIp, fail, handle, json } from '@/server/http';
import { ready } from '@/server/schema';
import { actorKey, getThumb, LIMITS, limitOrThrow, putThumb, thumbContentType, worldIdParam, type IdContext } from '@/server/worlds';

/** Read the request body, giving up (null) as soon as it exceeds `max` bytes. */
async function readBody(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export const PUT = handle(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const viewer = getViewer(req);
  const type = thumbContentType(req.headers.get('content-type'));
  if (!type) fail(415, 'bad_image', 'Thumbnails must be WebP, JPEG or PNG images.');
  const db = await ready();
  await limitOrThrow(db, `thumb:${actorKey(viewer, clientIp(req))}`, 30, 60);
  const bytes = await readBody(req, LIMITS.thumbBytes);
  if (!bytes) fail(413, 'too_large', 'Thumbnail is too large (max 500 KB).');
  const thumbVersion = await putThumb(db, viewer, id, bytes, type);
  return json({ thumbVersion });
});

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((t) => {
    const tag = t.trim();
    return tag === '*' || tag === etag || tag === `W/${etag}`;
  });
}

export const GET = handle(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const db = await ready();
  const thumb = await getThumb(db, getViewer(req), id);
  if (!thumb) fail(404, 'no_thumbnail', 'This world has no thumbnail yet.');

  if (thumb.kind === 'redirect') {
    return new Response(null, { status: 302, headers: { location: thumb.url, 'cache-control': 'public, max-age=3600' } });
  }

  const requested = new URL(req.url).searchParams.get('v');
  const etag = `"${id}.${thumb.version}"`;
  const headers: Record<string, string> = {
    'content-type': thumb.type,
    etag,
    'x-content-type-options': 'nosniff',
    'cache-control': !thumb.isPublic
      ? 'private, max-age=60'
      : requested === String(thumb.version)
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=60, s-maxage=60',
  };
  if (etagMatches(req.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });
  return new Response(thumb.bytes, { headers: { ...headers, 'content-length': String(thumb.bytes.byteLength) } });
});
