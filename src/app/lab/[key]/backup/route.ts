import { LAB_KEY } from '@/server/lab';
import { pulse } from '@/server/pulse';
import { ready } from '@/server/schema';

// GET /lab/<key>/backup — what the nightly backup (scripts/backup.mjs) copies besides the traces
// (those come from ../traces/export and ../traces/blob): Pulse's numbers as of now, every recorded
// problem, and each UTC day's analytics events from ?since=<YYYY-MM-DD> (default: the first day),
// as JSON lines: {"type":"pulse",…}, {"type":"problems","rows":[…]}, then one
// {"type":"events","day":"YYYY-MM-DD","rows":[…]} per day with events.

export const maxDuration = 300;

const DAY = 86_400_000;
const plain = (status: number, text: string) => new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  const { key } = await ctx.params;
  if (key !== LAB_KEY) return plain(404, 'Not found');
  const since = new URL(req.url).searchParams.get('since');
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) return plain(400, 'Bad since (YYYY-MM-DD).');
  const db = await ready();

  async function* lines(): AsyncGenerator<unknown> {
    yield { type: 'pulse', ...(await pulse(db)) };
    yield { type: 'problems', rows: await db.query(`select kind, message, detail, path, count, first_at, last_at from orb_errors order by last_at desc`) };
    const [first] = await db.query<{ day: string | null }>(`select to_char(min(at) at time zone 'utc', 'YYYY-MM-DD') as day from orb_events`);
    if (!first?.day) return;
    for (let t = Math.max(Date.parse(`${since ?? first.day}T00:00:00Z`), Date.parse(`${first.day}T00:00:00Z`)); t <= Date.now(); t += DAY) {
      const day = new Date(t).toISOString().slice(0, 10);
      const rows = await db.query(
        `select id, at, name, device, user_id, session, path, world_id, props, referrer, country, mobile from orb_events
         where at >= $1::timestamptz and at < $1::timestamptz + interval '1 day' order by id`,
        [`${day}T00:00:00Z`],
      );
      if (rows.length) yield { type: 'events', day, rows };
    }
  }

  const it = lines();
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const next = await it.next();
        if (next.done) c.close();
        else c.enqueue(enc.encode(`${JSON.stringify(next.value)}\n`));
      } catch (e) {
        console.error('[orb] backup export failed', e);
        c.error(e);
      }
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
