import { LAB_KEY } from '@/server/lab';
import { ready } from '@/server/schema';
import { exportTraces, isTraceId } from '@/server/traces';
import { ndjson, plain } from '../../ndjson';

// GET /lab/<key>/traces/export — traces as JSON lines, downloaded: one trace per line with all its
// events, payloads decoded (see exportTraces in src/server/traces.ts). ?id=<trace> for one; else
// the list's filters (status, kind, provider, q) and ?since=<date> (the first ones from then) or
// the newest ?limit= (200; at most 2000). ?images=1 puts screenshots in as data URLs.

export const maxDuration = 300;

export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  const { key } = await ctx.params;
  if (key !== LAB_KEY) return plain(404, 'Not found');
  const q = new URL(req.url).searchParams;
  const get = (k: string) => q.get(k)?.trim() || undefined;
  const id = get('id');
  const since = get('since') ? new Date(get('since')!) : undefined;
  if ((id && !isTraceId(id)) || (since && Number.isNaN(since.getTime()))) return plain(400, 'Bad id or since.');
  const lines = exportTraces(await ready(), { id, since, status: get('status'), kind: get('kind'), provider: get('provider'), q: get('q'), limit: Number(get('limit')) || undefined, images: get('images') === '1' });
  const name = id ? `orb-trace-${id}` : `orb-traces-${new Date().toISOString().slice(0, 10)}`;
  return ndjson(lines, 'trace export', { 'content-disposition': `attachment; filename="${name}.jsonl"` });
}
