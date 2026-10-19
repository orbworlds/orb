#!/usr/bin/env node
// Checks that every external world in src/data/seeds.json is up and allows being embedded in an
// iframe (no X-Frame-Options DENY/SAMEORIGIN, no restrictive CSP frame-ancestors). Run before adding seeds.
import fs from 'node:fs';
const seeds = JSON.parse(fs.readFileSync(new URL('../src/data/seeds.json', import.meta.url)));
const SITE = process.env.NEXT_PUBLIC_SITE_URL || 'https://orbworld.vercel.app';
const HOST = new URL(SITE).hostname;
/** Orb's own address may embed the site: anyone (or any https site), its host, or a wildcard for it. */
const allowsOrb = (list) =>
  list.split(/\s+/).some((src) => {
    if (src === '*' || /^https?:$/i.test(src)) return true;
    const host = src.replace(/^[a-z]+:\/\//i, '').replace(/[:/].*$/, '').toLowerCase();
    return host === HOST || (host.startsWith('*.') && HOST.endsWith(host.slice(1)));
  });
let bad = 0;
for (const s of seeds) {
  let verdict;
  try {
    // Same user agent as the daily cron (src/app/api/cron/check-embeds): some bot shields answer an anonymous fetch with a challenge page.
    const res = await fetch(s.external_url, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'user-agent': `OrbEmbedCheck/1.0 (+${SITE})` } });
    const xfo = (res.headers.get('x-frame-options') || '').toUpperCase();
    const fa = (res.headers.get('content-security-policy') || '').match(/frame-ancestors([^;]*)/i)?.[1]?.trim() || '';
    if (!res.ok) verdict = `HTTP ${res.status}`;
    else if (xfo === 'DENY' || xfo === 'SAMEORIGIN') verdict = `x-frame-options ${xfo}`;
    else if (fa && !allowsOrb(fa)) verdict = `frame-ancestors ${fa}`;
  } catch (e) {
    verdict = `unreachable (${e.cause?.code || e.message})`;
  }
  if (verdict) bad++;
  console.log(`${verdict ? '✗' : '✓'} ${s.id.padEnd(30)} ${verdict || ''}`);
}
console.log(bad ? `\n${bad} world(s) can't be embedded` : '\nall embeddable');
process.exit(bad ? 1 : 0);
