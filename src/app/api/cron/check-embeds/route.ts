// Daily (Vercel Cron, see vercel.json): re-check every curated external world. A site that is down
// or forbids being embedded (X-Frame-Options / CSP frame-ancestors) is hidden from Explore
// (broken_at set) and comes back by itself once it works again. Auth: Vercel sends
// `Authorization: Bearer $CRON_SECRET`.
import { error, json } from '@/server/http';
import { ready } from '@/server/schema';
import { sweepJobs } from '@/server/buildjobs';
import { SITE } from '@/lib/site';

export const maxDuration = 120;

const HOST = new URL(SITE).hostname;

/** A frame-ancestors list that lets Orb's own address embed the site: anyone (or any https site), its host, or a wildcard for it. */
function allowsOrb(list: string): boolean {
  return list.split(/\s+/).some((src) => {
    if (src === '*' || /^https?:$/i.test(src)) return true;
    const host = src.replace(/^[a-z]+:\/\//i, '').replace(/[:/].*$/, '').toLowerCase();
    return host === HOST || (host.startsWith('*.') && HOST.endsWith(host.slice(1)));
  });
}

async function problem(url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': `OrbEmbedCheck/1.0 (+${SITE})` } });
      const xfo = (res.headers.get('x-frame-options') || '').toUpperCase();
      const fa = (res.headers.get('content-security-policy') || '').match(/frame-ancestors([^;]*)/i)?.[1]?.trim() || '';
      if (xfo === 'DENY' || xfo === 'SAMEORIGIN') return `x-frame-options ${xfo}`;
      if (fa && !allowsOrb(fa)) return `frame-ancestors ${fa}`;
      if (res.ok) return null;
      if (attempt === 1) return `HTTP ${res.status}`;
    } catch (e) {
      if (attempt === 1) return `unreachable: ${(e as Error).message}`;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) return error(401, 'unauthorized');
  const db = await ready();
  const rows = await db.query<{ id: string; external_url: string }>(`select id, external_url from orb_worlds where kind = 'external' and external_url is not null`);
  const results = await Promise.all(rows.map(async (r) => ({ id: r.id, problem: await problem(r.external_url) })));
  const broken = results.filter((r) => r.problem).map((r) => r.id);
  const fine = results.filter((r) => !r.problem).map((r) => r.id);
  if (broken.length) await db.query(`update orb_worlds set broken_at = coalesce(broken_at, now()) where id = any($1::text[])`, [broken]);
  if (fine.length) await db.query(`update orb_worlds set broken_at = null where id = any($1::text[]) and broken_at is not null`, [fine]);
  for (const r of results) if (r.problem) console.warn(`[orb] external world hidden: ${r.id} — ${r.problem}`);
  // Housekeeping: finished build jobs are only needed for a short while.
  await sweepJobs(db).catch((e) => console.error('[orb] build job sweep failed', e));
  return json({ checked: rows.length, hidden: results.filter((r) => r.problem) });
}
