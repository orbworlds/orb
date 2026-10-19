import { LAB_KEY } from '@/server/lab';
import { ready } from '@/server/schema';
import { traceBlob } from '@/server/traces';

// GET /lab/<key>/traces/blob/<sha> — something a trace stored once (src/server/traces.ts): a
// screenshot, an image, a system prompt, one of a world's files. Images come as themselves and
// anything else as plain text, so a stored page or SVG never runs as Orb. A blob never changes.

const IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/;

const missing = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

export async function GET(_req: Request, ctx: { params: Promise<{ key: string; sha: string }> }): Promise<Response> {
  const { key, sha } = await ctx.params;
  if (key !== LAB_KEY || !/^[a-f0-9]{64}$/.test(sha)) return missing();
  const blob = await traceBlob(await ready(), sha);
  if (!blob) return missing();
  return new Response(new Uint8Array(blob.data), {
    headers: {
      'content-type': blob.type && IMAGE.test(blob.type) ? blob.type : 'text/plain; charset=utf-8',
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'x-robots-tag': 'noindex',
    },
  });
}
