#!/usr/bin/env node
// Runs during the Vercel build (see package.json "build"). Never fails the build.
// 1) Applies the idempotent schema to the production database if it changed (so the first
//    visitor doesn't pay for it) and prints a few counts.
// 2) Probes the AI provider so the build log says whether free building works.
// Locally (no POSTGRES_URL / not on Vercel) it does nothing.

import { MIGRATION, SCHEMA_VERSION } from '../src/server/ddl.mjs';

const log = (...a) => console.log('[orb:prod-check]', ...a);

async function checkDb() {
  const url = process.env.POSTGRES_URL;
  if (!url) return log('db: POSTGRES_URL not set — skipping');
  const { default: postgres } = await import('postgres');
  const u = new URL(url);
  const sslmode = u.searchParams.get('sslmode');
  u.search = '';
  if (sslmode) u.searchParams.set('sslmode', sslmode);
  const sql = postgres(u.toString(), { prepare: false, max: 1, connect_timeout: 15, ssl: 'require', onnotice: () => {} });
  try {
    const [stamp] = await sql.unsafe(`select value from orb_meta where key = 'schema'`).catch(() => []);
    const current = stamp?.value === SCHEMA_VERSION;
    if (!current) await sql.unsafe(MIGRATION);
    const [w] = await sql.unsafe(`select count(*)::int as n, count(*) filter (where kind = 'native')::int as native from orb_worlds`);
    log(`db: schema ${current ? 'up to date' : 'applied'} — ${w.n} worlds (${w.native} native)`);
  } catch (e) {
    log('db: FAILED', e?.message || e);
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

async function checkAi() {
  if (process.env.ANTHROPIC_API_KEY) return log('ai: using ANTHROPIC_API_KEY');
  const token = process.env.VERCEL_OIDC_TOKEN;
  if (!token) return log('ai: no OIDC token in build env — cannot probe AI Gateway');
  const model = process.env.ORB_MODEL || 'anthropic/claude-sonnet-5.5';
  try {
    const res = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with: ok' }], max_tokens: 5 }),
    });
    const text = await res.text();
    if (res.ok) log(`ai: AI Gateway OK (${model})`);
    else log(`ai: AI Gateway ${res.status} — ${text.slice(0, 240)}`);
  } catch (e) {
    log('ai: probe failed', e?.message || e);
  }
}

// 3) Smoke-test the CURRENT production deployment (the one this build will replace). Build
//    containers have internet access, so this verifies the live site end to end — and warms it
//    (the first request seeds Explore).
async function checkLive() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!host) return log('live: no production URL');
  const get = async (path) => {
    const t = Date.now();
    try {
      const res = await fetch(`https://${host}${path}`, { signal: AbortSignal.timeout(20000), headers: { 'x-orb-device': 'orb-build-smoke-test-device-key' } });
      const text = await res.text();
      return { status: res.status, ms: Date.now() - t, text };
    } catch (e) {
      return { status: 0, ms: Date.now() - t, text: String(e?.message || e) };
    }
  };
  const home = await get('/');
  log(`live: GET / → ${home.status} in ${home.ms}ms${/Step into a/.test(home.text) ? ' (hero ok)' : ''}`);
  const cfg = await get('/api/config');
  log(`live: GET /api/config → ${cfg.status} ${cfg.text.slice(0, 160)}`);
  const list = await get('/api/worlds?sort=featured&limit=60');
  let summary = list.text.slice(0, 160);
  try {
    const j = JSON.parse(list.text);
    summary = `${j.worlds.length} worlds: ${j.worlds.slice(0, 8).map((w) => w.id + (w.verified ? '✓' : '')).join(', ')}…`;
  } catch {}
  log(`live: GET /api/worlds → ${list.status} in ${list.ms}ms — ${summary}`);
  const og = await get('/w/orb-island');
  log(`live: GET /w/orb-island → ${og.status}${/<title>[^<]*Seashell Island/.test(og.text) ? ' (metadata ok)' : ''}`);
}

// 4) Can these candidate external worlds be embedded in an iframe? (X-Frame-Options / CSP)
async function checkEmbeds() {
  for (const url of (process.env.ORB_EMBED_PROBE || 'https://storycomet.app/').split(',').filter(Boolean)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
      const xfo = res.headers.get('x-frame-options');
      const fa = (res.headers.get('content-security-policy') || '').match(/frame-ancestors[^;]*/i)?.[0];
      log(`embed: ${url} → ${res.status} final=${res.url} x-frame-options=${xfo ?? 'none'} ${fa ?? 'frame-ancestors=none-set'}`);
    } catch (e) {
      log(`embed: ${url} → failed ${e?.message || e}`);
    }
  }
}

if (process.env.VERCEL) {
  await Promise.race([Promise.all([checkDb(), checkAi(), checkLive(), checkEmbeds()]), new Promise((r) => setTimeout(r, 60000))]);
} else {
  log('not on Vercel — skipping');
}
