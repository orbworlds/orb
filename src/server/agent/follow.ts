// The output stream of an agent job, for a watching page: everything from character `from` on,
// then live until the job ends. Near the request's time limit the stream ends with a `resume`
// control frame and the page continues with a new request. A job that no tick is running (it
// died, or is between ticks) is kicked from here, so a watched job never stalls. While a page
// follows, the job is marked as watched: its agent can look at the world (./look.ts).

import { after } from 'next/server';
import { control, jobChunks } from '../buildjobs';
import type { Db } from '../db';
import { markWatched } from './look';
import { jobInfo, kick } from './runner';

const FOLLOW_MS = 250_000;
const POLL_MS = 450;
const KICK_EVERY_MS = 25_000;
const WATCHED_EVERY_MS = 5_000;

export const STREAM_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  'x-accel-buffering': 'no',
};

export function followJob(req: Request, db: Db, id: string, from: number, opts: { announce?: boolean } = {}): Response {
  const enc = new TextEncoder();
  const startedAt = Date.now();
  const kicks: Promise<unknown>[] = [];
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const out = (t: string) => {
        if (!open || !t) return;
        try {
          controller.enqueue(enc.encode(t));
        } catch {
          open = false; // the browser left
        }
      };
      if (opts.announce) out(control({ t: 'handle', kind: 'agent', id }));
      let pos = 0;
      let sent = from;
      let seq = -1;
      let lastOut = Date.now();
      let lastKick = 0;
      let lastWatched = 0;
      try {
        for (;;) {
          if (req.signal.aborted || !open) break;
          const info = await jobInfo(db, id);
          if (!info) {
            out('\n<orb:error>That build is gone.</orb:error>\n');
            break;
          }
          if (info.status === 'running' && Date.now() - lastWatched > WATCHED_EVERY_MS) {
            lastWatched = Date.now();
            await markWatched(db, id).catch(() => undefined);
          }
          // Read the state first: once it says finished, the chunks read next are complete.
          const finished = info.status !== 'running';
          for (const c of await jobChunks(db, id, seq)) {
            seq = c.seq;
            const end = pos + c.text.length;
            if (end > sent) {
              out(c.text.slice(Math.max(0, sent - pos)));
              sent = end;
              lastOut = Date.now();
            }
            pos = end;
          }
          if (finished) break;
          if (info.idle && Date.now() - lastKick > KICK_EVERY_MS) {
            lastKick = Date.now();
            kicks.push(kick(info.origin, id));
          }
          if (Date.now() - startedAt > FOLLOW_MS) {
            out(control({ t: 'resume', kind: 'agent', id, from: sent }));
            break;
          }
          if (Date.now() - lastOut > 12_000) {
            out(control({ t: 'ping' }));
            lastOut = Date.now();
          }
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
      } catch (e) {
        console.error('[orb] agent follow failed', e);
        out(control({ t: 'resume', kind: 'agent', id, from: sent }));
      }
      if (open) {
        try {
          controller.close();
        } catch {
          /* the browser left */
        }
      }
    },
  });
  after(() => Promise.allSettled(kicks));
  return new Response(stream, { headers: { ...STREAM_HEADERS, 'x-orb-job': id } });
}
