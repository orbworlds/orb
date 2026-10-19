// POST /api/events { sent, mobile?, device?, events: [{ name, t, session, path?, world?, props?, ref? }] }
// — product analytics from Orb's pages (src/lib/analytics.ts; what's kept: src/server/events.ts).
// Always 200 { accepted }: anything cross-site, from a bot, malformed or over the limits (600
// events per IP every 10 minutes, ORB_EVENTS_PER_DAY a day in all) is dropped quietly. The device is the
// x-orb-device header, or `device` in the body when sent with navigator.sendBeacon (which can't
// set headers); only its hash is kept. The account comes from the session cookie.

import { hashDevice, readCookie, SESSION_COOKIE, verifySession } from '@/server/auth';
import { isBot, isMobile, MAX_BODY_BYTES, parseBatch, recordEvents } from '@/server/events';
import { clientIp, json, readJson } from '@/server/http';
import { rateLimit } from '@/server/ratelimit';
import { ready } from '@/server/schema';

const deviceKey = (k: unknown): k is string => typeof k === 'string' && k.length >= 16 && k.length <= 128;
/** Events kept a day in all: each takes room in the database (about 0.7 KB, kept 180 days). */
const PER_DAY = Math.max(0, Math.floor(Number(process.env.ORB_EVENTS_PER_DAY) || 20_000));

export async function POST(req: Request): Promise<Response> {
  let accepted = 0;
  try {
    const site = req.headers.get('sec-fetch-site');
    const isJson = (req.headers.get('content-type') ?? '').includes('application/json');
    const ua = req.headers.get('user-agent');
    const batch = (site === null || site === 'same-origin') && isJson && !isBot(ua) ? parseBatch(await readJson(req, MAX_BODY_BYTES)) : null;
    const key = req.headers.get('x-orb-device') || batch?.device;
    if (batch?.rows.length && deviceKey(key)) {
      const db = await ready();
      const n = batch.rows.length;
      if ((await rateLimit(db, `events:ip:${clientIp(req)}`, 600, 600, n)).ok && (await rateLimit(db, 'events:all', PER_DAY, 86_400, n)).ok) {
        const country = req.headers.get('x-vercel-ip-country');
        await recordEvents(
          db,
          {
            deviceHash: hashDevice(key),
            userId: verifySession(readCookie(req, SESSION_COOKIE))?.userId ?? null,
            country: country && /^[A-Z]{2}$/.test(country) ? country : null,
            mobile: isMobile(batch.mobile, ua),
          },
          batch.rows,
        );
        accepted = n;
      }
    }
  } catch (e) {
    console.error('[orb] /api/events failed', e);
  }
  return json({ accepted });
}
