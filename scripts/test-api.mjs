#!/usr/bin/env node
// End-to-end tests for Orb's HTTP API (SPEC §6) using plain fetch. Usage:
//
//   node scripts/test-api.mjs              # starts `next dev -p 3103` itself (PGlite in .data/pglite-server)
//   ORB_TEST_BASE=http://localhost:3103 node scripts/test-api.mjs   # or reuse a running server
//
// When the script starts the server it sets ORB_MOCK_AI=1, ORB_PGLITE_DIR=.data/pglite-server,
// ORB_ADMIN_TOKEN and ORB_SECRET, and seeds a test account directly into PGlite first so the
// signed-in paths (private worlds) can be exercised with a session cookie signed by ORB_SECRET.
// Against an external server those signed-in checks are skipped unless ORB_TEST_SECRET and
// ORB_TEST_USER (an existing user id) are provided.
//
// Every run uses fresh device keys and a unique name token, so runs don't interfere.
// Exit code 0 = all checks passed. ORB_TEST_ONLY=<substring> runs only matching sections.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.ORB_TEST_BASE || 'http://localhost:3103').replace(/\/$/, '');
const PORT = new URL(BASE).port || '3103';
const PGLITE_DIR = process.env.ORB_PGLITE_DIR || '.data/pglite-server';
const OUT_DIR = path.join(root, '.data', 'test-api');

// ------------------------------------------------------------------------------------------
// Tiny test framework

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  const d = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : d}`);
}
function skip(name, why) {
  console.log(`  - ${name} (skipped: ${why})`);
}
const ONLY = (process.env.ORB_TEST_ONLY || '').toLowerCase();
async function section(title, fn) {
  if (ONLY && !title.toLowerCase().includes(ONLY)) return;
  console.log(`\n${title}`);
  try {
    await fn();
  } catch (e) {
    check(`${title}: unexpected exception`, false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
  }
}

// ------------------------------------------------------------------------------------------
// Fixtures

// Cursor builds and GitHub sync run against a fake of both APIs (when this script starts the
// server itself).
const { startFake } = await import('./fake-cursor-github.mjs');
let FAKE = null;
let FAKE_URL = '';

const RUN = crypto.randomBytes(4).toString('hex');
const TOKEN = `zq${RUN}`; // unique word in names/descriptions so list queries only see this run
const ADMIN_TOKEN = process.env.ORB_ADMIN_TOKEN || 'orb-test-admin-token';
let SECRET = process.env.ORB_TEST_SECRET || null;
let TEST_USER = process.env.ORB_TEST_USER || null;
/** ORB_FREE_DAILY_PER_DEVICE of the server under test (known only when this script starts it). */
let FREE_PER_DEVICE = Number(process.env.ORB_TEST_FREE_PER_DEVICE) || null;
/** The secret path of the hidden worlds page (ORB_LAB_KEY), when known. */
let LAB_KEY = process.env.ORB_TEST_LAB_KEY || null;
/** ORB_SHOP_DAILY of the server under test (known only when this script starts it). */
let SHOP_DAILY = Number(process.env.ORB_TEST_SHOP_DAILY) || null;

const device = (label) => `test-${RUN}-${label}-${crypto.randomBytes(8).toString('hex')}`;
const hashDevice = (key) => crypto.createHash('sha256').update(`orb-device:${key}`).digest('hex');
const OWNER = device('owner');
const OTHER = device('other');
const THIRD = device('third');
const STORE_DEV = device('store');
const ACCOUNT_DEV = device('account');
// The free tier allows a few builds per device a day: the look builds get devices of their own.
const LOOKER = device('looker');
const LOOKER2 = device('looker2');
const TRACER = device('tracer');
const BUILDER = device('builder');
const BUILDER2 = device('builder2');
const SIGNUP_DEV = device('signup');
const SIGNUP_DEV2 = device('signup2');
const ADA_DEV = device('ada');
const BO_DEV = device('bo');
const CY_DEV = device('cy');
const GUS_DEV = device('gus');
const RX_MAKER_DEV = device('rx-maker');
const RX_FAN_DEV = device('rx-fan');
const RX_ANON_DEV = device('rx-anon');
const SHOP_MAKER_DEV = device('shop-maker');
const SHOP_BUYER_DEV = device('shop-buyer');
const SHOP_ANON_DEV = device('shop-anon');
const LOOKS_DEV = device('looks');
const LOOKS_ANON_DEV = device('looks-anon');
const ALL_HASHES = [OWNER, OTHER, THIRD, STORE_DEV, ACCOUNT_DEV, LOOKER, LOOKER2, TRACER, BUILDER, BUILDER2, SIGNUP_DEV, SIGNUP_DEV2, ADA_DEV, BO_DEV, CY_DEV, GUS_DEV, RX_MAKER_DEV, RX_FAN_DEV, RX_ANON_DEV, SHOP_MAKER_DEV, SHOP_BUYER_DEV, SHOP_ANON_DEV].map(hashDevice);

// A real 32×18 WebP (iridescent gradient + white dot) and a 2×2 PNG.
const WEBP = Buffer.from(
  'UklGRqgAAABXRUJQVlA4IJwAAABQBQCdASogABIAPm0skUWkIqGYBABABsS0AF2ZmiFf1NW3zfbUCyoGZvMHWVF2Yf+IoUAA/c7n4+XIvBZ3u3RqF5R7ML/Qf+c5DBAt+X/85Fm00pZ9p+yanuNOcxQc+Ogsw5yPH4yKOqtCbhrcyBkDZkXcJ63baOZzQhfHvXNY9/oDBn3R1H/abAHrojUv/qpVjDxiLT/sn4tAAAA=',
  'base64',
);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWOIO/E/7sR/BggFADmWCJVwDpGNAAAAAElFTkSuQmCC',
  'base64',
);

const html = (label) => `<!doctype html><html><head><title>${label}</title></head><body><h1>${label}</h1><script>/* ${RUN} */</script></body></html>`;

/** Session cookie exactly as src/server/auth.ts signs it. */
function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `orb_session=${payload}.${sig}`;
}

// ------------------------------------------------------------------------------------------
// HTTP helper

/**
 * request(method, path, { dev, body, raw, type, headers, cookie }) →
 * { status, headers, json, text, bytes }. `body` is sent as JSON; `raw` as bytes with `type`.
 */
async function request(method, urlPath, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.dev) headers['x-orb-device'] = opts.dev;
  if (opts.cookie) headers.cookie = opts.cookie;
  let body;
  if (opts.raw !== undefined) {
    body = opts.raw;
    if (opts.type) headers['content-type'] = opts.type;
  } else if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(BASE + urlPath, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(120_000) });
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString('utf8');
  let json = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    try {
      json = JSON.parse(text);
    } catch {}
  }
  // Global invariant: no JSON response may leak owner columns or device hashes.
  if (json) {
    const leak = /owner_device|owner_user|ownerDevice|ownerUser/.test(text) || ALL_HASHES.some((h) => text.includes(h));
    if (leak) check(`no owner/device-hash leak in ${method} ${urlPath}`, false, text.slice(0, 200));
  }
  return { status: res.status, headers: res.headers, json, text, bytes };
}

const create = (dev, input) => request('POST', '/api/worlds', { dev, body: { code: html('world'), ...input } });
const patch = (dev, id, input, cookie) => request('PATCH', `/api/worlds/${id}`, { dev, body: input, cookie });
const get = (dev, id, cookie) => request('GET', `/api/worlds/${id}`, { dev, cookie });
const store = (dev, id, body) => request('POST', `/api/worlds/${id}/store`, { dev, body });
const list = (dev, query) => request('GET', `/api/worlds?${new URLSearchParams(query)}`, { dev });

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ------------------------------------------------------------------------------------------
// Dev server

async function reachable() {
  try {
    const res = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(90_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Seed a test account into PGlite (only while no server holds the data dir open). */
async function seedAccount() {
  const id = `testuser${RUN}`;
  if (process.env.POSTGRES_URL) {
    // Real Postgres (e.g. a local server): insert the account there instead of PGlite.
    const { default: postgres } = await import('postgres');
    const sql = postgres(process.env.POSTGRES_URL, { prepare: false, onnotice: () => {} });
    await sql.unsafe(`create table if not exists orb_users (id text primary key, name text not null, created_at timestamptz not null default now())`);
    await sql.unsafe(`insert into orb_users (id, name) values ($1, $2) on conflict (id) do nothing`, [id, `Tester ${RUN}`]);
    await sql.unsafe(`delete from orb_rate where key = 'events:all' or key like '%:ip:%' or key like '%:ipday:%'`).catch(() => {});
    await sql.end();
    return id;
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = path.resolve(root, PGLITE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir);
  await pg.waitReady;
  // Same definition as src/server/schema.ts (create-if-not-exists, so the server's DDL is a no-op).
  await pg.exec(`create table if not exists orb_users (
    id text primary key,
    name text not null,
    created_at timestamptz not null default now()
  );`);
  await pg.query(`insert into orb_users (id, name) values ($1, $2) on conflict (id) do nothing`, [id, `Tester ${RUN}`]);
  // Each run sends ~600 analytics events and makes accounts, worlds and builds from this IP: a day of
  // runs would otherwise fill the site's 20,000 events, and runs close together this IP's limits.
  await pg.query(`delete from orb_rate where key = 'events:all' or key like '%:ip:%' or key like '%:ipday:%'`).catch(() => {});
  await pg.close();
  return id;
}

async function ensureServer() {
  try {
    const res = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      console.log(`Using running server at ${BASE}`);
      return null;
    }
  } catch {}
  SECRET = 'orb-test-secret';
  TEST_USER = await seedAccount();
  FREE_PER_DEVICE = 3;
  LAB_KEY = 'test-lab-key';
  SHOP_DAILY = 100;
  FAKE = await startFake();
  FAKE_URL = `http://localhost:${FAKE.port}`;
  console.log(`Starting next dev on :${PORT} (PGlite: ${PGLITE_DIR}) …`);
  const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '-p', PORT], {
    cwd: root,
    env: { ...process.env, ORB_MOCK_AI: '1', ORB_PGLITE_DIR: PGLITE_DIR, ORB_ADMIN_TOKEN: ADMIN_TOKEN, ORB_SECRET: SECRET, ORB_FREE_DAILY_PER_DEVICE: String(FREE_PER_DEVICE), ORB_LAB_KEY: LAB_KEY, ORB_SHOP_DAILY: String(SHOP_DAILY), NEXT_TELEMETRY_DISABLED: '1', ...(FAKE ? { ORB_CURSOR_API: FAKE_URL, ORB_GITHUB_API: FAKE_URL, ORB_GITHUB_CODELOAD: `${FAKE_URL}/codeload`, ORB_GITHUB_WEB: FAKE_URL } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next dev exited early:\n${log.slice(-2000)}`);
    if (await reachable()) return child;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`next dev did not become ready:\n${log.slice(-2000)}`);
}

function stopServer(child) {
  if (!child) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
}

// ------------------------------------------------------------------------------------------
// Tests

async function run() {
  const state = {};
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Orb's Originals come from their repositories (src/server/reposync.ts): here, two stand-ins on the
  // fake GitHub, brought in by the sweep (the others aren't there, and stay empty)
  if (FAKE) {
    FAKE.addRepo('orbworlds/vampirez', { 'index.html': `<!doctype html><title>VampireZ</title><script type="application/json" id="orb-shop">${JSON.stringify({ items: [{ id: 'blood-pass', name: 'Blood Pass+', price: 750 }, { id: 'title-patron', name: 'Patron', price: 100 }, { id: 'cape-starlight', name: 'Starlight cape', price: 250 }] })}</script><p>night</p>` });
    FAKE.addRepo('orbworlds/bedwars', { 'index.html': '<!doctype html><title>Bed Wars</title><p>beds</p>', LICENSE: 'MIT License' });
    await request('GET', '/api/cron/github');
  }

  await section('Config', async () => {
    const r = await request('GET', '/api/config');
    check('GET /api/config → 200', r.status === 200, r.status);
    const c = r.json || {};
    check('ApiConfig shape', typeof c.ai === 'boolean' && typeof c.model === 'string' && typeof c.githubOAuth === 'boolean' && c.passkeys === true && (c.realtime === null || (typeof c.realtime.url === 'string' && typeof c.realtime.key === 'string')), c);
    check('cache-control is short + public', /public/.test(r.headers.get('cache-control') || '') && !/immutable/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control'));
  });

  await section('Me', async () => {
    const r = await request('GET', '/api/me', { dev: OWNER });
    check('GET /api/me → anonymous device', r.status === 200 && r.json.user === null && r.json.deviceId === hashDevice(OWNER).slice(0, 12) && typeof r.json.name === 'string', r.json);
    const p = await request('PATCH', '/api/me', { dev: OWNER, body: { name: `  Misty   Otter ${RUN}  ` } });
    check('PATCH /api/me sets a cleaned name', p.status === 200 && p.json.name === `Misty Otter ${RUN}`, p.json);
    const bad = await request('PATCH', '/api/me', { dev: OWNER, body: { name: '   ' } });
    check('PATCH /api/me rejects an empty name', bad.status === 400, bad.status);
    const long = await request('PATCH', '/api/me', { dev: THIRD, body: { name: 'x'.repeat(80) } });
    check('PATCH /api/me truncates to 40 chars', long.status === 200 && long.json.name.length === 40, long.json && long.json.name);
    const none = await request('PATCH', '/api/me', { body: { name: 'Nobody' } });
    check('PATCH /api/me without a device → 400', none.status === 400 && none.json.error === 'device_required', none.json);
  });

  await section('Create', async () => {
    const r = await create(OWNER, { name: `Cloud Castle ${TOKEN}`, description: `A castle ${TOKEN}`, template: 'blank', prompt: 'a pink castle on a cloud' });
    check('POST /api/worlds → 201', r.status === 201, r.json || r.status);
    const w = r.json.world;
    state.main = w;
    check('world id is 10-char base62', /^[0-9A-Za-z]{10}$/.test(w.id), w.id);
    check('version 1, owner can edit, not liked', w.version === 1 && w.canEdit === true && w.liked === false, w);
    check('fields round-trip', w.name === `Cloud Castle ${TOKEN}` && w.code === html('world') && w.template === 'blank' && w.kind === 'native', w);
    check('defaults: public, forkable, no thumbnail', w.visibility === 'public' && w.forkable === true && w.thumbUrl === null && w.thumbVersion === 0, w);
    check('author name defaults to the device name', w.authorName === `Misty Otter ${RUN}`, w.authorName);
    check('WorldFull has all contract keys', ['id', 'name', 'description', 'kind', 'authorName', 'verified', 'featured', 'tags', 'thumbUrl', 'plays', 'likes', 'forks', 'forkable', 'visibility', 'externalUrl', 'sourceUrl', 'forkedFrom', 'createdAt', 'updatedAt', 'code', 'template', 'version', 'thumbVersion', 'canEdit', 'liked'].every((k) => k in w), Object.keys(w));

    const explicit = await create(OTHER, { name: 'x', authorName: 'Brave Fox' });
    check('explicit authorName wins', explicit.status === 201 && explicit.json.world.authorName === 'Brave Fox', explicit.json);
    const untitled = await create(OTHER, {});
    check('missing name → "Untitled world"', untitled.json.world.name === 'Untitled world', untitled.json.world.name);
    const longName = await create(OTHER, { name: 'N'.repeat(100) });
    check('name truncated to 60', longName.json.world.name.length === 60, longName.json.world.name.length);
    for (const extra of [explicit, untitled, longName]) await request('DELETE', `/api/worlds/${extra.json.world.id}`, { dev: OTHER });

    const noCode = await request('POST', '/api/worlds', { dev: OWNER, body: { name: 'x' } });
    check('no code → 400 invalid_code', noCode.status === 400 && noCode.json.error === 'invalid_code', noCode.json);
    const huge = await create(OWNER, { code: 'x'.repeat(3 * 1024 * 1024 + 1) });
    check('code > 3 MB → 413', huge.status === 413 && huge.json.error === 'too_large', huge.json);
    const noDevice = await request('POST', '/api/worlds', { body: { code: html('x') } });
    check('no device key → 400 device_required', noDevice.status === 400 && noDevice.json.error === 'device_required', noDevice.json);
    const notJson = await request('POST', '/api/worlds', { dev: OWNER, body: 'not json' });
    check('invalid JSON → 400', notJson.status === 400, notJson.status);
  });

  await section('Get', async () => {
    const id = state.main.id;
    const own = await get(OWNER, id);
    check('owner GET → canEdit true', own.status === 200 && own.json.world.canEdit === true, own.json);
    const other = await get(OTHER, id);
    check('other device GET → canEdit false', other.status === 200 && other.json.world.canEdit === false, other.json);
    const anon = await get(undefined, id);
    check('anonymous GET works', anon.status === 200 && anon.json.world.canEdit === false, anon.status);
    check('GET is no-store', (own.headers.get('cache-control') || '').includes('no-store'), own.headers.get('cache-control'));
    const missing = await get(OWNER, 'doesnotexist');
    check('missing world → 404 not_found', missing.status === 404 && missing.json.error === 'not_found', missing.json);
    const bad = await get(OWNER, encodeURIComponent('bad id!'));
    check('malformed id → 404', bad.status === 404, bad.status);
  });

  await section('Update & versions', async () => {
    const id = state.main.id;
    const v2 = await patch(OWNER, id, { code: html('v2'), prompt: 'add a moat' });
    check('code change → version 2', v2.status === 200 && v2.json.world.version === 2 && v2.json.world.code === html('v2'), v2.json);
    const same = await patch(OWNER, id, { code: html('v2'), name: `Moat Castle ${TOKEN}` });
    check('same code → version unchanged, name updated', same.json.world.version === 2 && same.json.world.name === `Moat Castle ${TOKEN}`, same.json.world);
    const meta = await patch(OWNER, id, { description: 'Line one\r\nLine two', tags: ['Castle', ' castle ', 'Pink!', 'cozy'] });
    check('tags normalized + deduped', JSON.stringify(meta.json.world.tags) === JSON.stringify(['castle', 'pink', 'cozy']), meta.json.world.tags);
    check('description keeps newlines', meta.json.world.description === 'Line one\nLine two', meta.json.world.description);
    const tooMany = await patch(OWNER, id, { tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] });
    check('> 8 tags → 400', tooMany.status === 400 && tooMany.json.error === 'too_many_tags', tooMany.json);
    const badVis = await patch(OWNER, id, { visibility: 'secret' });
    check('bad visibility → 400', badVis.status === 400, badVis.json);
    const badForkable = await patch(OWNER, id, { forkable: 'no' });
    check('bad forkable type → 400', badForkable.status === 400, badForkable.json);

    const vs = await request('GET', `/api/worlds/${id}/versions`, { dev: OWNER });
    check('versions newest first', vs.status === 200 && vs.json.versions.map((v) => v.version).join(',') === '2,1', vs.json);
    check('owner sees prompts', vs.json.versions[0].prompt === 'add a moat' && vs.json.versions[1].prompt === 'a pink castle on a cloud', vs.json.versions);
    const vsOther = await request('GET', `/api/worlds/${id}/versions`, { dev: OTHER });
    check('others get versions without prompts', vsOther.status === 200 && vsOther.json.versions.every((v) => v.prompt === null), vsOther.json);
    const v1 = await request('GET', `/api/worlds/${id}/versions/1`, { dev: OWNER });
    check('GET version 1 → original code', v1.status === 200 && v1.json.version === 1 && v1.json.code === html('world'), v1.json);
    const v99 = await request('GET', `/api/worlds/${id}/versions/99`, { dev: OWNER });
    check('unknown version → 404', v99.status === 404, v99.status);
    const vBad = await request('GET', `/api/worlds/${id}/versions/abc`, { dev: OWNER });
    check('non-numeric version → 404', vBad.status === 404, vBad.status);

    // Pruning: a separate world with 55 code saves keeps only the last 50 versions.
    const p = await create(OWNER, { name: 'Prune me' });
    const pid = p.json.world.id;
    let last;
    for (let i = 2; i <= 56; i++) last = await patch(OWNER, pid, { code: html(`p${i}`) });
    check('55 saves → version 56', last.json.world.version === 56, last.json.world.version);
    const pv = await request('GET', `/api/worlds/${pid}/versions`, { dev: OWNER });
    const nums = pv.json.versions.map((v) => v.version);
    check('pruned to the last 50 versions (7…56)', nums.length === 50 && nums[0] === 56 && nums[49] === 7, { len: nums.length, first: nums[0], last: nums[nums.length - 1] });
    const gone = await request('GET', `/api/worlds/${pid}/versions/6`, { dev: OWNER });
    check('pruned version → 404', gone.status === 404, gone.status);
    await request('DELETE', `/api/worlds/${pid}`, { dev: OWNER });
  });

  await section('Thumbnails', async () => {
    const id = state.main.id;
    const none = await request('GET', `/api/worlds/${id}/thumb`);
    check('no thumbnail yet → 404', none.status === 404, none.status);
    const put = await request('PUT', `/api/worlds/${id}/thumb`, { dev: OWNER, raw: WEBP, type: 'image/webp' });
    check('PUT webp → thumbVersion 1', put.status === 200 && put.json.thumbVersion === 1, put.json);
    const w = (await get(OWNER, id)).json.world;
    check('world thumbUrl points at the versioned route', w.thumbUrl === `/api/worlds/${id}/thumb?v=1` && w.thumbVersion === 1, w.thumbUrl);
    const img = await request('GET', `/api/worlds/${id}/thumb?v=1`);
    check('GET ?v=current → same bytes, image/webp', img.status === 200 && img.headers.get('content-type') === 'image/webp' && img.bytes.equals(WEBP), { status: img.status, type: img.headers.get('content-type'), len: img.bytes.length });
    check('versioned thumb is immutable', /immutable/.test(img.headers.get('cache-control') || '') && /max-age=31536000/.test(img.headers.get('cache-control') || ''), img.headers.get('cache-control'));
    const stale = await request('GET', `/api/worlds/${id}/thumb?v=0`);
    check('other ?v → short max-age', stale.status === 200 && !/immutable/.test(stale.headers.get('cache-control') || '') && /max-age=60/.test(stale.headers.get('cache-control') || ''), stale.headers.get('cache-control'));
    const etag = img.headers.get('etag');
    const cached = await request('GET', `/api/worlds/${id}/thumb?v=1`, { headers: { 'if-none-match': etag } });
    check('If-None-Match → 304', cached.status === 304, cached.status);

    const mismatch = await request('PUT', `/api/worlds/${id}/thumb`, { dev: OWNER, raw: PNG, type: 'image/webp' });
    check('PNG bytes declared as webp → 415', mismatch.status === 415, mismatch.json);
    const text = await request('PUT', `/api/worlds/${id}/thumb`, { dev: OWNER, raw: Buffer.from('hello'), type: 'text/plain' });
    check('text/plain → 415', text.status === 415, text.json);
    const big = Buffer.concat([WEBP, Buffer.alloc(500 * 1024)]);
    const tooBig = await request('PUT', `/api/worlds/${id}/thumb`, { dev: OWNER, raw: big, type: 'image/webp' });
    check('> 500 KB → 413', tooBig.status === 413, tooBig.json);
    const notOwner = await request('PUT', `/api/worlds/${id}/thumb`, { dev: OTHER, raw: WEBP, type: 'image/webp' });
    check('other device PUT → 403', notOwner.status === 403, notOwner.json);
    const png = await request('PUT', `/api/worlds/${id}/thumb`, { dev: OWNER, raw: PNG, type: 'image/png' });
    check('PUT png → thumbVersion 2', png.status === 200 && png.json.thumbVersion === 2, png.json);
    const back = await request('PUT', `/api/worlds/${id}/thumb`, { dev: OWNER, raw: WEBP, type: 'image/webp; charset=binary' });
    check('content-type params tolerated → thumbVersion 3', back.status === 200 && back.json.thumbVersion === 3, back.json);
  });

  await section('Listing', async () => {
    const untitled = (await create(OWNER, { description: `nameless ${TOKEN}` })).json.world;
    const noThumb = (await create(OWNER, { name: `Bare ${TOKEN}` })).json.world;
    const withThumb = (await create(OWNER, { name: `Blocky ${TOKEN}`, template: 'blocks' })).json.world;
    await request('PUT', `/api/worlds/${untitled.id}/thumb`, { dev: OWNER, raw: WEBP, type: 'image/webp' });
    await request('PUT', `/api/worlds/${withThumb.id}/thumb`, { dev: OWNER, raw: WEBP, type: 'image/webp' });
    state.blocky = withThumb;
    state.bare = noThumb;

    const r = await list(OTHER, { sort: 'new', q: TOKEN });
    const ids = r.json.worlds.map((w) => w.id);
    check('GET /api/worlds → 200 { worlds }', r.status === 200 && Array.isArray(r.json.worlds), r.status);
    check('public list includes titled worlds with thumbnails', ids.includes(withThumb.id) && ids.includes(state.main.id), ids);
    check('public list hides untitled worlds', !ids.includes(untitled.id), ids);
    check('public list hides thumbnail-less native worlds', !ids.includes(noThumb.id), ids);
    check('sort=new → newest first', ids.indexOf(withThumb.id) < ids.indexOf(state.main.id), ids);
    const card = r.json.worlds.find((w) => w.id === withThumb.id);
    check('cards carry no code/canEdit', card && !('code' in card) && !('canEdit' in card) && card.thumbUrl === `/api/worlds/${withThumb.id}/thumb?v=1`, card);

    const mine = await list(OWNER, { mine: '1', q: TOKEN });
    const mineIds = mine.json.worlds.map((w) => w.id);
    check('mine=1 includes untitled + thumbless', [untitled.id, noThumb.id, withThumb.id, state.main.id].every((x) => mineIds.includes(x)), mineIds);
    check('mine is never CDN-cached', (mine.headers.get('cache-control') || '').includes('no-store'), mine.headers.get('cache-control'));
    const otherMine = await list(OTHER, { mine: '1', q: TOKEN });
    check("mine=1 for another device excludes the owner's worlds", !otherMine.json.worlds.some((w) => mineIds.includes(w.id)), otherMine.json.worlds.map((w) => w.id));
    const anonMine = await list(undefined, { mine: '1' });
    check('mine=1 without identity → empty', anonMine.status === 200 && anonMine.json.worlds.length === 0, anonMine.json);

    const tagToy = await list(OTHER, { tag: 'toy', q: TOKEN });
    check('tag=toy matches the blocks template', tagToy.json.worlds.map((w) => w.id).join() === withThumb.id, tagToy.json.worlds.map((w) => w.id));
    const tagCastle = await list(OTHER, { tag: 'Castle', q: TOKEN });
    check('tag matches tags (case-insensitive)', tagCastle.json.worlds.map((w) => w.id).join() === state.main.id, tagCastle.json.worlds.map((w) => w.id));
    const tagNative = await list(OTHER, { tag: 'native', q: TOKEN });
    check('tag matches kind', tagNative.json.worlds.length === 2, tagNative.json.worlds.length);
    // Categories: a world is in the first category its tags name, its template's only when they name none.
    const both = (await create(OWNER, { name: `Both ${TOKEN}`, template: 'blocks' })).json.world;
    await patch(OWNER, both.id, { tags: ['game', 'world', 'keyboard'] });
    await request('PUT', `/api/worlds/${both.id}/thumb`, { dev: OWNER, raw: WEBP, type: 'image/webp' });
    const inCat = async (tag) => (await list(OTHER, { tag, q: TOKEN })).json.worlds.some((w) => w.id === both.id);
    check('a world is in one category: its first', (await inCat('game')) && !(await inCat('world')) && !(await inCat('art,toy')), { game: await inCat('game'), world: await inCat('world'), toy: await inCat('art,toy') });
    check('…and other tags still match', await inCat('keyboard'));
    await patch(OWNER, both.id, { forkable: false });
    const remixable = (await list(OTHER, { remixable: '1', q: TOKEN })).json.worlds;
    check('remixable=1 lists only worlds anyone may remix', remixable.length > 0 && remixable.every((w) => w.forkable && w.kind === 'native') && !remixable.some((w) => w.id === both.id), remixable.map((w) => [w.id, w.forkable]));
    await request('DELETE', `/api/worlds/${both.id}`, { dev: OWNER });
    const byAuthor = await list(OTHER, { q: `Otter ${RUN}`, sort: 'new' });
    check('q matches author_name', byAuthor.json.worlds.some((w) => w.id === withThumb.id), byAuthor.json.worlds.map((w) => w.id));
    const wild = await list(OTHER, { q: `%${TOKEN}` });
    check('q treats % literally', wild.json.worlds.length === 0, wild.json.worlds.length);

    // Pagination: limit=1 walks both public worlds without duplicates.
    const seen = [];
    let cursor;
    for (let i = 0; i < 5; i++) {
      const page = await list(OTHER, { sort: 'new', q: TOKEN, limit: '1', ...(cursor ? { cursor } : {}) });
      seen.push(...page.json.worlds.map((w) => w.id));
      cursor = page.json.nextCursor;
      if (!cursor) break;
    }
    check('cursor pagination walks all results once', seen.length === 2 && new Set(seen).size === 2 && seen[0] === withThumb.id, seen);
    for (const sort of ['featured', 'popular']) {
      const p1 = await list(OTHER, { sort, q: TOKEN, limit: '1' });
      const p2 = await list(OTHER, { sort, q: TOKEN, limit: '1', cursor: p1.json.nextCursor });
      const both = [...p1.json.worlds, ...p2.json.worlds].map((w) => w.id);
      check(`sort=${sort} paginates`, both.length === 2 && new Set(both).size === 2 && !p2.json.nextCursor, both);
    }
    const badCursor = await list(OTHER, { cursor: 'garbage' });
    check('bad cursor → 400', badCursor.status === 400 && badCursor.json.error === 'bad_cursor', badCursor.json);
    const wrongSort = await list(OTHER, { sort: 'popular', cursor: (await list(OTHER, { sort: 'new', q: TOKEN, limit: '1' })).json.nextCursor });
    check('cursor from another sort → 400', wrongSort.status === 400, wrongSort.status);
    const big = await list(OTHER, { limit: '500' });
    check('limit is capped at 60', big.status === 200 && big.json.worlds.length <= 60, big.json.worlds.length);
  });

  await section('Remix (fork)', async () => {
    const id = state.main.id;
    await patch(OWNER, id, { forkable: false });
    const denied = await request('POST', `/api/worlds/${id}/fork`, { dev: OTHER, body: {} });
    check('fork of a non-remixable world → 403 not_forkable', denied.status === 403 && denied.json.error === 'not_forkable', denied.json);
    const ownCopy = await request('POST', `/api/worlds/${id}/fork`, { dev: OWNER, body: {} });
    check('owner may duplicate their own non-remixable world', ownCopy.status === 201, ownCopy.json);
    await request('DELETE', `/api/worlds/${ownCopy.json.world.id}`, { dev: OWNER });
    await patch(OWNER, id, { forkable: true });

    const before = (await get(OTHER, id)).json.world;
    const r = await request('POST', `/api/worlds/${id}/fork`, { dev: OTHER, body: { authorName: 'Brave Fox' } });
    check('fork → 201', r.status === 201, r.json);
    const f = r.json.world;
    state.fork = f;
    check('fork keeps name + code, new owner', f.id !== id && f.name === before.name && f.code === before.code && f.canEdit === true && f.authorName === 'Brave Fox', f);
    check('fork links its source', f.forkedFrom && f.forkedFrom.id === id && f.forkedFrom.name === before.name, f.forkedFrom);
    check('fork starts at version 1, public, remixable', f.version === 1 && f.visibility === 'public' && f.forkable === true && f.forks === 0 && f.plays === 0, f);
    check('fork copies the thumbnail', f.thumbVersion === 1 && f.thumbUrl === `/api/worlds/${f.id}/thumb?v=1`, f.thumbUrl);
    const img = await request('GET', `/api/worlds/${f.id}/thumb?v=1`);
    check('copied thumbnail bytes match', img.status === 200 && img.bytes.equals(WEBP), img.status);
    const after = (await get(OTHER, id)).json.world;
    check('source forks count +1', after.forks === before.forks + 1, { before: before.forks, after: after.forks });
    const srcEdit = await get(OTHER, id);
    check('forking does not grant edit on the source', srcEdit.json.world.canEdit === false, srcEdit.json.world.canEdit);
    const fv = await request('GET', `/api/worlds/${f.id}/versions`, { dev: OTHER });
    check('fork has one version', fv.json.versions.length === 1 && fv.json.versions[0].version === 1, fv.json);
    const listed = async () => (await list(THIRD, { sort: 'new', q: TOKEN })).json.worlds.some((w) => w.id === f.id);
    check('an unchanged remix stays out of Explore', !(await listed()));
    check('…but is among its owner’s worlds', (await list(OTHER, { mine: '1', q: TOKEN })).json.worlds.some((w) => w.id === f.id));
    await patch(OTHER, f.id, { code: html('remixed') });
    check('a changed remix is listed', await listed());
    const ghost = await request('POST', '/api/worlds/doesnotexist/fork', { dev: OTHER, body: {} });
    check('fork of a missing world → 404', ghost.status === 404, ghost.status);
    const anon = await request('POST', `/api/worlds/${id}/fork`, { body: {} });
    check('fork without identity → 400 device_required', anon.status === 400 && anon.json.error === 'device_required', anon.json);
    const tagsBefore = (await get(OWNER, id)).json.world.tags;
    await patch(OWNER, id, { tags: [...tagsBefore, 'keyboard'] });
    const kf = (await request('POST', `/api/worlds/${id}/fork`, { dev: THIRD, body: {} })).json.world;
    check('a remix leaves the keyboard tag behind (its maker can add touch controls)', kf && !kf.tags.includes('keyboard') && kf.tags.length === tagsBefore.length, kf && kf.tags);
    if (kf) await request('DELETE', `/api/worlds/${kf.id}`, { dev: THIRD });
    await patch(OWNER, id, { tags: tagsBefore });
  });

  await section('Likes', async () => {
    const id = state.main.id;
    const a = await request('POST', `/api/worlds/${id}/like`, { dev: OTHER, body: {} });
    check('like → liked, likes 1', a.status === 200 && a.json.liked === true && a.json.likes === 1, a.json);
    const b = await request('POST', `/api/worlds/${id}/like`, { dev: OTHER, body: {} });
    check('like again → unliked, likes 0', b.json.liked === false && b.json.likes === 0, b.json);
    const c = await request('POST', `/api/worlds/${id}/like`, { dev: OTHER, body: {} });
    const d = await request('POST', `/api/worlds/${id}/like`, { dev: THIRD, body: {} });
    check('two devices → likes 2', c.json.liked === true && d.json.likes === 2, { c: c.json, d: d.json });
    check('GET reflects liked per viewer', (await get(OTHER, id)).json.world.liked === true && (await get(OWNER, id)).json.world.liked === false);
    const anon = await request('POST', `/api/worlds/${id}/like`, { body: {} });
    check('like without device → 400', anon.status === 400, anon.json);
    const ghost = await request('POST', '/api/worlds/doesnotexist/like', { dev: OTHER, body: {} });
    check('like a missing world → 404', ghost.status === 404, ghost.status);
  });

  await section('Plays', async () => {
    const id = state.main.id;
    const a = await request('POST', `/api/worlds/${id}/play`, { dev: OTHER, body: {} });
    check('first play → 1', a.status === 200 && a.json.plays === 1, a.json);
    const b = await request('POST', `/api/worlds/${id}/play`, { dev: OTHER, body: {} });
    check('same device, same day → deduped', b.json.plays === 1, b.json);
    const c = await request('POST', `/api/worlds/${id}/play`, { dev: THIRD, body: {} });
    check('another device → 2', c.json.plays === 2, c.json);
    const ghost = await request('POST', '/api/worlds/doesnotexist/play', { dev: OTHER, body: {} });
    check('play a missing world → 404', ghost.status === 404, ghost.status);

    // Popular = plays + 5·likes + 8·forks: main (2 + 5·2 + 8·1 = 20) beats Blocky (0).
    const pop = await list(OTHER, { sort: 'popular', q: TOKEN });
    check('sort=popular orders by score', pop.json.worlds[0] && pop.json.worlds[0].id === state.main.id, pop.json.worlds.map((w) => [w.id, w.plays, w.likes, w.forks]));
  });

  await section('Store', async () => {
    const id = state.main.id;
    const set = await store(OTHER, id, { op: 'set', key: 'greeting', value: { text: 'hi', n: [1, 2] } });
    check('set → value', set.status === 200 && set.json.value?.text === 'hi' && JSON.stringify(set.json.value?.n) === '[1,2]', set.json);
    const getv = await store(THIRD, id, { op: 'get', key: 'greeting' });
    check('get (other device) → shared value', getv.json.value?.text === 'hi' && JSON.stringify(getv.json.value?.n) === '[1,2]', getv.json);
    const missing = await store(OTHER, id, { op: 'get', key: 'nope' });
    check('get missing → null', missing.status === 200 && missing.json.value === null, missing.json);
    const i1 = await store(OTHER, id, { op: 'incr', key: 'count' });
    const i2 = await store(THIRD, id, { op: 'incr', key: 'count', by: 5 });
    const i3 = await store(THIRD, id, { op: 'incr', key: 'count', by: -1.5 });
    check('incr → 1, +5 → 6, -1.5 → 4.5', i1.json.value === 1 && i2.json.value === 6 && i3.json.value === 4.5, [i1.json, i2.json, i3.json]);
    const iNan = await store(OTHER, id, { op: 'incr', key: 'greeting' });
    check('incr on a non-number restarts from 0', iNan.json.value === 1, iNan.json);
    const concurrent = await Promise.all(Array.from({ length: 10 }, () => store(OTHER, id, { op: 'incr', key: 'race' })));
    const final = await store(OTHER, id, { op: 'get', key: 'race' });
    check('10 concurrent incr → 10 (atomic)', concurrent.every((r) => r.status === 200) && final.json.value === 10, final.json);
    for (let i = 1; i <= 4; i++) await store(OTHER, id, { op: 'push', key: 'log', value: { i }, max: 3 });
    const log = await store(OTHER, id, { op: 'get', key: 'log' });
    check('push with max 3 keeps the newest 3', JSON.stringify(log.json.value) === '[{"i":2},{"i":3},{"i":4}]', log.json);
    const pushed = await store(OTHER, id, { op: 'push', key: 'log', value: 'x', max: 1000 });
    check('push returns the list (max clamped ≤ 200)', Array.isArray(pushed.json.value) && pushed.json.value.length === 4, pushed.json);
    const bigVal = await store(OTHER, id, { op: 'set', key: 'big', value: 'x'.repeat(9000) });
    check('value > 8 KB → 413', bigVal.status === 413, bigVal.json);
    const bigKey = await store(OTHER, id, { op: 'set', key: 'k'.repeat(65), value: 1 });
    check('key > 64 chars → 400', bigKey.status === 400 && bigKey.json.error === 'bad_key', bigKey.json);
    const badOp = await store(OTHER, id, { op: 'delete', key: 'x' });
    check('unknown op → 400', badOp.status === 400, badOp.json);
    const badBy = await store(OTHER, id, { op: 'incr', key: 'count', by: 'ten' });
    check('non-numeric by → 400', badBy.status === 400, badBy.json);
    const ghost = await store(OTHER, 'doesnotexist', { op: 'get', key: 'x' });
    check('store on a missing world → 404', ghost.status === 404, ghost.status);

    const m1 = await store(OTHER, id, { op: 'merge', key: 'c:0,0', value: { a: 1, b: 2 } });
    const m2 = await store(THIRD, id, { op: 'merge', key: 'c:0,0', value: { b: null, c: 3 } });
    check('merge adds up, null removes a field', m1.status === 200 && JSON.stringify(m2.json.value) === '{"a":1,"c":3}', [m1.json, m2.json]);
    const racing = await Promise.all(Array.from({ length: 12 }, (_, i) => store(i % 2 ? OTHER : THIRD, id, { op: 'merge', key: 'c:0,1', value: { [`k${i}`]: i } })));
    const raced = await store(OTHER, id, { op: 'get', key: 'c:0,1' });
    check('12 concurrent merges → all 12 fields (atomic)', racing.every((r) => r.status === 200) && Object.keys(raced.json.value || {}).length === 12, raced.json);
    await store(OTHER, id, { op: 'set', key: 'profile', value: { text: 'hi' } });
    const merged = await store(THIRD, id, { op: 'merge', key: 'profile', value: { more: true } });
    check('merge into a set object keeps its fields', merged.json.value?.text === 'hi' && merged.json.value?.more === true, merged.json);
    const notObject = await store(OTHER, id, { op: 'merge', key: 'c:0,0', value: [1] });
    check('merge with a non-object → 400', notObject.status === 400, notObject.json);
    await store(OTHER, id, { op: 'set', key: 'c:0,9', value: { big: 'x'.repeat(5000) } });
    const tooBig = await store(OTHER, id, { op: 'merge', key: 'c:0,9', value: { more: 'y'.repeat(5000) } });
    const unchanged = await store(OTHER, id, { op: 'get', key: 'c:0,9' });
    check('a merge that would pass 8 KB → 413, value unchanged', tooBig.status === 413 && unchanged.json.value?.more === undefined, tooBig.json);
    const nested = await store(OTHER, id, { op: 'merge', key: 'c:0,7', value: { arr: Array(3500).fill(1) } });
    check('a nested value close to 8 KB merges (measured as compact JSON)', nested.status === 200 && nested.json.value?.arr?.length === 3500, nested.status);
    const nulls = await store(OTHER, id, { op: 'merge', key: 'c:0,8', value: Object.fromEntries(Array.from({ length: 1200 }, (_, i) => ['key' + i, null])) });
    check('a patch over 8 KB (deletions count too) → 413', nulls.status === 413, nulls.status);
    const listed = await store(THIRD, id, { op: 'list', key: 'c:' });
    check('list(prefix) → every key with that prefix, in order', JSON.stringify(Object.keys(listed.json.value || {})) === '["c:0,0","c:0,1","c:0,7","c:0,9"]' && listed.json.value['c:0,0'].a === 1, Object.keys(listed.json.value || {}));
    const all = await store(THIRD, id, { op: 'list', key: '' });
    check("list('') → all keys", all.status === 200 && 'greeting' in (all.json.value || {}) && 'c:0,1' in (all.json.value || {}), Object.keys(all.json.value || {}));

    // 120 ops/min per device per world.
    const burst = await Promise.all(Array.from({ length: 125 }, () => store(STORE_DEV, id, { op: 'get', key: 'greeting' })));
    const limited = burst.filter((r) => r.status === 429);
    check('rate limit: 120/min per device per world', burst.filter((r) => r.status === 200).length === 120 && limited.length === 5, { ok: burst.filter((r) => r.status === 200).length, limited: limited.length });
    check('429 carries retryAfter + Retry-After', limited[0] && limited[0].json.error === 'rate_limited' && limited[0].json.retryAfter > 0 && Number(limited[0].headers.get('retry-after')) > 0, limited[0] && limited[0].json);
    const otherWorld = await store(STORE_DEV, state.fork.id, { op: 'get', key: 'greeting' });
    check('limit is per world', otherWorld.status === 200, otherWorld.status);
  });

  await section('Permissions & private worlds', async () => {
    const id = state.main.id;
    const edit = await patch(OTHER, id, { name: 'Hijacked' });
    check('another device cannot edit → 403 forbidden', edit.status === 403 && edit.json.error === 'forbidden', edit.json);
    const del = await request('DELETE', `/api/worlds/${id}`, { dev: OTHER });
    check('another device cannot delete → 403', del.status === 403, del.json);
    const anonEdit = await patch(undefined, id, { name: 'Hijacked' });
    check('anonymous cannot edit → 403', anonEdit.status === 403, anonEdit.json);
    const priv = await patch(OWNER, id, { visibility: 'private' });
    check('private without an account → 403 account_required', priv.status === 403 && priv.json.error === 'account_required', priv.json);
    const stillPublic = (await get(OTHER, id)).json.world;
    check('world stays public after the refused change', stillPublic.visibility === 'public' && stillPublic.name !== 'Hijacked', stillPublic.visibility);

    if (!SECRET || !TEST_USER) {
      skip('signed-in private-world checks', 'needs ORB_TEST_SECRET + ORB_TEST_USER for an external server');
      return;
    }
    const cookie = sessionCookie(TEST_USER);
    const me = await request('GET', '/api/me', { dev: ACCOUNT_DEV, cookie });
    check('session cookie → /api/me user', me.json.user && me.json.user.id === TEST_USER, me.json);

    // Chat sync (signed-in only)
    const anonChats = await request('GET', '/api/chats', { dev: ACCOUNT_DEV });
    check('chats need an account → 401', anonChats.status === 401, anonChats.status);
    const t0 = Date.now();
    const put1 = await request('PUT', '/api/chats/thread-abc', { dev: ACCOUNT_DEV, cookie, body: { worldId: 'w1', title: 'Castle', messages: [{ id: 'm1', role: 'user', text: 'hi', createdAt: t0 }], updatedAt: t0 } });
    check('save chat → ok', put1.status === 200, put1.json);
    const stale = await request('PUT', '/api/chats/thread-abc', { dev: ACCOUNT_DEV, cookie, body: { worldId: 'w1', title: 'Old', messages: [], updatedAt: t0 - 1000 } });
    const got = await request('GET', '/api/chats', { dev: ACCOUNT_DEV, cookie });
    const c = got.json.chats?.find((x) => x.thread.id === 'thread-abc');
    check('chat round-trips; older write ignored', stale.status === 200 && c && c.thread.title === 'Castle' && c.messages[0]?.text === 'hi' && c.thread.updatedAt === t0, got.json);
    const ghostCookie = sessionCookie(`ghost${RUN}`);
    const ghostWorld = await request('POST', '/api/worlds', { dev: ACCOUNT_DEV, cookie: ghostCookie, body: { code: html('ghost') } });
    check('session for a deleted user degrades to device ownership', ghostWorld.status === 201, ghostWorld.json);
    const ghostPriv = await patch(ACCOUNT_DEV, ghostWorld.json.world.id, { visibility: 'private' }, ghostCookie);
    check('…and cannot make worlds private', ghostPriv.status === 403 && ghostPriv.json.error === 'account_required', ghostPriv.json);

    const w = (await request('POST', '/api/worlds', { dev: ACCOUNT_DEV, cookie, body: { code: html('secret'), name: `Secret ${TOKEN}` } })).json.world;
    await request('PUT', `/api/worlds/${w.id}/thumb`, { dev: ACCOUNT_DEV, raw: WEBP, type: 'image/webp' });
    const p = await patch(ACCOUNT_DEV, w.id, { visibility: 'private' }, cookie);
    check('signed-in owner can make a world private', p.status === 200 && p.json.world.visibility === 'private', p.json);
    const hidden = await get(OTHER, w.id);
    check('private world is 404 for others', hidden.status === 404, hidden.status);
    const ownerView = await get(undefined, w.id, cookie);
    check('owner (session only, other device) can open it', ownerView.status === 200 && ownerView.json.world.canEdit === true, ownerView.status);
    const pubList = await list(OTHER, { q: TOKEN, sort: 'new' });
    check('private world hidden from Explore', !pubList.json.worlds.some((x) => x.id === w.id), pubList.json.worlds.map((x) => x.id));
    const mineList = await list(ACCOUNT_DEV, { mine: '1', q: TOKEN });
    check('private world listed in mine', mineList.json.worlds.some((x) => x.id === w.id && x.visibility === 'private'), mineList.json.worlds.map((x) => x.id));
    const thumbOther = await request('GET', `/api/worlds/${w.id}/thumb?v=1`);
    check('private thumbnail is 404 for others', thumbOther.status === 404, thumbOther.status);
    const thumbOwner = await request('GET', `/api/worlds/${w.id}/thumb?v=1`, { cookie });
    check('owner gets the private thumbnail, privately cached', thumbOwner.status === 200 && /private/.test(thumbOwner.headers.get('cache-control') || ''), thumbOwner.headers.get('cache-control'));
    const storeOther = await store(OTHER, w.id, { op: 'get', key: 'x' });
    check('private store is 404 for others', storeOther.status === 404, storeOther.status);
    const forkOther = await request('POST', `/api/worlds/${w.id}/fork`, { dev: OTHER, body: {} });
    check('others cannot fork a private world', forkOther.status === 404, forkOther.status);
    const versionsOther = await request('GET', `/api/worlds/${w.id}/versions`, { dev: OTHER });
    check('private versions are 404 for others', versionsOther.status === 404, versionsOther.status);
    const ownFork = await request('POST', `/api/worlds/${w.id}/fork`, { dev: ACCOUNT_DEV, cookie, body: {} });
    check('owner remix of a private world stays private', ownFork.status === 201 && ownFork.json.world.visibility === 'private', ownFork.json);
    const back = await patch(ACCOUNT_DEV, w.id, { visibility: 'public' }, cookie);
    check('owner can make it public again', back.json.world.visibility === 'public', back.json.world.visibility);
    state.accountWorlds = [w.id, ownFork.json.world.id, ghostWorld.json.world.id];
  });

  await section('Accounts with a username and password', async () => {
    const cookieOf = (r) => /orb_session=[^;]+/.exec(r.headers.get('set-cookie') || '')?.[0] ?? null;
    const signup = (dev, username, password) => request('POST', '/api/auth/signup', { dev, body: { username, password } });
    const signin = (dev, username, password) => request('POST', '/api/auth/signin', { dev, body: { username, password } });
    const pathOf = async (p) => (await request('GET', `/api/paths?handle=${p.split('/')[0]}&slug=${p.split('/')[1]}`)).json?.id;

    // An anonymous maker with a world, at a URL under the device's own handle.
    await request('PATCH', '/api/me', { dev: SIGNUP_DEV, body: { name: `Pip ${RUN}` } });
    const made = (await create(SIGNUP_DEV, { name: `Garden ${TOKEN}` })).json.world;
    check('an anonymous world lives under the device’s handle', made.path === `pip-${RUN}/garden-${TOKEN}`, made.path);

    for (const [name, username, password, error] of [
      ['a too-short username', 'ab', 'long enough pw', 'bad_username'],
      ['a reserved username', 'Explore', 'long enough pw', 'bad_username'],
      ['a too-short password', `ok${RUN}`, 'short', 'bad_password'],
    ]) {
      const r = await signup(SIGNUP_DEV, username, password);
      check(`sign-up refuses ${name} → 400 ${error}`, r.status === 400 && r.json.error === error, r.json);
    }

    const r = await signup(SIGNUP_DEV, `Star Builder ${RUN}`, 'correct horse');
    const cookie = cookieOf(r);
    const handle = `star-builder-${RUN}`;
    check('sign-up → the account, its username (the handle) and a session', r.status === 200 && !!cookie && r.json.user?.handle === handle && r.json.user?.name === `Star Builder ${RUN}` && r.json.user?.password === true, r.json);
    const mine = (await get(SIGNUP_DEV, made.id, cookie)).json.world;
    check('the device’s world moves to the username’s URLs', mine.path === `${handle}/garden-${TOKEN}` && mine.authorName === `Star Builder ${RUN}`, { path: mine.path, by: mine.authorName });
    check('…and its old URL still leads to it', (await pathOf(made.path)) === made.id && (await pathOf(mine.path)) === made.id);

    const taken = await signup(SIGNUP_DEV2, `STAR builder ${RUN}`, 'another pass');
    check('a username is taken however it is typed → 409', taken.status === 409 && taken.json.error === 'username_taken', taken.json);
    check('signing up gives the device the account’s name', (await request('GET', '/api/me', { dev: SIGNUP_DEV })).json?.name === `Star Builder ${RUN}`);
    const out = await request('POST', '/api/auth/logout', { dev: SIGNUP_DEV, cookie, body: {} });
    check('sign out', out.status === 200 && /orb_session=;/.test(out.headers.get('set-cookie') || ''), out.status);
    const guest = (await request('GET', '/api/me', { dev: SIGNUP_DEV })).json;
    check('…and the device forgets the account’s name (the browser picks a guest name)', guest?.user === null && guest?.name === '', guest);

    const wrong = await signin(SIGNUP_DEV2, handle, 'not my password');
    check('a wrong password → 401', wrong.status === 401 && wrong.json.error === 'wrong_password' && !cookieOf(wrong), wrong.json);
    const nobody = await signin(SIGNUP_DEV2, `nobody-${RUN}`, 'correct horse');
    check('an unknown username gets the same answer', nobody.status === 401 && nobody.json.message === wrong.json.message, nobody.json);
    const inAgain = await signin(SIGNUP_DEV2, `star builder ${RUN}`, 'correct horse');
    const cookie2 = cookieOf(inAgain);
    check('sign in on another device, the username typed loosely', inAgain.status === 200 && !!cookie2 && inAgain.json.user?.handle === handle, inAgain.json);
    const edit = await patch(SIGNUP_DEV2, made.id, { name: `Garden ${TOKEN} two` }, cookie2);
    check('…and edit the account’s world there', edit.status === 200, edit.json);

    const changed = await request('POST', '/api/auth/password', { dev: SIGNUP_DEV2, cookie: cookie2, body: { password: 'new secret 123' } });
    check('change the password while signed in', changed.status === 200 && changed.json.user?.password === true, changed.json);
    check('…the old one stops working, the new one works', (await signin(SIGNUP_DEV, handle, 'correct horse')).status === 401 && (await signin(SIGNUP_DEV, handle, 'new secret 123')).status === 200);
    check('setting a password needs an account → 401', (await request('POST', '/api/auth/password', { dev: SIGNUP_DEV2, body: { password: 'new secret 123' } })).status === 401);

    if (SECRET && TEST_USER) {
      // An account without a password (made with a passkey) adds one, and signs in with its username.
      const before = (await request('GET', '/api/me', { dev: ACCOUNT_DEV, cookie: sessionCookie(TEST_USER) })).json.user;
      const added = await request('POST', '/api/auth/password', { dev: ACCOUNT_DEV, cookie: sessionCookie(TEST_USER), body: { password: 'passkey people too' } });
      check('an account without a password can add one', before?.password === false && added.status === 200 && added.json.user?.password === true && !!added.json.user?.handle, { before, after: added.json.user });
      check('…then sign in with its username', (await signin(SIGNUP_DEV2, added.json.user?.handle ?? '', 'passkey people too')).json?.user?.id === TEST_USER);
    } else skip('adding a password to an account without one', 'needs ORB_TEST_SECRET + ORB_TEST_USER for an external server');

    const resetNoToken = await request('POST', '/api/admin/password', { body: { username: handle, password: 'reset pass 99' } });
    const reset = await request('POST', '/api/admin/password', { headers: { 'x-admin-token': ADMIN_TOKEN }, body: { username: `Star Builder ${RUN}`, password: 'reset pass 99' } });
    check('an admin resets a forgotten password (and nobody else can)', resetNoToken.status === 404 && reset.status === 200 && reset.json.username === handle && (await signin(SIGNUP_DEV2, handle, 'reset pass 99')).status === 200, reset.json);

    // Guessing is slow: 12 tries per username in 15 minutes.
    const victim = (await signup(SIGNUP_DEV2, `Guessme ${RUN}`, 'the real one')).json.user?.handle;
    let blocked = null;
    for (let i = 0; i < 13 && !blocked; i++) {
      const g = await signin(OTHER, victim, `guess ${i}`);
      if (g.status === 429) blocked = { at: i + 1, g };
    }
    check('the 13th guess at one username is turned away → 429', blocked?.at === 13 && Number(blocked.g.headers.get('retry-after')) > 0, blocked && { at: blocked.at });
    check('…even with the right password, for a while', (await signin(OTHER, victim, 'the real one')).status === 429);
  });

  await section('Friends', async () => {
    const cookieOf = (r) => /orb_session=[^;]+/.exec(r.headers.get('set-cookie') || '')?.[0] ?? null;
    const join = async (dev, username) => {
      const r = await request('POST', '/api/auth/signup', { dev, body: { username, password: 'friendly pass 1' } });
      return { dev, cookie: cookieOf(r), id: r.json?.user?.id, handle: r.json?.user?.handle, name: r.json?.user?.name };
    };
    const as = (who) => ({ dev: who.dev, cookie: who.cookie });
    const friendsOf = async (who) => (await request('GET', '/api/friends', as(who))).json;
    const add = (who, username) => request('POST', '/api/friends', { ...as(who), body: { username } });
    const sync = (who, worldId) => request('POST', '/api/friends/sync', { ...as(who), body: { worldId } });
    const profileOf = (who, handle) => request('GET', `/api/people/${handle}`, who ? as(who) : {});

    const out = await request('GET', '/api/friends', { dev: ADA_DEV });
    check('friends need an account → 401', out.status === 401 && out.json?.error === 'signed_out', out.json);
    check('…the heartbeat too', (await request('POST', '/api/friends/sync', { dev: ADA_DEV, body: { worldId: null } })).status === 401);

    const ada = await join(ADA_DEV, `Ada ${RUN}`);
    const bo = await join(BO_DEV, `Bo ${RUN}`);
    const cy = await join(CY_DEV, `Cy ${RUN}`);
    check('three accounts to be friends', !!(ada.cookie && bo.cookie && cy.cookie && ada.id && bo.id && cy.id), { ada: ada.handle, bo: bo.handle, cy: cy.handle });

    const empty = await friendsOf(ada);
    check('a new account has no friends, requests or notes', empty && !empty.friends.length && !empty.incoming.length && !empty.outgoing.length && !empty.notes.length && empty.unread === 0, empty);

    const asked = await add(ada, `@BO ${RUN}`);
    check('ask by username, typed loosely → requested', asked.status === 200 && asked.json.state === 'requested' && asked.json.person?.id === bo.id && asked.json.person?.handle === bo.handle, asked.json);
    check('…the request waits in your outgoing', asked.json.friends?.outgoing?.[0]?.id === bo.id && !asked.json.friends.friends.length, asked.json.friends);
    check('asking again changes nothing', (await add(ada, bo.handle)).json?.state === 'requested');
    const self = await add(ada, ada.handle);
    check('asking yourself → 400 self', self.status === 400 && self.json.error === 'self', self.json);
    const nobody = await add(ada, `nobody-${RUN}`);
    check('an unknown username → 404 with a hint', nobody.status === 404 && /spelling/.test(nobody.json.message), nobody.json);

    const boSees = await friendsOf(bo);
    check('they see the request, and one unread note (not two)', boSees.incoming?.[0]?.id === ada.id && boSees.incoming[0].handle === ada.handle && boSees.notes.length === 1 && boSees.notes[0].kind === 'friend_request' && boSees.notes[0].from.id === ada.id && boSees.unread === 1, boSees);

    const pIncoming = (await profileOf(bo, ada.handle)).json?.profile;
    const pYou = (await profileOf(ada, ada.handle)).json?.profile;
    const pNone = (await profileOf(cy, ada.handle)).json?.profile;
    const pOut = (await profileOf(null, ada.handle)).json?.profile;
    check('a profile says how you stand: incoming, you, none, signed out', pIncoming?.friend === 'incoming' && pYou?.friend === 'you' && pNone?.friend === 'none' && pOut?.friend === 'none', [pIncoming?.friend, pYou?.friend, pNone?.friend, pOut?.friend]);
    check('…with the maker’s name and account', pOut?.name === `Ada ${RUN}` && pOut?.id === ada.id && Array.isArray(pOut?.worlds) && pOut.online === false && pOut.world === null, pOut);
    check('no one at a handle → 404', (await profileOf(null, `nobody-${RUN}`)).status === 404);
    check('reserved paths are nobody’s profile → 404', (await profileOf(null, 'explore')).status === 404);

    const accepted = await request('POST', `/api/friends/${ada.id}`, { ...as(bo), body: {} });
    check('say yes → friends', accepted.status === 200 && accepted.json.friends.friends[0]?.id === ada.id && !accepted.json.friends.incoming.length, accepted.json);
    check('…their request note is read', accepted.json.friends.notes.every((n) => n.read) && accepted.json.friends.unread === 0, accepted.json.friends.notes);
    const adaNow = await friendsOf(ada);
    check('the asker is told (friend_accepted) and has a friend', adaNow.friends[0]?.id === bo.id && !adaNow.outgoing.length && adaNow.notes[0]?.kind === 'friend_accepted' && adaNow.notes[0].from.id === bo.id && adaNow.unread === 1, adaNow);
    check('both profiles say friends', (await profileOf(ada, bo.handle)).json?.profile?.friend === 'friends' && (await profileOf(bo, ada.handle)).json?.profile?.friend === 'friends');
    check('accepting twice is fine', (await request('POST', `/api/friends/${ada.id}`, { ...as(bo), body: {} })).status === 200);
    check('accepting a request no one made → 404', (await request('POST', `/api/friends/${cy.id}`, { ...as(bo), body: {} })).status === 404);

    // Bo makes a public world (listed: named, with a picture) and a private one.
    // The browser still sends the guest name it had before signing up: the world takes the account's.
    const made = (await request('POST', '/api/worlds', { ...as(bo), body: { code: html('castle'), name: `Bo Castle ${TOKEN}`, authorName: 'Starry Orca' } })).json?.world;
    check('an account’s new world carries its name, not the browser’s old guest name', made?.authorName === bo.name, made?.authorName);
    check('…and the device keeps the account’s name', (await request('GET', '/api/me', as(bo))).json?.name === bo.name);
    await request('PUT', `/api/worlds/${made?.id}/thumb`, { ...as(bo), raw: WEBP, type: 'image/webp' });
    const secret = (await request('POST', '/api/worlds', { ...as(bo), body: { code: html('secret'), name: `Bo Secret ${TOKEN}` } })).json?.world;
    await request('PATCH', `/api/worlds/${secret?.id}`, { ...as(bo), body: { visibility: 'private' } });
    state.friendWorlds = [made?.id, secret?.id].filter(Boolean);

    const fw = (await request('GET', '/api/friends/worlds', as(ada))).json;
    check('friends’ worlds for the start screen', fw?.worlds?.some((w) => w.id === made.id) && !fw.worlds.some((w) => w.id === secret.id), fw?.worlds?.map((w) => w.name));
    const boProfile = (await profileOf(null, bo.handle)).json?.profile;
    check('a profile lists the maker’s public worlds', boProfile?.worlds?.some((w) => w.id === made.id) && !boProfile.worlds.some((w) => w.id === secret.id), boProfile?.worlds?.map((w) => w.name));

    const beat = await sync(bo, made.id);
    check('a heartbeat answers with your friends', beat.status === 200 && beat.json.friends?.[0]?.id === ada.id, beat.json);
    let b = (await friendsOf(ada)).friends.find((f) => f.id === bo.id);
    check('friends see you online, in your world (making it)', b?.online === true && b.world?.id === made.id && b.world.name === `Bo Castle ${TOKEN}` && b.own === true && !!b.seenAt, b);
    const pBo = (await profileOf(ada, bo.handle)).json?.profile;
    check('…on your profile too', pBo?.online === true && pBo.world?.id === made.id && pBo.own === true, pBo && { online: pBo.online, world: pBo.world?.id });
    check('…but not to someone who isn’t a friend', (await profileOf(cy, bo.handle)).json?.profile?.world === null);

    await sync(bo, secret.id);
    b = (await friendsOf(ada)).friends.find((f) => f.id === bo.id);
    check('in a private world: online, but where stays private', b?.online === true && b.world === null, b);
    await sync(bo, 'not a world id!');
    check('a malformed world id is no world', (await friendsOf(ada)).friends.find((f) => f.id === bo.id)?.world === null);

    await sync(ada, made.id);
    b = (await friendsOf(bo)).friends.find((f) => f.id === ada.id);
    check('playing someone else’s world is not making it', b?.world?.id === made.id && b.own === false, b);

    // Rooms: friends can tell your page apart in a world's rooms, and join you in the same one.
    const peerA = 'abcdef012345:k3j2h1', peerM = 'abcdef012345:zz9x8c';
    const roomsBeat = await request('POST', '/api/friends/sync', { ...as(bo), body: { worldId: made.id, rooms: [{ room: '', peer: peerA }, { room: 'match-1', peer: peerM }, { room: 'bad room', peer: 'x:y' }, { room: '', peer: 'dup000000000:aaaaaa' }, 'junk'] } });
    b = (await friendsOf(ada)).friends.find((f) => f.id === bo.id);
    check('a heartbeat names your rooms; friends get them (bad ones and repeats dropped)', roomsBeat.status === 200 && JSON.stringify(b?.rooms) === JSON.stringify([{ room: '', peer: peerA }, { room: 'match-1', peer: peerM }]), b?.rooms);
    check('…on your profile too', JSON.stringify((await profileOf(ada, bo.handle)).json?.profile?.rooms) === JSON.stringify(b?.rooms));
    check('…but not to someone who isn’t a friend', ((await profileOf(cy, bo.handle)).json?.profile?.rooms ?? []).length === 0);
    await request('POST', '/api/friends/sync', { ...as(bo), body: { worldId: secret.id, rooms: [{ room: '', peer: peerA }] } });
    b = (await friendsOf(ada)).friends.find((f) => f.id === bo.id);
    check('in a private world, no rooms either', b?.world === null && b.rooms.length === 0, b);
    await request('POST', '/api/friends/sync', { ...as(bo), body: { worldId: made.id } });
    b = (await friendsOf(ada)).friends.find((f) => f.id === bo.id);
    check('a heartbeat without rooms clears them', b?.world?.id === made.id && b.rooms.length === 0, b?.rooms);

    const left = await request('POST', '/api/friends/sync', { ...as(bo), body: { leave: true } });
    b = (await friendsOf(ada)).friends.find((f) => f.id === bo.id);
    check('leaving the page → offline at once, last seen kept', left.status === 200 && b?.online === false && b.world === null && !!b.seenAt, b);

    // Invites.
    const inv = await request('POST', '/api/friends/invite', { ...as(ada), body: { worldId: made.id, to: [bo.id] } });
    check('invite a friend into a world', inv.status === 200 && inv.json.invited === 1, inv.json);
    const boInvited = await friendsOf(bo);
    const note = boInvited.notes.find((n) => n.kind === 'invite');
    check('…they get a note with the world, unread', note?.from.id === ada.id && note.world?.id === made.id && note.world.name === `Bo Castle ${TOKEN}` && note.read === false && boInvited.unread >= 1, note);
    check('inviting again right away doesn’t send a second', (await request('POST', '/api/friends/invite', { ...as(ada), body: { worldId: made.id, to: [bo.id] } })).json?.invited === 0);
    check('only friends get invites', (await request('POST', '/api/friends/invite', { ...as(ada), body: { worldId: made.id, to: [cy.id] } })).json?.invited === 0);
    const priv = await request('POST', '/api/friends/invite', { ...as(bo), body: { worldId: secret.id, to: [ada.id] } });
    check('a private world can’t take invites → 400', priv.status === 400 && priv.json.error === 'private_world', priv.json);
    check('an invite needs someone → 400', (await request('POST', '/api/friends/invite', { ...as(ada), body: { worldId: made.id, to: [] } })).status === 400);
    check('…and a world → 404', (await request('POST', '/api/friends/invite', { ...as(ada), body: { worldId: 'nope', to: [bo.id] } })).status === 404);

    const readOne = await request('POST', '/api/friends/read', { ...as(bo), body: { ids: [note.id] } });
    const afterOne = await friendsOf(bo);
    check('mark one note read', readOne.status === 200 && afterOne.notes.find((n) => n.id === note.id)?.read === true, afterOne.notes);
    await request('POST', '/api/friends/read', { ...as(ada), body: {} });
    check('mark all read', (await friendsOf(ada)).unread === 0);

    // Turning down, taking back, and asking back.
    await add(cy, ada.handle);
    const declined = await request('DELETE', `/api/friends/${cy.id}`, as(ada));
    const cyAfter = await friendsOf(cy);
    check('turn a request down: gone for both, quietly', declined.status === 200 && !declined.json.friends.incoming.length && !declined.json.friends.notes.some((n) => n.from.id === cy.id) && !cyAfter.outgoing.length && !cyAfter.notes.length, { ada: declined.json.friends, cy: cyAfter });
    await add(cy, bo.handle);
    await request('DELETE', `/api/friends/${bo.id}`, as(cy));
    const boAfter = await friendsOf(bo);
    check('take a request back: their note goes too', !boAfter.incoming.length && !boAfter.notes.some((n) => n.from.id === cy.id), boAfter);
    await add(cy, ada.handle);
    const back = await add(ada, cy.handle);
    check('asking someone who asked you is saying yes', back.json?.state === 'friends' && back.json.friends.friends.some((f) => f.id === cy.id) && !back.json.friends.incoming.length, back.json);
    check('…and they hear about it', (await friendsOf(cy)).notes.some((n) => n.kind === 'friend_accepted' && n.from.id === ada.id));

    const adaFriends = (await friendsOf(ada)).friends;
    check('friends who were online come first', adaFriends.length === 2 && adaFriends[0].id === bo.id && adaFriends[1].id === cy.id, adaFriends.map((f) => f.name));
    const pAda = (await profileOf(null, ada.handle)).json?.profile;
    check('a profile counts friends', pAda?.friendCount === 2, pAda?.friendCount);

    const unfriend = await request('DELETE', `/api/friends/${bo.id}`, as(ada));
    check('unfriend: gone from both lists', unfriend.status === 200 && !unfriend.json.friends.friends.some((f) => f.id === bo.id) && !(await friendsOf(bo)).friends.some((f) => f.id === ada.id));
    check('…their invites go with it', !(await friendsOf(bo)).notes.some((n) => n.from.id === ada.id));
    check('…and profiles say none again', (await profileOf(ada, bo.handle)).json?.profile?.friend === 'none');
    check('a malformed friend id → 404', (await request('DELETE', '/api/friends/not%20an%20id', as(ada))).status === 404);

    // A maker without an account has a profile, but can't be added.
    await request('PATCH', '/api/me', { dev: GUS_DEV, body: { name: `Gus ${RUN}` } });
    const gusWorld = (await create(GUS_DEV, { name: `Gus Garden ${TOKEN}` })).json?.world;
    state.friendWorlds.push(gusWorld?.id);
    const gusHandle = gusWorld?.path?.split('/')[0];
    const gus = (await profileOf(ada, gusHandle)).json?.profile;
    check('a maker without an account: a profile, no friend button', gus?.id === null && gus.name === `Gus ${RUN}` && gus.friend === 'none' && gus.friendCount === 0, gus);
    check('…and their username can’t be added', (await add(ada, gusHandle)).status === 404);

    // Pages: /<handle> is the profile, a handle no one has is the 404 page.
    const page = await request('GET', `/${ada.handle}`);
    check('GET /<handle> → the profile page', page.status === 200 && page.text.includes(`Ada ${RUN}`), page.status);
    check('GET /<no one> → 404', (await request('GET', `/nobody-${RUN}`)).status === 404);
    check('/explore is still Explore', (await request('GET', '/explore')).text.includes('Explore worlds'));

    for (const id of state.friendWorlds) {
      for (const who of [bo, { dev: GUS_DEV }]) {
        const r = await request('DELETE', `/api/worlds/${id}`, as(who));
        if (r.status === 200) break;
      }
    }
  });

  await section('Remix credit', async () => {
    const cookieOf = (r) => /orb_session=[^;]+/.exec(r.headers.get('set-cookie') || '')?.[0] ?? null;
    const join = async (dev, username) => {
      const r = await request('POST', '/api/auth/signup', { dev, body: { username, password: 'friendly pass 1' } });
      return { dev, cookie: cookieOf(r), id: r.json?.user?.id, name: r.json?.user?.name };
    };
    const maker = await join(RX_MAKER_DEV, `Maker ${RUN}`);
    const fan = await join(RX_FAN_DEV, `Fan ${RUN}`);
    const asM = { dev: maker.dev, cookie: maker.cookie };
    const asF = { dev: fan.dev, cookie: fan.cookie };
    const anon = { dev: RX_ANON_DEV };
    const remixNotes = async (who) => (await request('GET', '/api/friends', who)).json?.notes?.filter((n) => n.kind === 'remix') ?? [];
    const orig = (await request('POST', '/api/worlds', { ...asM, body: { code: html('orig'), name: `Rx Orig ${TOKEN}` } })).json?.world;
    check('a maker and a fan with accounts, and a public world', !!(maker.cookie && fan.cookie && orig?.id), { maker: maker.id, fan: fan.id });

    const copy = (await request('POST', `/api/worlds/${orig.id}/fork`, { ...asF, body: {} })).json?.world;
    check('an untouched copy credits no one yet (and isn’t counted)', (await remixNotes(asM)).length === 0 && (await request('GET', `/api/worlds/${orig.id}`, asM)).json?.world?.remixes === 0);
    await request('PATCH', `/api/worlds/${copy.id}`, { ...asF, body: { code: html('fan version') } });
    let notes = await remixNotes(asM);
    check('its first change: the maker hears who remixed which world', notes.length === 1 && notes[0].from.id === fan.id && notes[0].from.name === fan.name && notes[0].world?.id === copy.id && notes[0].world.forkedFrom?.id === orig.id && notes[0].read === false, notes);
    await request('PATCH', `/api/worlds/${copy.id}`, { ...asF, body: { code: html('fan version 2') } });
    check('…once, not for every change after', (await remixNotes(asM)).length === 1);

    await request('PATCH', '/api/me', { ...anon, body: { name: `Anon ${RUN}` } });
    const anonCopy = (await request('POST', `/api/worlds/${orig.id}/fork`, { ...anon, body: { authorName: `Anon ${RUN}` } })).json?.world;
    await request('PATCH', `/api/worlds/${anonCopy.id}`, { ...anon, body: { code: html('anon version') } });
    notes = await remixNotes(asM);
    check('a remixer without an account is credited by the name on their remix', notes.length === 2 && notes[0].world?.id === anonCopy.id && notes[0].from.id === '' && notes[0].from.name === `Anon ${RUN}` && notes[0].from.handle === null, notes[0]);

    const own = (await request('POST', `/api/worlds/${orig.id}/fork`, { ...asM, body: {} })).json?.world;
    await request('PATCH', `/api/worlds/${own.id}`, { ...asM, body: { code: html('mine again') } });
    check('remixing your own world tells you nothing', (await remixNotes(asM)).length === 2);

    const full = (await request('GET', `/api/worlds/${orig.id}`)).json?.world;
    const list = (await request('GET', `/api/worlds/${orig.id}/remixes`)).json;
    check('the original counts its changed public remixes', full?.remixes === 3, full?.remixes);
    check('…and lists them, newest first', list?.worlds?.map((w) => w.id).join() === [own.id, anonCopy.id, copy.id].join(), list?.worlds?.map((w) => w.name));
    await request('PATCH', `/api/worlds/${copy.id}`, { ...asF, body: { visibility: 'private' } });
    const after = (await request('GET', `/api/worlds/${orig.id}/remixes`)).json;
    check('a remix made private leaves the list, and its note goes quiet', !after?.worlds?.some((w) => w.id === copy.id) && !(await remixNotes(asM)).some((n) => n.world?.id === copy.id), after?.worlds?.map((w) => w.id));
    check('remixes of a world nobody has → an empty list', (await request('GET', '/api/worlds/zzzzzzzzzz/remixes')).json?.worlds?.length === 0);

    for (const [id, who] of [[copy.id, asF], [anonCopy.id, anon], [own.id, asM], [orig.id, asM]]) await request('DELETE', `/api/worlds/${id}`, who);
  });

  await section('Shops in worlds', async () => {
    const cookieOf = (r) => /orb_session=[^;]+/.exec(r.headers.get('set-cookie') || '')?.[0] ?? null;
    const join = async (dev, username) => {
      const r = await request('POST', '/api/auth/signup', { dev, body: { username, password: 'friendly pass 1' } });
      return { dev, cookie: cookieOf(r), id: r.json?.user?.id };
    };
    const maker = await join(SHOP_MAKER_DEV, `Seller ${RUN}`);
    const buyer = await join(SHOP_BUYER_DEV, `Buyer ${RUN}`);
    const asM = { dev: maker.dev, cookie: maker.cookie };
    const asB = { dev: buyer.dev, cookie: buyer.cookie };
    const anon = { dev: SHOP_ANON_DEV };
    const items = [
      { id: 'star-hat', name: 'Star Hat', price: 40, emoji: '⭐', description: 'Twinkles' },
      { id: 'moon-boots', name: 'Moon Boots', price: 25 },
      { id: 'comet', name: 'Comet', price: 1000 },
      { id: 'Bad Id!', name: 'Nope', price: 5 },
      { id: 'free-thing', name: 'Free', price: 0 },
      { id: 'star-hat', name: 'Star Hat again', price: 2 },
    ];
    const page = `<!doctype html><html><head><title>shop</title><script type="application/json" id="orb-shop">${JSON.stringify({ items })}</script></head><body>shop ${RUN}</body></html>`;
    const world = (await request('POST', '/api/worlds', { ...asM, body: { code: page, name: `Hat Shop ${TOKEN}` } })).json?.world;
    const shop = (who, id = world.id) => request('GET', `/api/worlds/${id}/shop`, who);
    const buy = (who, item, price, id = world.id) => request('POST', `/api/worlds/${id}/shop`, { ...who, body: { item, price } });
    const sales = async () => (await request('GET', '/api/friends', asM)).json?.notes?.filter((n) => n.kind === 'sale') ?? [];
    check('a maker and a buyer with accounts, and a world with a shop', !!(maker.cookie && buyer.cookie && world?.id));

    let v = (await shop(anon)).json;
    check('the shop lists what fits (ids, prices 1–1000, once each)', v?.items?.map((i) => `${i.id}:${i.price}`).join() === 'star-hat:40,moon-boots:25,comet:1000' && v.items[0].emoji === '⭐' && v.items[0].description === 'Twinkles' && v.items[1].emoji === null, v?.items);
    check('…signed out: nothing owned, no credits shown', v.signedIn === false && v.credits === null && v.owned.length === 0 && v.mine === false, v);
    const out = await buy(anon, 'star-hat', 40);
    check('buying needs an account → 401', out.status === 401 && out.json?.error === 'account_required', out.json);

    v = (await shop(asB)).json;
    const start = v?.credits;
    check('signed in: their credits', v?.signedIn === true && start > 100 && v.owned.length === 0, v);
    const stale = await buy(asB, 'star-hat', 30);
    check('a price that isn’t the price → 409 price_changed, with the price', stale.status === 409 && stale.json?.error === 'price_changed' && stale.json.price === 40, stale.json);
    const nope = await buy(asB, 'unicorn', 5);
    check('an item the world doesn’t sell → 404', nope.status === 404 && nope.json?.error === 'unknown_item', nope.json);
    const got = await buy(asB, 'star-hat', 40);
    check('bought: the price leaves their credits and it’s theirs', got.status === 200 && got.json.charged === 40 && got.json.credits === start - 40 && got.json.owned.join() === 'star-hat' && got.json.already === false, got.json);
    const twice = await buy(asB, 'star-hat', 40);
    check('…once: buying it again charges nothing', twice.status === 200 && twice.json.already === true && twice.json.charged === 0 && twice.json.credits === start - 40, twice.json);
    const broke = await buy(asB, 'comet', 1000);
    if (SHOP_DAILY && SHOP_DAILY < 1040) check('more than a day’s spending in worlds → 429 daily_limit, before credits are counted', broke.status === 429 && broke.json?.error === 'daily_limit', broke.json);
    else check('not enough credits → 402, with how many more', broke.status === 402 && broke.json?.error === 'no_credits' && broke.json.need === 1000 - (start - 40), broke.json);
    const bill = (await request('GET', '/api/billing', asB)).json;
    check('…the wallet says the same', bill?.credits?.left === start - 40, bill?.credits);
    check('the plans say what makers earn of paid credits spent in their worlds', bill?.plans?.shopShare === 1, bill?.plans);

    let notes = await sales();
    check('the maker hears about the sale, from “someone”', notes.length === 1 && notes[0].world?.id === world.id && notes[0].sale?.count === 1 && notes[0].sale.item === 'Star Hat' && notes[0].from.name === 'Someone' && notes[0].from.id === '' && notes[0].read === false, notes);
    check('…free credits earn nobody anything', notes[0]?.sale?.credits === 0 && (await request('GET', '/api/billing', asM)).json?.earnings?.credits === 0);
    await buy(asB, 'moon-boots', 25);
    notes = await sales();
    check('another sale adds up in the same note', notes.length === 1 && notes[0].sale?.count === 2 && notes[0].sale.item === 'Moon Boots', notes);

    const mine = (await shop(asM)).json;
    const own = await buy(asM, 'comet', 1000);
    check('the maker tries their own things for free', mine?.mine === true && own.status === 200 && own.json.charged === 0 && own.json.owned.includes('comet') && own.json.credits === mine.credits, { mine, own: own.json });
    check('…and isn’t told they bought something', (await sales())[0]?.sale?.count === 2);
    const nothing = await request('POST', '/api/billing/earnings', asM);
    check('using earnings with none moves nothing', nothing.status === 200 && nothing.json?.earnings?.credits === 0 && nothing.json.credits.topup === 0, nothing.json?.earnings);
    check('…and needs an account → 401', (await request('POST', '/api/billing/earnings', anon)).status === 401);

    await request('PATCH', `/api/worlds/${world.id}`, { ...asM, body: { visibility: 'private' } });
    check('a private world’s shop is the maker’s alone → 404', (await shop(asB)).status === 404 && (await buy(asB, 'moon-boots', 25)).status === 404 && (await shop(asM)).status === 200);
    check('no world → 404', (await shop(asB, 'zzzzzzzzzz')).status === 404);
    const plain = (await request('POST', '/api/worlds', { ...asM, body: { code: html('no shop'), name: `Plain ${TOKEN}` } })).json?.world;
    check('a world without a shop sells nothing', (await shop(asB, plain.id)).json?.items?.length === 0);

    const vz = await shop(asB, 'orb-vampirez');
    if (vz.status !== 200 || !vz.json.items.length) skip('Orb’s own world’s shop', 'VampireZ isn’t in this database');
    else {
      check('an Original sells what its repository’s page lists', vz.json.items.some((i) => i.id === 'blood-pass' && i.price === 750) && vz.json.mine === false, vz.json.items.map((i) => `${i.id} ${i.price}`));
      const priceOf = (id) => vz.json.items.find((i) => i.id === id)?.price;
      // A buyer who hasn't spent anything today: the title alone is a day's spending on this test server (ORB_SHOP_DAILY = 100).
      const fan = await join(device('shop-vz'), `Night fan ${RUN}`);
      const asF = { dev: fan.dev, cookie: fan.cookie };
      const fanStart = (await shop(asF, 'orb-vampirez')).json?.credits;
      const title = await buy(asF, 'title-patron', priceOf('title-patron'), 'orb-vampirez');
      check('buying in Orb’s own world: Orb keeps it (no maker to pay)', title.status === 200 && title.json.charged === priceOf('title-patron') && title.json.credits === fanStart - priceOf('title-patron'), title.json);
      if (SHOP_DAILY === 100) {
        const cap = await buy(asF, 'cape-starlight', priceOf('cape-starlight'), 'orb-vampirez');
        check('a day’s spending in worlds is capped (ORB_SHOP_DAILY) → 429', cap.status === 429 && cap.json?.error === 'daily_limit', cap.json);
      } else skip('daily cap', 'ORB_SHOP_DAILY of the running server is unknown');
    }
    for (const id of [world.id, plain.id]) await request('DELETE', `/api/worlds/${id}`, asM);
  });

  await section('Looks for the blob', async () => {
    const anon = { dev: LOOKS_ANON_DEV };
    const out = await request('GET', '/api/looks', anon);
    check('signed out: Orb’s things to wear with their prices, nothing owned, no credits', out.status === 200 && out.json.items.length >= 10 && out.json.items.every((i) => i.price > 0 && (i.slot === 'head' || i.slot === 'face')) && out.json.signedIn === false && out.json.credits === null, out.json);
    check('…buying needs an account → 401', (await request('POST', '/api/looks/buy', { ...anon, body: { item: 'crown', price: 80 } })).status === 401);

    const r = await request('POST', '/api/auth/signup', { dev: LOOKS_DEV, body: { username: `Blob ${RUN}`, password: 'friendly pass 1' } });
    const as = { dev: LOOKS_DEV, cookie: /orb_session=[^;]+/.exec(r.headers.get('set-cookie') || '')?.[0] ?? null };
    const fresh = (await request('GET', '/api/looks', as)).json;
    // The cheapest look: it fits a Free month and this test server's day of spending (ORB_SHOP_DAILY).
    const cheap = fresh.items?.reduce((a, b) => (b.price < a.price ? b : a));
    const pricey = fresh.items?.find((i) => i.id !== cheap?.id);
    check('signed in: their credits, nothing worn yet', fresh.signedIn === true && typeof fresh.credits === 'number' && fresh.look.wear.length === 0 && !!cheap && !!pricey, fresh);
    const wrong = await request('POST', '/api/looks/buy', { ...as, body: { item: cheap.id, price: cheap.price + 1 } });
    check('a price that isn’t the price → 409 price_changed', wrong.status === 409 && wrong.json?.error === 'price_changed', wrong.json);
    const bought = await request('POST', '/api/looks/buy', { ...as, body: { item: cheap.id, price: cheap.price } });
    check('bought: the price leaves their credits, it’s theirs and they wear it', bought.status === 200 && bought.json.owned.includes(cheap.id) && bought.json.look.wear.join() === cheap.id && bought.json.credits === fresh.credits - cheap.price, bought.json);
    const me = (await request('GET', '/api/me', as)).json;
    check('…their account says what their blob wears (worlds get it from there)', me?.user?.look?.wear?.join() === cheap.id, me?.user);
    const colored = await request('PATCH', '/api/looks', { ...as, body: { color: '#5EC8FF' } });
    check('a color of the palette is kept with the account', colored.status === 200 && colored.json.look.color === '#5ec8ff' && colored.json.look.wear.join() === cheap.id, colored.json);
    check('…any other color → 400', (await request('PATCH', '/api/looks', { ...as, body: { color: '#123456' } })).status === 400);
    const notMine = await request('PATCH', '/api/looks', { ...as, body: { wear: [pricey.id] } });
    check('wearing something they don’t have → 403 not_owned', notMine.status === 403 && notMine.json?.error === 'not_owned', notMine.json);
    const off = await request('PATCH', '/api/looks', { ...as, body: { wear: [] } });
    check('taking it off; it stays theirs', off.status === 200 && off.json.look.wear.length === 0 && off.json.owned.includes(cheap.id), off.json);
  });

  await section('Admin', async () => {
    const id = state.main.id;
    const noToken = await request('POST', `/api/admin/worlds/${id}`, { body: { verified: true } });
    check('no admin token → 401', noToken.status === 401, noToken.json);
    const wrong = await request('POST', `/api/admin/worlds/${id}`, { body: { verified: true }, headers: { 'x-admin-token': 'nope' } });
    check('wrong admin token → 401', wrong.status === 401, wrong.json);
    const ok = await request('POST', `/api/admin/worlds/${id}`, { body: { verified: true, featured: 7 }, headers: { 'x-admin-token': ADMIN_TOKEN } });
    if (ok.status === 401) {
      skip('admin verify', 'the running server has a different ORB_ADMIN_TOKEN (set ORB_ADMIN_TOKEN for the test)');
      return;
    }
    check('admin verify → { ok: true }', ok.status === 200 && ok.json.ok === true, ok.json);
    const w = (await get(OTHER, id)).json.world;
    check('world is verified + featured', w.verified === true && w.featured === 7, { verified: w.verified, featured: w.featured });
    const verified = await list(OTHER, { verified: '1', q: TOKEN });
    check('verified=1 filter', verified.json.worlds.map((x) => x.id).join() === id, verified.json.worlds.map((x) => x.id));
    const featured = await list(OTHER, { sort: 'featured', q: TOKEN });
    check('sort=featured puts it first', featured.json.worlds[0] && featured.json.worlds[0].id === id, featured.json.worlds.map((x) => x.id));
    const before = w.tags;
    const tagged = await request('POST', `/api/admin/worlds/${id}`, { body: { tags: ['Game', 'keyboard'] }, headers: { 'x-admin-token': ADMIN_TOKEN } });
    check('admin sets tags (e.g. keyboard)', tagged.status === 200 && JSON.stringify((await get(OTHER, id)).json.world.tags) === '["game","keyboard"]', tagged.json);
    const notTags = await request('POST', `/api/admin/worlds/${id}`, { body: { tags: 'keyboard' }, headers: { 'x-admin-token': ADMIN_TOKEN } });
    check('tags that are not a list → 400', notTags.status === 400, notTags.json);
    await request('POST', `/api/admin/worlds/${id}`, { body: { tags: before }, headers: { 'x-admin-token': ADMIN_TOKEN } });
    const bad = await request('POST', `/api/admin/worlds/${id}`, { body: { featured: 'top' }, headers: { 'x-admin-token': ADMIN_TOKEN } });
    check('bad admin body → 400', bad.status === 400, bad.json);
    const ghost = await request('POST', '/api/admin/worlds/doesnotexist', { body: { verified: true }, headers: { 'x-admin-token': ADMIN_TOKEN } });
    check('admin on a missing world → 404', ghost.status === 404, ghost.status);

    // A curated embed handed to an account (like Orbitfall): its owner edits how it's listed, not its page.
    if (!SECRET || !TEST_USER) return skip('a handed-over embed', 'needs ORB_TEST_SECRET + ORB_TEST_USER for an external server');
    const seeds = JSON.parse(fs.readFileSync(path.join(root, 'src/data/seeds.json'), 'utf8'));
    const embed = seeds.filter((s) => s.hidden && !s.native)[1];
    const cookie = sessionCookie(TEST_USER);
    const handed = await request('POST', `/api/admin/worlds/${embed.id}`, { body: { ownerUser: TEST_USER, authorName: 'Tester' }, headers: { 'x-admin-token': ADMIN_TOKEN } });
    check('admin hands an embed to an account', handed.status === 200, handed.json);
    const renamed = await patch(ACCOUNT_DEV, embed.id, { name: `Handed ${TOKEN}`, visibility: 'private' }, cookie);
    check('its owner renames it and makes it private', renamed.status === 200 && renamed.json.world.name === `Handed ${TOKEN}` && renamed.json.world.visibility === 'private', renamed.json);
    const recoded = await patch(ACCOUNT_DEV, embed.id, { code: html('mine now') }, cookie);
    check('…but cannot give it code', recoded.status === 400 && recoded.json.error === 'not_editable', recoded.json);
    // Deleted, it comes back as Orb's on the next cold start (it is still a seed).
    await request('DELETE', `/api/worlds/${embed.id}`, { dev: ACCOUNT_DEV, cookie });
  });

  await section('Rename author', async () => {
    const r = await request('PATCH', '/api/me', { dev: OWNER, body: { name: `Golden Comet ${RUN}` } });
    check('PATCH /api/me → new name', r.json.name === `Golden Comet ${RUN}`, r.json);
    const w = (await get(OTHER, state.main.id)).json.world;
    check("owner's worlds show the new author name", w.authorName === `Golden Comet ${RUN}`, w.authorName);
    const f = (await get(OTHER, state.fork.id)).json.world;
    check("other people's remixes keep their author", f.authorName === 'Brave Fox', f.authorName);
  });

  await section('Free builder limits', async () => {
    if (!FREE_PER_DEVICE) {
      skip('daily free builds per device', 'set ORB_TEST_FREE_PER_DEVICE to the running server’s ORB_FREE_DAILY_PER_DEVICE');
      return;
    }
    // Only the status matters: the build itself keeps going on the server, so stop reading.
    const build = async (dev, worldId) => {
      const res = await fetch(`${BASE}/api/agent/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orb-device': dev },
        body: JSON.stringify({ worldId, messages: [{ role: 'user', content: `a tiny red cube ${RUN}` }], mode: 'build' }),
        signal: AbortSignal.timeout(60_000),
      });
      const json = (res.headers.get('content-type') || '').includes('application/json') ? await res.json() : null;
      if (!json) await res.body?.cancel().catch(() => {});
      return { status: res.status, json, retryAfter: Number(res.headers.get('retry-after')) };
    };
    const cube = (await create(BUILDER, { name: `Cube ${RUN}` })).json.world;
    const allowed = [];
    for (let i = 0; i < FREE_PER_DEVICE; i++) allowed.push((await build(BUILDER, cube.id)).status);
    check(`${FREE_PER_DEVICE} free builds a day per device → 200`, allowed.every((s) => s === 200), allowed);
    const over = await build(BUILDER, cube.id);
    check(
      'the next one → 429 until UTC midnight',
      over.status === 429 && over.json?.error === 'rate_limited' && /today/.test(over.json.message) && over.json.retryAfter > 0 && over.json.retryAfter <= 86400 && over.retryAfter === over.json.retryAfter,
      { status: over.status, json: over.json },
    );
    const theirs = (await create(BUILDER2, { name: `Cube two ${RUN}` })).json.world;
    const other = await build(BUILDER2, theirs.id);
    check('another device still builds', other.status === 200, other.status);
  });

  await section('One kind of build', async () => {
    // Every build is an agent job on the server, charged as it goes: the single-shot builder and
    // the rounds a browser ran with its own key are gone.
    for (const route of ['/api/build', '/api/build/cursor', '/api/build/jobs/x', '/api/traces']) {
      const r = await request('POST', route, { dev: BUILDER, body: { messages: [{ role: 'user', content: 'a cube' }], mode: 'build' } });
      check(`POST ${route} → 404`, r.status === 404 && r.json?.error === 'not_found', { status: r.status, json: r.json });
    }
    const noWorld = await request('POST', '/api/agent/jobs', { dev: BUILDER, body: { messages: [{ role: 'user', content: 'a cube' }], mode: 'build' } });
    check('a build needs a world → 400', noWorld.status === 400 && noWorld.json?.error === 'bad_request', noWorld.json);
  });

  await section('OG images', async () => {
    const home = await request('GET', '/opengraph-image');
    const hs = pngSize(home.bytes);
    check('home OG → 1200×630 PNG', home.status === 200 && hs && hs.width === 1200 && hs.height === 630, { status: home.status, size: hs });
    if (home.status === 200) fs.writeFileSync(path.join(OUT_DIR, 'og-home.png'), home.bytes);
    for (const [label, id] of [
      ['thumb', state.main?.id],
      ['nothumb', state.bare?.id],
      ['missing', 'doesnotexist'],
    ]) {
      if (!id) continue;
      const t0 = Date.now();
      const r = await request('GET', `/w/${id}/opengraph-image`);
      const s = pngSize(r.bytes);
      check(`world OG (${label}) → 1200×630 PNG in ${Date.now() - t0} ms`, r.status === 200 && s && s.width === 1200 && s.height === 630, { status: r.status, size: s, text: r.text.slice(0, 200) });
      if (r.status === 200) fs.writeFileSync(path.join(OUT_DIR, `og-world-${label}.png`), r.bytes);
    }
    console.log(`    (images saved to ${path.relative(root, OUT_DIR)}/)`);
  });

  await section('Trending', async () => {
    /** The whole trending feed, page by page (it can be longer than one page). */
    const feed = async () => {
      const ids = [];
      let next;
      for (let i = 0; i < 20; i++) {
        const r = await request('GET', `/api/worlds?sort=trending&limit=60${next ? `&cursor=${next}` : ''}`);
        ids.push(...r.json.worlds.map((x) => x.id));
        next = r.json.nextCursor;
        if (!next) break;
      }
      return ids;
    };
    // Paging through everything: no repeats, nothing skipped, stable while scores move.
    const seen = [];
    let cursor;
    for (let i = 0; i < 40; i++) {
      const r = await request('GET', `/api/worlds?sort=trending&limit=7${cursor ? `&cursor=${cursor}` : ''}`);
      if (r.status !== 200) { check('trending page loads', false, r.status); break; }
      seen.push(...r.json.worlds.map((w) => w.id));
      cursor = r.json.nextCursor;
      if (!cursor) break;
    }
    const all = await feed();
    check('trending pages cover the list exactly once', seen.length === new Set(seen).size && seen.length === all.length, { pages: seen.length, unique: new Set(seen).size, all: all.length });
    const first = (await request('GET', '/api/worlds?limit=100')).json.worlds.map((w) => w.id);
    check('Explore defaults to trending', first.length > 0 && JSON.stringify(first) === JSON.stringify(all.slice(0, first.length)));
    const curation = fs.readFileSync(new URL('../src/lib/curation.ts', import.meta.url), 'utf8');
    const curated = [...curation.slice(curation.indexOf('CURATED_ORDER'), curation.indexOf('];')).matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
    const present = curated.filter((id) => all.includes(id));
    check('trending leads with the curated order', present.length > 0 && JSON.stringify(all.slice(0, present.length)) === JSON.stringify(present), all.slice(0, 8));
    // Below the plays threshold, a few plays and likes don't reorder the feed.
    const w = (await create(OWNER, { name: `Trend ${TOKEN}` })).json.world;
    await patch(OWNER, w.id, { tags: ['game'] });
    await request('PUT', `/api/worlds/${w.id}/thumb`, { dev: OWNER, raw: WEBP, type: 'image/webp' });
    const rank = async () => (await feed()).indexOf(w.id);
    // A person's new world is under Newest, and joins the ranked lists once it earns it (a like).
    const newest = (await request('GET', '/api/worlds?sort=new&limit=100')).json.worlds;
    check('a new world waits under Newest until it earns its place', (await rank()) === -1 && newest.some((x) => x.id === w.id));
    check('Newest is people\'s worlds only (no curated ones)', newest.length > 0 && newest.every((x) => !/^(ext|aw|orb)-/.test(x.id)), newest.filter((x) => /^(ext|aw|orb)-/.test(x.id)).map((x) => x.id));
    {
      // …but once built (its code changed: version 2), it gets its first days there, marked new.
      const built = (await create(OWNER, { name: `Fresh ${TOKEN}` })).json.world;
      await request('PUT', `/api/worlds/${built.id}/thumb`, { dev: OWNER, raw: WEBP, type: 'image/webp' });
      const unbuilt = (await feed()).includes(built.id);
      await patch(OWNER, built.id, { code: '<!doctype html><p>built</p>', prompt: 'a test' });
      const listed = (await feed()).includes(built.id);
      const card = (await request('GET', '/api/worlds?sort=new&limit=60')).json.worlds.find((x) => x.id === built.id);
      check('a world just built is in Trending for its first days, marked new', !unbuilt && listed && card?.fresh === true, { unbuilt, listed, fresh: card?.fresh, version: (await get(OWNER, built.id)).json.world?.version });
      await request('DELETE', `/api/worlds/${built.id}`, { dev: OWNER });
    }
    await request('POST', `/api/worlds/${w.id}/like`, { dev: OWNER });
    const before = await rank();
    check('…and one like gets it into Trending', before >= 0, before);
    for (const dev of [OTHER, THIRD, STORE_DEV, ACCOUNT_DEV]) {
      await request('POST', `/api/worlds/${w.id}/play`, { dev });
      await request('POST', `/api/worlds/${w.id}/like`, { dev });
    }
    const after = await rank();
    check('a handful of plays and likes doesn\'t move a world', before >= 0 && after === before, { before, after });
    // Topics: several tags at once.
    const multi = (await request('GET', '/api/worlds?sort=trending&tag=art,game&limit=100')).json.worlds.map((x) => x.id);
    check('a topic can span several tags', multi.includes(w.id));
    check('a forged trending cursor → 400', (await request('GET', `/api/worlds?sort=trending&cursor=${Buffer.from(JSON.stringify({ s: 'trending', k: [1, 'x'] })).toString('base64url')}`)).status === 400);
    await request('DELETE', `/api/worlds/${w.id}`, { dev: OWNER });
  });

  await section('Agent builds & multi-file worlds', async () => {
    const w = (await create(OWNER, { name: `Agent ${TOKEN}` })).json.world;
    check('new world has no file tree yet', w && w.tree === null, w && w.tree);
    const build = (dev, text, extra = {}) => request('POST', '/api/agent/jobs', { dev, body: { worldId: w.id, messages: [{ role: 'user', content: text }], mode: 'build', code: '', ...extra } });
    const r = await build(OWNER, 'a glowing garden');
    check('naming a new world says its category (a toy)', JSON.stringify((await get(OWNER, w.id)).json.world.tags) === '["toy"]', (await get(OWNER, w.id)).json.world.tags);
    check('POST /api/agent/jobs streams the job', r.status === 200 && r.text.includes('"kind":"agent"') && r.text.includes('<orb:say>'), r.status + ' ' + r.text.slice(0, 200));
    check('it reports file steps, a tree and a saved version', /"t":"step"/.test(r.text) && /"t":"tree"/.test(r.text) && /"t":"version"/.test(r.text));
    check('it ends with next ideas', /<orb:suggest>[^<]+<\/orb:suggest>/.test(r.text));
    check('a build that asks nothing says no question', !/Is this the feel you want/.test(r.text));
    const jobId = /"kind":"agent","id":"([^"]+)"/.exec(r.text)?.[1];
    const after = (await get(OWNER, w.id)).json.world;
    check('the world now has files and a new version', after.tree && /^[a-f0-9]{64}$/.test(after.tree) && after.version === 2, { tree: after.tree, version: after.version });
    check('a world that has a name keeps it', after.name === `Agent ${TOKEN}`, after.name);
    check('code mirrors the tree\'s index.html', after.code.includes('src="./src/main.js"'));

    const f = await request('GET', `/api/tree/${after.tree}/src/config.js`);
    check('tree file: served with CORS for the opaque-origin frame', f.status === 200 && f.headers.get('access-control-allow-origin') === '*' && /javascript/.test(f.headers.get('content-type') || ''), f.status);
    check('tree file: immutable cache', /immutable/.test(f.headers.get('cache-control') || ''));
    check('tree file: sandboxed if opened directly', /sandbox/.test(f.headers.get('content-security-policy') || ''));
    check('tree file: no page framing rules (worlds may frame their own files)', !f.headers.get('x-frame-options'));
    check('tree: missing file → 404', (await request('GET', `/api/tree/${after.tree}/nope.js`)).status === 404);
    check('tree: traversal → 404', (await request('GET', `/api/tree/${after.tree}/..%2F..%2Fetc%2Fpasswd`)).status === 404);
    check('tree: bad sha → 404', (await request('GET', '/api/tree/abc/index.html')).status === 404);

    if (jobId) {
      const replay = await request('GET', `/api/agent/jobs/${jobId}?from=0`, { dev: OWNER });
      check('follow from 0 replays the whole job', replay.status === 200 && replay.text.includes('<orb:suggest>') && replay.text.length >= r.text.length - 200, replay.text.length + ' vs ' + r.text.length);
      const tail = await request('GET', `/api/agent/jobs/${jobId}?from=${r.text.length - 40}`, { dev: OWNER });
      check('follow from an offset returns only the rest', tail.status === 200 && tail.text.length <= 60, tail.text.length);
    }
    check('unknown job → 404', (await request('GET', '/api/agent/jobs/AAAAAAAAAAAAAAAAAAAAAA', { dev: OWNER })).status === 404);
    check('tick without a token → 403', (await request('POST', '/api/agent/tick', { body: { id: jobId } })).status === 403);
    const cron = await request('GET', '/api/cron/agent');
    check('the agent cron only kicks idle jobs (no secret needed, rate limited)', (cron.status === 200 && typeof cron.json?.idle === 'number') || cron.status === 429, cron.status);

    // A second build edits the existing files.
    await build(OWNER, 'change the colors');
    const v3 = (await get(OWNER, w.id)).json.world;
    const cfg = (await request('GET', `/api/tree/${v3.tree}/src/config.js`)).text;
    check('a follow-up build edits a file in place', v3.version === 3 && /hue: 290/.test(cfg), cfg);
    const sky = (await create(THIRD, { name: `First look ${TOKEN}` })).json.world;
    const look = await request('POST', '/api/agent/jobs', { dev: THIRD, body: { worldId: sky.id, messages: [{ role: 'user', content: 'a castle in the sky mockfirstlook' }], mode: 'build', code: '' } });
    check("a first look's question is said last, before the ideas to tap", /<orb:say>Is this the feel you want\?<\/orb:say>\n<orb:suggest>Keep going like this\|/.test(look.text), look.text.slice(-300));
    const cut = await request('POST', '/api/agent/jobs', { dev: THIRD, body: { worldId: sky.id, messages: [{ role: 'user', content: 'a glowing garden mockcutoff' }], mode: 'build', code: '' } });
    check('a reply cut off at the output limit after a tool call, the build goes on and saves', /"t":"version"/.test(cut.text) && !/orb:error/.test(cut.text), cut.text.slice(-300));
    await request('DELETE', `/api/worlds/${sky.id}`, { dev: THIRD });

    // Download .zip: every file, for the owner, and for others while the world can be remixed.
    const unzip = (buf) => {
      const files = {};
      for (let i = 0; buf.length >= i + 30 && buf.readUInt32LE(i) === 0x04034b50; ) {
        const method = buf.readUInt16LE(i + 8);
        const size = buf.readUInt32LE(i + 18);
        const at = i + 30 + buf.readUInt16LE(i + 26) + buf.readUInt16LE(i + 28);
        const data = buf.subarray(at, at + size);
        files[buf.subarray(i + 30, i + 30 + buf.readUInt16LE(i + 26)).toString('utf8')] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
        i = at + size;
      }
      return files;
    };
    const z = await request('GET', `/api/worlds/${w.id}/zip`, { dev: OWNER });
    const zipped = z.status === 200 ? unzip(z.bytes) : {};
    check('GET zip: the world\'s files, as they are', z.status === 200 && z.headers.get('content-type') === 'application/zip' && /attachment; filename=".+\.zip"/.test(z.headers.get('content-disposition') || '') && zipped['index.html'] === v3.code && /hue: 290/.test(zipped['src/config.js'] || ''), { status: z.status, files: Object.keys(zipped) });
    check('…a remixable world for anyone', (await request('GET', `/api/worlds/${w.id}/zip`, { dev: OTHER })).status === 200);
    await patch(OWNER, w.id, { forkable: false });
    check('…not once remixing is off (but still for the owner)', (await request('GET', `/api/worlds/${w.id}/zip`, { dev: OTHER })).status === 404 && (await request('GET', `/api/worlds/${w.id}/zip`, { dev: OWNER })).status === 200);
    await patch(OWNER, w.id, { forkable: true });

    // A visitor's build only answers (agent in guide mode): nothing changes.
    const vr = await build(OTHER, 'make it pink');
    check('visitor build runs read-only', vr.status === 200 && !/"t":"version"/.test(vr.text));
    check('…and the world is unchanged', (await get(OWNER, w.id)).json.world.version === 3);
    check('…an answer in place, with no copy offered', !/<orb:remix\/>/.test(vr.text), vr.text.slice(-200));
    const wish = await build(OTHER, 'make it pink mockchange');
    check('a visitor’s change request offers their own copy (<orb:remix/>), still changing nothing', wish.status === 200 && /<orb:remix\/>/.test(wish.text) && !/"t":"version"/.test(wish.text) && (await get(OWNER, w.id)).json.world.version === 3, wish.text.slice(-300));

    // Restore an older version by its tree.
    const old = (await request('GET', `/api/worlds/${w.id}/versions/2`, { dev: OWNER })).json;
    check('versions keep their tree', old.tree === after.tree, old.tree);
    const restored = (await patch(OWNER, w.id, { tree: old.tree, prompt: 'Restored version 2' })).json.world;
    check('PATCH { tree } restores files and page', restored.tree === after.tree && restored.version === 4 && restored.code === after.code);
    check('PATCH { tree } with an unknown tree → 400', (await patch(OWNER, w.id, { tree: 'f'.repeat(64) })).status === 400);
    // Editing the page by hand keeps the other files.
    const edited = (await patch(OWNER, w.id, { code: after.code.replace('Mock Garden', 'Hand Garden') })).json.world;
    const edCfg = await request('GET', `/api/tree/${edited.tree}/src/config.js`);
    check('hand-editing index.html keeps the other files', edited.tree !== restored.tree && edCfg.status === 200);
    // Remixes carry the files along.
    const fork = (await request('POST', `/api/worlds/${w.id}/fork`, { dev: OTHER, body: {} })).json.world;
    check('a remix shares the files', fork && fork.tree === edited.tree, fork && fork.tree);
    if (fork) await request('DELETE', `/api/worlds/${fork.id}`, { dev: OTHER });

    // Stop.
    const slow = await request('POST', '/api/agent/jobs', { dev: OWNER, body: { worldId: w.id, messages: [{ role: 'user', content: 'mockslow mocklong' }], mode: 'build', code: '' } }).catch(() => null);
    check('a slow build runs too', slow && slow.status === 200);
    await request('DELETE', `/api/worlds/${w.id}`, { dev: OWNER });
  });

  await section('Hidden worlds', async () => {
    const seeds = JSON.parse(fs.readFileSync(path.join(root, 'src/data/seeds.json'), 'utf8'));
    const hidden = seeds.find((s) => s.hidden);
    const shown = seeds.find((s) => !s.hidden);
    const feed = [];
    let next;
    for (let i = 0; i < 20; i++) {
      const r = await request('GET', `/api/worlds?sort=trending&limit=60${next ? `&cursor=${next}` : ''}`);
      feed.push(...r.json.worlds.map((w) => w.id));
      next = r.json.nextCursor;
      if (!next) break;
    }
    check('hidden worlds stay out of Explore', !feed.includes(hidden.id) && feed.includes(shown.id), { hidden: hidden.id });
    check('…and out of search', !(await request('GET', `/api/worlds?q=${encodeURIComponent(hidden.name)}`)).json.worlds.some((w) => w.id === hidden.id));
    check('…and the API can’t list them', !(await request('GET', '/api/worlds?hidden=1&limit=60')).json.worlds.some((w) => w.id === hidden.id));
    check('a hidden world still plays by link', (await request('GET', `/api/worlds/${hidden.id}`)).status === 200);
    if (!LAB_KEY) return skip('the secret page', 'its key is unknown (set ORB_TEST_LAB_KEY)');
    const lab = await request('GET', `/lab/${LAB_KEY}`);
    // Names can repeat across worlds, so a public world leaking onto this page is told by its id.
    const listsId = (id) => new RegExp(`"id"\\s*:\\s*"${id}"`).test(lab.text);
    check('the secret page lists the hidden worlds', lab.status === 200 && lab.text.includes(hidden.name) && !listsId(shown.id), { status: lab.status, hiddenName: lab.text.includes(hidden.name), shownId: listsId(shown.id) });
    check('…and is not indexed', /<meta name="robots" content="noindex, nofollow"/.test(lab.text));
    check('a wrong key finds nothing', (await request('GET', '/lab/not-the-key')).status === 404);
  });

  await section('Pulse', async () => {
    // Problems are told apart with digits blanked: a message unique to this run has none.
    const msg = `TypeError: test crash ${TOKEN.replace(/\d/g, (d) => 'ghijklmnop'[d])}`;
    const r = await request('POST', '/api/errors', { body: { message: msg, stack: `${msg}\n    at test (x.js:1:1)`, path: '/explore' } });
    check('a page crash report → 204', r.status === 204, r.status);
    await request('POST', '/api/errors', { body: { message: msg, path: '/explore' } });
    check('a report without a message → 204 (ignored)', (await request('POST', '/api/errors', { body: { nope: 1 } })).status === 204);
    const forged = `${msg} from another site`;
    await request('POST', '/api/errors', { body: { message: forged }, headers: { 'sec-fetch-site': 'cross-site' } });
    if (!LAB_KEY) return skip('the pulse page', 'its key is unknown (set ORB_TEST_LAB_KEY)');
    const page = await request('GET', `/lab/${LAB_KEY}/pulse`);
    const shown = page.status === 200 && page.text.includes(msg) && /2(<!-- -->)?×/.test(page.text);
    if (!shown) fs.writeFileSync(path.join(OUT_DIR, 'pulse.html'), page.text);
    check('the pulse page shows the crash, counted twice', shown, { status: page.status, hasMessage: page.text.includes(msg), saved: '.data/test-api/pulse.html' });
    check('…but not what another site sent', !page.text.includes(forged));
    check('…and the free builder', page.text.includes('Free builder') && page.text.includes('mock'));
    check('…and is not indexed', /<meta name="robots" content="noindex, nofollow"/.test(page.text));
    check('a wrong key finds no pulse', (await request('GET', '/lab/not-the-key/pulse')).status === 404);
  });

  await section('Analytics', async () => {
    const PERSON = device('person');
    const BEACON = device('beacon');
    const name = `test_zq${RUN}`;
    const visit = `visit${RUN}`;
    // Each run counts as its own address, so the per-IP limit never sees earlier runs.
    const ip = () => `10.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(256)}`;
    const IP = ip();
    const now = Date.now();
    const ev = (extra = {}) => ({ name, t: now - 1000, session: visit, path: '/explore', ...extra });
    const send = (body, opts = {}) => request('POST', '/api/events', { ...opts, body, headers: { 'x-real-ip': IP, ...opts.headers } });
    const accepted = (r) => (r.status === 200 ? r.json?.accepted : `HTTP ${r.status}`);

    const landing = { name: 'page_view', t: now - 2000, session: visit, path: '/explore?q=secret#top', props: { landing: true, utm_source: `zq${RUN}` }, ref: 'https://www.example.com/post?id=7' };
    const prompt = ev({ name: 'prompt_send', props: { where: 'chat', text: `hello ${RUN}`, provider: 'free' } });
    const built = ev({ name: 'build_done', props: { status: 'done', seconds: 9, steps: 2, saved: true } });
    let r = await send({ sent: now, mobile: false, events: [landing, ev({ props: { n: 1, ok: true, none: null } }), prompt, prompt, built] }, { dev: PERSON });
    check('a batch of events → 200 { accepted: 5 }', accepted(r) === 5, r.json);
    r = await send({ sent: now, mobile: true, device: BEACON, events: [ev({ path: `/w/w${RUN}`, world: `w${RUN}` })] });
    check('sendBeacon’s way (the device in the body, no header) → accepted', accepted(r) === 1, r.json);
    r = await send({ sent: now, events: [ev(), ev({ name: 'Bad-Name' }), ev({ name: 'x' }), ev({ session: '' })] }, { dev: PERSON });
    check('bad names and events without a visit are dropped, the rest kept', accepted(r) === 1, r.json);
    r = await send({ sent: now, events: [ev({ props: { text: 'x'.repeat(2100) } }), ev({ props: { nested: { a: 1 } } }), ev({ path: `/lab/${LAB_KEY || 'key'}/analytics` }), ev({ path: 'https://elsewhere.example/' })] }, { dev: PERSON });
    check('…and so are oversized or nested props, the secret pages and non-paths', accepted(r) === 0, r.json);
    r = await send({ sent: now, events: Array.from({ length: 51 }, () => ev()) }, { dev: PERSON });
    check('more than 50 in a batch → none', accepted(r) === 0, r.json);
    r = await send({ sent: now, events: [ev()] }, { dev: PERSON, headers: { 'sec-fetch-site': 'cross-site' } });
    check('another site can’t send events', accepted(r) === 0, r.json);
    r = await send({ sent: now, events: [ev()] }, { dev: PERSON, headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36' } });
    check('…nor a headless browser', accepted(r) === 0, r.json);
    check('…nor anyone without a device key', accepted(await send({ sent: now, events: [ev()] })) === 0);
    r = await request('POST', '/api/events', { dev: PERSON, raw: '{"events":', type: 'application/json', headers: { 'x-real-ip': IP } });
    check('a broken body → 200 { accepted: 0 }', accepted(r) === 0, r.status);

    if (!/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(`${BASE}/`)) skip('600 events per IP every 10 minutes', 'only a local server takes x-real-ip as sent');
    else {
      const flood = ip();
      const FLOOD = device('flood');
      const batch = { sent: now, events: Array.from({ length: 50 }, () => ({ name: 'test_flood', t: now, session: `flood${RUN}` })) };
      const counts = [];
      for (let i = 0; i < 13; i++) counts.push(accepted(await request('POST', '/api/events', { dev: FLOOD, body: batch, headers: { 'x-real-ip': flood } })));
      check('600 events per IP every 10 minutes, then none', counts.slice(0, 12).every((n) => n === 50) && counts[12] === 0, counts);
      check('…not even from another device there', accepted(await request('POST', '/api/events', { dev: device('flood2'), body: { sent: now, events: [ev()] }, headers: { 'x-real-ip': flood } })) === 0);
      check('…while other addresses go on', accepted(await send({ sent: now, events: [ev({ name: 'test_other' })] }, { dev: PERSON })) === 1);
    }

    if (!LAB_KEY) return skip('the analytics page', 'its key is unknown (set ORB_TEST_LAB_KEY)');
    const plain = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const id = (dev) => hashDevice(dev).slice(0, 12);
    const page = await request('GET', `/lab/${LAB_KEY}/analytics`);
    // People come latest first: this run's are on top, however many runs this database has seen.
    const row = new RegExp(`Visitor ${id(PERSON).slice(0, 8)} [A-Z][a-z]{2}, [A-Z][a-z]{2} \\d{1,2} (just now|\\d+ min ago) 1 2 1 0 Computer `);
    const counted = page.status === 200 && row.test(plain(page.text));
    if (!counted) fs.writeFileSync(path.join(OUT_DIR, 'analytics.html'), page.text);
    check('the analytics page counts each person: 1 visit, 2 prompts, 1 build', counted, { status: page.status, saved: '.data/test-api/analytics.html' });
    check('…links them to their timelines, by public id', page.text.includes(`/analytics/person/${id(PERSON)}"`) && page.text.includes(`/analytics/person/${id(BEACON)}"`));
    check('…without their device hashes', ![PERSON, BEACON].some((d) => page.text.includes(hashDevice(d))));
    check('…and is not indexed', /<meta name="robots" content="noindex, nofollow"/.test(page.text));
    const month = await request('GET', `/lab/${LAB_KEY}/analytics?days=30`);
    check('30 days too', month.status === 200 && month.text.includes('The last <!-- -->30<!-- --> days'), month.status);
    const who = await request('GET', `/lab/${LAB_KEY}/analytics/person/${id(PERSON)}`);
    const said = plain(who.text);
    const story = [`Came to /explore from example.com, utm_source zq${RUN}`, `${name} · n 1 · ok true`, `Asked “hello ${RUN}” · chat · free builder`, 'Build finished · 9 s · 2 steps'];
    check('a person’s timeline tells what they did', who.status === 200 && story.every((s) => said.includes(s)), story.filter((s) => !said.includes(s)));
    check('…without the address’s query string', !who.text.includes('q=secret'));
    check('…each event once, in the order it happened', who.text.split(`>${name}</span>`).length - 1 === 2 && said.indexOf('Came to /explore') < said.indexOf(`Asked “hello ${RUN}”`) && said.indexOf(`Asked “hello ${RUN}”`) < said.indexOf('Build finished'));
    const phone = await request('GET', `/lab/${LAB_KEY}/analytics/person/${id(BEACON)}`);
    check('…and knows a phone (said by the beacon’s body)', phone.status === 200 && phone.text.includes('No account · Phone'), phone.status);
    check('nobody there → 404', (await request('GET', `/lab/${LAB_KEY}/analytics/person/000000000000`)).status === 404 && (await request('GET', `/lab/${LAB_KEY}/analytics/person/nope`)).status === 404);
    check('a wrong key finds no analytics', (await request('GET', '/lab/not-the-key/analytics')).status === 404 && (await request('GET', `/lab/not-the-key/analytics/person/${id(PERSON)}`)).status === 404);
  });

  await section('Search engines', async () => {
    const seeds = JSON.parse(fs.readFileSync(path.join(root, 'src/data/seeds.json'), 'utf8'));
    const shown = (await get(undefined, seeds.find((s) => !s.hidden).id)).json.world;
    const hidden = (await get(undefined, seeds.find((s) => s.hidden).id)).json.world;
    const robots = await request('GET', '/robots.txt');
    check('robots.txt points to the sitemap', robots.status === 200 && /^Sitemap: \S+\/sitemap\.xml$/m.test(robots.text), robots.text);
    const map = await request('GET', '/sitemap.xml');
    check('the sitemap lists Explore’s worlds', map.status === 200 && map.text.includes(`/${shown.path}</loc>`), map.text.slice(0, 300));
    check('…but not hidden worlds', !map.text.includes(`/${hidden.path}</loc>`), hidden.path);
    const page = await request('GET', `/w/${shown.id}`);
    check('a world page names its readable URL as canonical', new RegExp(`<link rel="canonical" href="[^"]*/${shown.path}"`).test(page.text), shown.path);
    check('pages can’t be framed by other sites', page.headers.get('x-frame-options') === 'SAMEORIGIN' && page.headers.get('x-content-type-options') === 'nosniff');
  });

  await section('Agent looks at the world it builds', async () => {
    const w = (await create(LOOKER, { name: `Look ${TOKEN}` })).json.world;
    const w2 = (await create(LOOKER2, { name: `Look2 ${TOKEN}` })).json.world;
    /** Run a build and answer its looks like a watching page would, with `answer(look)`. */
    const watch = async (text, answer, [dev, world] = [LOOKER, w]) => {
      const res = await fetch(`${BASE}/api/agent/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orb-device': dev },
        body: JSON.stringify({ worldId: world.id, messages: [{ role: 'user', content: text }], mode: 'build', code: '' }),
        signal: AbortSignal.timeout(120_000),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let out = '';
      const looks = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += dec.decode(value, { stream: true });
        for (const m of out.matchAll(/\u001e(\{"t":"look"[^\n]*)\n/g)) {
          const look = JSON.parse(m[1]);
          if (looks.some((l) => l.look.id === look.id)) continue;
          looks.push({ look, replies: await answer(look) });
        }
      }
      return { status: res.status, text: out, looks };
    };
    const shot = `data:image/webp;base64,${WEBP.toString('base64')}`;
    const RESULT = {
      size: { w: 1280, h: 720, dpr: 1 },
      title: 'Mock Garden',
      uptime: 2400,
      fps: 58,
      errors: [],
      logs: [],
      dropped: 0,
      ui: [{ text: 'Tap to plant a glow', x: 0.01, y: 0.9, w: 0.2, h: 0.05, tag: 'div', click: false }],
      canvas: { w: 1280, h: 720, type: '2d', cover: 1 },
      focus: 'page',
      locked: false,
      shots: [{ label: 'end', t: 2300, dataUrl: shot }],
      evals: [{ js: 'document.title', result: '"Mock Garden"' }],
      notes: [],
    };
    const post = (look, body, dev = LOOKER) => request('POST', `/api/agent/jobs/${look.job}/look`, { dev, body: { id: look.id, ...body } });

    const r = await watch('a glowing garden mocklook', async (look) => [await post(look, { result: { nope: 1 } }).then((x) => x.status), await post(look, {}).then((x) => x.status), await post(look, { result: RESULT }).then((x) => x.status), await post(look, { result: RESULT }).then((x) => x.status)]);
    check('the look build streams', r.status === 200, r.status);
    const l = r.looks[0]?.look;
    check('the agent asks the watching page to look, once', r.looks.length === 1 && /^[a-f0-9]{64}$/.test(l?.tree ?? '') && l.size === 1024 && l.shots >= 1, r.looks.map((x) => x.look));
    check('…with the play-test actions, cleaned', JSON.stringify(l?.actions) === JSON.stringify([{ type: 'click', x: 0.5, y: 0.5 }, { type: 'key', key: 'w', ms: 150 }, { type: 'eval', js: 'document.title' }]), l?.actions);
    const lookAt = r.text.indexOf('"t":"look"');
    check('the files it looks at were shown first', r.text.lastIndexOf(`"t":"tree","tree":"${l?.tree}"`, lookAt) !== -1);
    check('the chat says it is trying the world out (a passing status)', /"t":"status","phase":"thinking","text":"Trying it out…"/.test(r.text) && !/"label":"Trying/.test(r.text));
    check('an answer is accepted once: junk is cleaned, an empty one → 400, a late one → 409', JSON.stringify(r.looks[0]?.replies) === JSON.stringify([200, 400, 409, 409]), r.looks[0]?.replies);
    check('the look is closed in the output (a replaying page skips it)', r.text.includes(`"t":"looked","id":"${l?.id}"`));
    check('a junk answer reaches the agent as an empty look', /I played it: 0 fps, no errors, title unknown\./.test(r.text), r.text.match(/I played it[^<]*/)?.[0] ?? r.text.slice(-300));

    const r2 = await watch('again mocklook', async (look) => [await post(look, { result: RESULT }).then((x) => x.status)]);
    check('with a real answer, the agent sees fps, errors, eval results and the screenshot', /I played it: 58 fps, no errors, title Mock Garden, screenshot seen\./.test(r2.text), r2.text.match(/I played it[^<]*/)?.[0] ?? r2.text.slice(-300));

    const r3 = await watch('once more mocklook', async (look) => [await post(look, { unavailable: 'The world is not on screen in the page that watches the build.' }, LOOKER2).then((x) => x.status)], [LOOKER2, w2]);
    check("a page that can't look says so, and the agent hears why", r3.looks[0]?.replies[0] === 200 && /I couldn.t look: Couldn.t look: The world is not on screen/.test(r3.text), r3.text.match(/I couldn[^<]*/)?.[0] ?? r3.text.slice(-300));

    check('answering for a build that isn’t there → 404', (await request('POST', `/api/agent/jobs/${'A'.repeat(22)}/look`, { dev: OWNER, body: { id: 'abcdefgh', result: RESULT } })).status === 404);
    const r4 = await watch('one more mocklook', async (look) => [await post(look, { result: RESULT }, OWNER).then((x) => x.status), await post(look, { result: RESULT }).then((x) => x.status)]);
    check('only the page of whoever started a build answers its looks (another device → 404)', JSON.stringify(r4.looks[0]?.replies) === JSON.stringify([404, 200]), r4.looks[0]?.replies);
    check('…and only they follow or stop it', r4.looks[0] && (await request('GET', `/api/agent/jobs/${r4.looks[0].look.job}?from=0`, { dev: OWNER })).status === 404 && (await request('POST', `/api/agent/jobs/${r4.looks[0].look.job}/cancel`, { dev: OWNER })).status === 404);
    check('answering with a bad job id → 400', (await request('POST', '/api/agent/jobs/x/look', { dev: OWNER, body: { id: 'abcdefgh', result: RESULT } })).status === 400);
    await request('DELETE', `/api/worlds/${w.id}`, { dev: LOOKER });
    await request('DELETE', `/api/worlds/${w2.id}`, { dev: LOOKER2 });
  });

  await section('Every world on GitHub, whoever builds it', async () => {
    if (!FAKE) return skip('worlds kept on GitHub', 'needs the fake Cursor/GitHub (let the script start its own server)');
    const KEEPER = device('keeper');
    const H = { 'x-orb-agent-provider': 'cursor', 'x-orb-agent-key': 'crsr_test' };
    const repos = () => [...FAKE.repos.keys()].filter((k) => k.startsWith('tester/'));
    const before = repos().length;
    const w0 = (await create(KEEPER, { name: 'Untitled world' })).json.world;
    const plain = await request('POST', '/api/agent/jobs', { dev: KEEPER, headers: H, body: { worldId: w0.id, messages: [{ role: 'user', content: 'a garden' }], mode: 'build', code: '' } });
    check('Cursor builds through Orb’s files link', plain.status === 200 && /"t":"version"/.test(plain.text) && (await get(KEEPER, w0.id)).json.world.code.includes('src/main.js'), plain.text.slice(-300));
    check('…and without GitHub connected, the world stays on Orb', repos().length === before && !(await get(KEEPER, w0.id)).json.world.repo);

    await request('POST', '/api/me/github', { dev: KEEPER, body: { token: `ghp_${'k'.repeat(36)}` } });
    const on = await request('POST', '/api/me/github', { dev: KEEPER, body: { auto: true } });
    check('“Keep every world on GitHub” can be turned on', on.status === 200 && on.json?.auto === true && (await request('GET', '/api/me/github', { dev: KEEPER })).json?.auto === true, on.text);
    const w = (await create(KEEPER, { name: 'Untitled world' })).json.world;
    const r = await request('POST', '/api/agent/jobs', { dev: KEEPER, headers: H, body: { worldId: w.id, messages: [{ role: 'user', content: 'a glowing garden mocklimit' }], mode: 'build', code: '' } });
    state.cursorJob = /"kind":"agent","id":"([^"]+)"/.exec(r.text)?.[1];
    const repo = (await get(KEEPER, w.id)).json.world.repo?.repo;
    check('a Cursor build’s versions go to a new private repository', r.status === 200 && /^tester\//.test(repo ?? '') && /main\.js/.test(FAKE.headText(repo)['index.html'] ?? '') && !!FAKE.headText(repo)['src/config.js'], [repo, r.text.slice(-200)]);
    await request('POST', '/api/agent/jobs', { dev: KEEPER, headers: H, body: { worldId: w.id, messages: [{ role: 'user', content: 'more colors' }], mode: 'build', code: '' } });
    check('…the next build commits to the same one', (await get(KEEPER, w.id)).json.world.repo?.repo === repo && repos().length === before + 1 && /hue: 320/.test(FAKE.headText(repo)['src/config.js'] ?? ''), [repos(), FAKE.headText(repo)['src/config.js']]);
    const made = (await create(KEEPER, { name: `Meadow ${RUN}`, code: '<!doctype html><title>Meadow</title><p>meadow</p>' })).json.world;
    const meadow = await (async () => { for (let i = 0; i < 40; i++) { const m = (await get(KEEPER, made.id)).json.world.repo?.repo; if (m) return m; await new Promise((res) => setTimeout(res, 300)); } return null; })();
    check('…and so does a world made by hand', /^tester\/meadow-/.test(meadow ?? '') && /meadow/.test(FAKE.headText(meadow)['index.html'] ?? ''), meadow);
    check('turning it off', (await request('POST', '/api/me/github', { dev: KEEPER, body: { auto: false } })).json?.auto === false);
    await request('DELETE', '/api/me/github', { dev: KEEPER });
    for (const id of [w0.id, w.id, made.id]) await request('DELETE', `/api/worlds/${id}`, { dev: KEEPER });
  });

  await section('Traces', async () => {
    if (!LAB_KEY) return skip('build traces', 'their pages’ key is unknown (set ORB_TEST_LAB_KEY)');
    const lab = `/lab/${LAB_KEY}/traces`;
    const group = `turn${RUN}`;
    const H = { 'x-orb-trace-group': group };
    /** A trace from the JSONL export once it has ended (its end is written just after the build's stream closes). */
    const traceOf = async (query) => {
      for (let i = 0; i < 40; i++) {
        const r = await request('GET', `${lab}/export?${new URLSearchParams(query)}`);
        const line = r.status === 200 ? r.text.trim().split('\n').pop() : '';
        const t = line ? JSON.parse(line) : null;
        if (t && t.status !== 'running') return { ...t, raw: r.text };
        await new Promise((res) => setTimeout(res, 500));
      }
      return null;
    };
    const parts = (step) => step.payload.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));

    // An agent build that looks at the world, answered like a watching page.
    const w = (await create(TRACER, { name: `Traced ${TOKEN}` })).json.world;
    const shot = `data:image/webp;base64,${WEBP.toString('base64')}`;
    const sha = crypto.createHash('sha256').update(WEBP).digest('hex');
    const seen = { size: { w: 1280, h: 720, dpr: 1 }, title: 'Traced Garden', uptime: 2400, fps: 60, errors: [], logs: [{ level: 'log', text: 'hello from the world', t: 10 }], dropped: 0, ui: [], canvas: null, focus: 'page', locked: false, shots: [{ label: 'end', t: 2300, dataUrl: shot }], evals: [], notes: [] };
    const res = await fetch(`${BASE}/api/agent/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orb-device': TRACER, ...H },
      body: JSON.stringify({ worldId: w.id, messages: [{ role: 'user', content: `a traced garden ${TOKEN} mocklook` }], mode: 'build', code: '' }),
      signal: AbortSignal.timeout(120_000),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const answered = new Set();
    let out = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
      for (const m of out.matchAll(/\u001e(\{"t":"look"[^\n]*)\n/g)) {
        const look = JSON.parse(m[1]);
        if (answered.has(look.id)) continue;
        answered.add(look.id);
        await request('POST', `/api/agent/jobs/${look.job}/look`, { dev: TRACER, body: { id: look.id, result: seen } });
      }
    }
    const jobId = /"kind":"agent","id":"([^"]+)"/.exec(out)?.[1];
    check('a traced agent build runs and looks once', res.status === 200 && answered.size === 1 && Boolean(jobId), { status: res.status, looks: answered.size });
    const t = jobId ? await traceOf({ id: jobId }) : null;
    check('its trace ends done', t?.status === 'done', t && { status: t.status, error: t.error });
    if (t) {
      check(
        '…with who, which world and model, the prompt and the chat turn',
        t.id === jobId && t.kind === 'agent' && t.provider === 'free' && t.model === 'mock' && t.mode === 'build' && t.worldId === w.id && t.worldName === `Traced ${TOKEN}` && t.groupId === group && t.prompt === `a traced garden ${TOKEN} mocklook` && t.device === hashDevice(TRACER).slice(0, 10),
        { ...t, events: undefined, raw: undefined },
      );
      check('…never a whole device hash', !t.raw.includes(hashDevice(TRACER)));
      const input = t.events[0];
      check('…its input: the system prompt and the chat', input?.type === 'input' && typeof input.payload.system === 'string' && input.payload.system.length > 1000 && JSON.stringify(input.payload.messages.at(-1)).includes(`a traced garden ${TOKEN}`), input && Object.keys(input.payload));
      const steps = t.events.filter((e) => e.type === 'step');
      const all = steps.flatMap(parts);
      check(
        '…each model step: tool calls with their inputs, results, usage and timing',
        steps.length >= 2 && steps.length === t.steps && all.some((p) => p.type === 'tool-call' && p.toolName === 'write_file' && typeof p.input?.content === 'string') && all.some((p) => p.type === 'tool-result') && steps.every((e) => e.summary.usage?.in > 0 && e.summary.usage?.out > 0 && e.summary.ms >= 0),
        steps.map((e) => e.summary),
      );
      check('…token totals from its steps', t.tokens.in === steps.reduce((n, e) => n + e.summary.usage.in, 0) && t.tokens.out === steps.reduce((n, e) => n + e.summary.usage.out, 0), t.tokens);
      const look = t.events.find((e) => e.type === 'look');
      check('…the look: what the page saw, its screenshot stored as a blob', look?.summary.outcome === 'seen' && look.summary.shots === 1 && look.payload.answer.result.shots[0].dataUrl === `orb-blob:${sha}` && look.payload.answer.result.logs[0].text === 'hello from the world' && Array.isArray(look.payload.actions), look?.summary);
      check('…and the step that looked shows the model the same screenshot', steps.some((e) => JSON.stringify(e.payload.messages).includes(`orb-blob:${sha}`)));
      const commits = t.events.filter((e) => e.type === 'commit');
      check('…every version it saved', commits.length >= 1 && commits.every((e) => /^[a-f0-9]{64}$/.test(e.summary.tree) && e.summary.version >= 2) && t.meta.versions === commits.length && t.meta.looks === 1, commits.map((e) => e.summary));
      const end = t.events.at(-1);
      check('…and how it ended, with the world’s files', end?.type === 'end' && end.summary.status === 'done' && Object.keys(end.payload.files ?? {}).length >= 2 && t.durationMs >= 0 && Boolean(t.endedAt), end);
      const blob = await request('GET', `${lab}/blob/${sha}`);
      check('the blob route serves the screenshot as an image, cached for good', blob.status === 200 && blob.headers.get('content-type') === 'image/webp' && blob.bytes.equals(WEBP) && /immutable/.test(blob.headers.get('cache-control') || ''), { status: blob.status, type: blob.headers.get('content-type') });
      const prompt = await request('GET', `${lab}/blob/${crypto.createHash('sha256').update(input.payload.system).digest('hex')}`);
      check('…anything else as sandboxed plain text', prompt.status === 200 && /^text\/plain/.test(prompt.headers.get('content-type') || '') && /sandbox/.test(prompt.headers.get('content-security-policy') || '') && prompt.text === input.payload.system, prompt.status);
      const inlined = await traceOf({ id: jobId, images: '1' });
      check('the export can put screenshots in as data URLs', inlined?.events.find((e) => e.type === 'look')?.payload.answer.result.shots[0].dataUrl === shot);
    }

    // Another round of the same chat turn (as the automatic repair round would be).
    const again = await fetch(`${BASE}/api/agent/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orb-device': TRACER, ...H },
      body: JSON.stringify({ worldId: w.id, messages: [{ role: 'user', content: `a traced pond ${TOKEN}` }], mode: 'build' }),
      signal: AbortSignal.timeout(120_000),
    });
    const againId = /"kind":"agent","id":"([^"]+)"/.exec(await again.text())?.[1];
    const round2 = againId ? await traceOf({ id: againId }) : null;
    check('a second round of the chat turn is traced in the same group', again.status === 200 && round2?.status === 'done' && round2.groupId === group, round2 && { status: round2.status, group: round2.groupId });

    if (!state.cursorJob) skip('a Cursor job’s trace', 'needs the Cursor section, run against the fake Cursor/GitHub');
    else {
      const ct = await traceOf({ id: state.cursorJob });
      const runs = ct?.events.filter((e) => e.type === 'step') ?? [];
      check(
        'a Cursor job is traced run by run, with its tool calls',
        ct?.kind === 'cursor' && ct.provider === 'cursor' && ct.status === 'done' && runs.length === 2 && runs.every((e) => e.payload.tools.some((x) => x.name === 'edit_file' && x.status === 'completed')) && ct.events.filter((e) => e.type === 'note' && e.summary.kind === 'run').length === 2 && ct.events.some((e) => e.type === 'commit'),
        ct && ct.events.map((e) => e.type + (e.summary.kind ? `:${e.summary.kind}` : '')),
      );
    }

    // The pages.
    const list = await request('GET', `${lab}?q=${TOKEN}`);
    check('the traces page lists them, with totals', list.status === 200 && list.text.includes(`a traced garden ${TOKEN} mocklook`) && list.text.includes(`a traced pond ${TOKEN}`) && list.text.includes(`Traced ${TOKEN}`) && list.text.includes('Stored'), list.status);
    check('…and is not indexed', /<meta name="robots" content="noindex, nofollow"/.test(list.text));
    const failed = await request('GET', `${lab}?q=${TOKEN}&status=failed`);
    check('…and filters', failed.status === 200 && !failed.text.includes(`a traced pond ${TOKEN}`) && (await request('GET', `${lab}?q=${TOKEN}&kind=agent`)).text.includes(`a traced pond ${TOKEN}`) && !(await request('GET', `${lab}?q=${TOKEN}&kind=cursor`)).text.includes(`a traced pond ${TOKEN}`));
    if (jobId) {
      const page = await request('GET', `${lab}/${jobId}`);
      check('a trace’s page shows its timeline and screenshots', page.status === 200 && page.text.includes('Step 1') && page.text.includes('write_file') && page.text.includes(`${lab}/blob/${sha}`) && page.text.includes('Rounds of this chat turn'), page.status);
      check('a wrong key finds no traces', (await Promise.all([`/lab/not-the-key/traces`, `/lab/not-the-key/traces/${jobId}`, '/lab/not-the-key/traces/export', `/lab/not-the-key/traces/blob/${sha}`].map((p) => request('GET', p)))).every((r) => r.status === 404));
    }
    check('an unknown trace → 404', (await request('GET', `${lab}/nosuchtrace0000`)).status === 404);
    const ex = await request('GET', `${lab}/export?q=${TOKEN}`);
    const exported = ex.text.trim().split('\n').map((l) => JSON.parse(l));
    check(
      'the export is a JSON-lines download, oldest first',
      ex.status === 200 &&
        /^application\/x-ndjson/.test(ex.headers.get('content-type') || '') &&
        /^attachment; filename="orb-traces-[\d-]+\.jsonl"$/.test(ex.headers.get('content-disposition') || '') &&
        exported.map((x) => x.kind).join() === 'agent,agent' &&
        exported.every((x, i) => i === 0 || exported[i - 1].startedAt <= x.startedAt),
      { status: ex.status, type: ex.headers.get('content-type'), disposition: ex.headers.get('content-disposition'), traces: exported.map((x) => [x.kind, x.startedAt]) },
    );
    check('…and a bad since → 400', (await request('GET', `${lab}/export?since=sometime`)).status === 400);
    await request('DELETE', `/api/worlds/${w.id}`, { dev: TRACER });
  });

  await section('Import', async () => {
    const bad = await request('POST', '/api/worlds/import', { dev: OWNER, body: { url: 'https://example.com/x' } });
    check('non-GitHub link → 400', bad.status === 400 && bad.json?.error === 'bad_request', bad.status);

    // A fork of an open-source game's repository (scripts/publish-games.mjs) comes in as a remix of the game.
    if (FAKE) {
      const original = (await request('GET', '/api/worlds/orb-bedwars')).json?.world;
      check('an Original’s files are its repository’s', original?.code === '<!doctype html><title>Bed Wars</title><p>beds</p>' && !!original?.tree, original?.code?.slice(0, 80));
      const mit = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy…';
      const repo = (name, html, world = 'orb-bedwars') =>
        FAKE.addRepo(`someone-${RUN}/${name}`, { 'index.html': html, LICENSE: mit, 'orb.json': JSON.stringify({ name: 'Bed Wars', world }), 'README.md': '# Bed Wars\n\nMy own Bed Wars, with longer nights and more beds.\n', 'orb-kit/lib/host.js': 'export {};' });
      repo('bedwars', original.code.replace('<title>Bed Wars</title>', '<title>Bed Wars</title><!-- changed on GitHub -->'));
      repo('bedwars-same', original.code);
      repo('bedwars-lost', '<!doctype html><title>Lost</title><p>hi</p>', 'no-such-world');

      const changed = await request('POST', '/api/worlds/import', { dev: OWNER, body: { url: `https://github.com/someone-${RUN}/bedwars` } });
      const w = changed.json?.world;
      check('a changed game fork imports as a remix of the game', changed.status === 200 && w?.forkedFrom?.id === 'orb-bedwars', changed.status + ' ' + changed.text.slice(0, 200));
      check('…with the game, then the GitHub changes, in its history', w?.version === 2 && /changed on GitHub/.test(w?.code ?? ''), w?.version);
      const versions = w ? (await request('GET', `/api/worlds/${w.id}/versions`, { dev: OWNER })).json?.versions ?? [] : [];
      check('…whose first version is the game itself', versions.length === 2 && (await request('GET', `/api/worlds/${w.id}/versions/1`, { dev: OWNER })).json?.code === original.code, versions.map((v) => v.version));
      check('…licensed and linked to the fork', w?.license === 'MIT' && w?.sourceUrl === `https://github.com/someone-${RUN}/bedwars` && w?.forkable === true);
      check('…without the kit', changed.json?.files === 4, changed.json?.files);
      const remixes = (await request('GET', '/api/worlds/orb-bedwars/remixes')).json?.worlds ?? [];
      check('…and is one of the game’s remixes', remixes.some((r) => r.id === w?.id));

      const same = await request('POST', '/api/worlds/import', { dev: OWNER, body: { url: `https://github.com/someone-${RUN}/bedwars-same` } });
      check('an unchanged fork is a remix not yet changed', same.status === 200 && same.json.world.forkedFrom?.id === 'orb-bedwars' && same.json.world.version === 1);
      const lost = await request('POST', '/api/worlds/import', { dev: OWNER, body: { url: `https://github.com/someone-${RUN}/bedwars-lost` } });
      check('a repository naming no Orb world imports as a world of its own', lost.status === 200 && lost.json.world.forkedFrom === null && lost.json.world.version === 1);
      for (const r of [changed, same, lost]) if (r.json?.world) await request('DELETE', `/api/worlds/${r.json.world.id}`, { dev: OWNER });
    } else skip('import a game fork as a remix', 'needs the fake GitHub (runs when this script starts the server)');

    if (!process.env.ORB_TEST_NETWORK) return skip('import a real repository', 'set ORB_TEST_NETWORK=1');
    const r = await request('POST', '/api/worlds/import', { dev: OWNER, body: { url: 'https://github.com/jason-c-dev/iridium-reach-demo' } });
    check('imports a public repository as a world', r.status === 200 && r.json.world.tree && r.json.files > 1, r.status + ' ' + r.text.slice(0, 200));
    if (r.json?.world) {
      const page = await request('GET', `/api/tree/${r.json.world.tree}/index.html`);
      check('its index.html is served', page.status === 200 && /<html/i.test(page.text));
      check('it links back to the repository', r.json.world.sourceUrl === 'https://github.com/jason-c-dev/iridium-reach-demo');
      await request('DELETE', `/api/worlds/${r.json.world.id}`, { dev: OWNER });
    }
  });

  await section('GitHub sync', async () => {
    if (!FAKE) return skip('GitHub sync', 'needs the fake GitHub (runs when this script starts the server)');
    const SYNCER = device('syncer');
    const name = `maker-${RUN}/garden`;
    const page = (n) => `<!doctype html><title>Garden</title><p>garden ${n}</p><script src="app.js"></script>`;
    const mit = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy…';
    FAKE.addRepo(name, { 'index.html': page(1), 'app.js': 'let a = 1;', LICENSE: mit, 'node_modules/x/index.js': 'skipped' });
    const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 300)); } };
    const world = async (dev = SYNCER) => (await request('GET', `/api/worlds/${id}`, { dev })).json?.world;
    const sync = () => request('POST', `/api/worlds/${id}/github`, { dev: SYNCER, body: { action: 'sync' } });

    const imp = await request('POST', '/api/worlds/import', { dev: SYNCER, body: { url: `https://github.com/${name}` } });
    const id = imp.json?.world?.id;
    check('an imported repository is linked to its branch', imp.status === 200 && imp.json.world.repo?.repo === name && imp.json.world.repo?.branch === 'main', imp.status + ' ' + imp.text.slice(0, 200));
    if (!id) return;
    const first = await world();
    check('…its owner sees the link; without a token on Orb, Orb only follows it', first.repo?.repo === name && first.repo.push === false && first.repo.state === 'ok', first.repo);
    check('…visitors aren’t told', (await world(OTHER))?.repo === undefined);
    check('…and only the owner can sync it', (await request('POST', `/api/worlds/${id}/github`, { dev: OTHER, body: { action: 'sync' } })).status === 403);

    // GitHub → Orb
    FAKE.pushFiles(name, { 'index.html': page(2) }, 'Bigger flowers');
    const pulled = await sync();
    const v2 = pulled.json?.world;
    check('a push to the branch comes in as a new version', pulled.status === 200 && v2?.version === 2 && /garden 2/.test(v2?.code ?? ''), pulled.status + ' ' + pulled.text.slice(0, 200));
    const vlist = (await request('GET', `/api/worlds/${id}/versions`, { dev: SYNCER })).json?.versions ?? [];
    check('…saying where it came from', /^From GitHub \(maker-.*\/garden@\w{7}\): Bigger flowers$/.test(vlist[0]?.prompt ?? ''), vlist[0]?.prompt);
    check('…and nothing new when nothing changed', (await sync()).json?.world?.version === 2);

    // Orb → GitHub needs the owner's token on Orb
    const edit = (n) => request('PATCH', `/api/worlds/${id}`, { dev: SYNCER, body: { code: page(n), prompt: `Garden ${n}` } });
    await edit(3);
    await new Promise((r) => setTimeout(r, 1500));
    check('without a token, Orb’s versions stay on Orb', /garden 2/.test(FAKE.headText(name)['index.html']));
    const badToken = await request('POST', '/api/me/github', { dev: SYNCER, body: { token: 'nope' } });
    check('a token that isn’t one → 400', badToken.status === 400);
    const kept = await request('POST', '/api/me/github', { dev: SYNCER, body: { token: `ghp_${'x'.repeat(36)}` } });
    check('a GitHub token can be kept on Orb (checked with GitHub)', kept.status === 200 && kept.json?.login === 'tester', kept.text.slice(0, 200));
    check('…and is reported, never sent back', (await request('GET', '/api/me/github', { dev: SYNCER })).text === JSON.stringify({ login: 'tester', auto: false }));
    check('…which lets Orb push', (await world())?.repo?.push === true);
    await edit(4);
    const pushed = await until(() => /garden 4/.test(FAKE.headText(name)['index.html'] ?? ''));
    const head = FAKE.headText(name);
    check('a hand edit is committed to the branch', !!pushed, head['index.html']);
    check('…only what changed: files Orb never imported stay', head['node_modules/x/index.js'] === 'skipped' && head['app.js'] === 'let a = 1;' && head.LICENSE === mit, Object.keys(head));

    // both sides changed: GitHub's change comes in, Orb's goes out, nothing is lost
    FAKE.pushFiles(name, { 'app.js': 'let a = 2;' }, 'Faster growth');
    await edit(5);
    const merged = await until(async () => { const h = FAKE.headText(name); return /garden 5/.test(h['index.html'] ?? '') && h['app.js'] === 'let a = 2;' ? h : null; });
    check('both changed: the branch ends up with both', !!merged, FAKE.headText(name));
    const after = await world();
    const app = after?.tree ? await request('GET', `/api/tree/${after.tree}/app.js`) : null;
    check('…and so does the world', /garden 5/.test(after?.code ?? '') && app?.text === 'let a = 2;', [after?.version, app?.text]);

    // a world made on Orb, put on GitHub
    const made = await request('POST', '/api/worlds', { dev: SYNCER, body: { name: `Pond ${RUN}`, code: '<!doctype html><title>Pond</title><p>pond</p>' } });
    const pond = made.json?.world;
    const created = await request('POST', `/api/worlds/${pond?.id}/github`, { dev: SYNCER, body: { action: 'create' } });
    const repo = created.json?.world?.repo?.repo;
    check('Keep on GitHub: a new private repository with the world', created.status === 200 && /^tester\/pond-/.test(repo ?? '') && /pond/.test(FAKE.headText(repo)['index.html'] ?? ''), created.status + ' ' + created.text.slice(0, 200));
    check('…once', (await request('POST', `/api/worlds/${pond?.id}/github`, { dev: SYNCER, body: { action: 'create' } })).status === 409);
    await request('PATCH', `/api/worlds/${pond.id}`, { dev: SYNCER, body: { code: '<!doctype html><title>Pond</title><p>pond with fish</p>' } });
    check('…and its new versions follow', !!(await until(() => /fish/.test(FAKE.headText(repo)['index.html'] ?? ''))));

    const cron = await request('GET', '/api/cron/github');
    check('the sweep checks linked worlds nobody opened lately', cron.status === 200 && typeof cron.json?.checked === 'number', cron.status);
    const unlinked = await request('DELETE', `/api/worlds/${id}/github`, { dev: SYNCER });
    check('Stop syncing unlinks it (the repository stays)', unlinked.status === 200 && unlinked.json.world.repo === null && !!FAKE.headText(name)['index.html']);
    check('dropping the token', (await request('DELETE', '/api/me/github', { dev: SYNCER })).json?.login === null && (await request('GET', '/api/me/github', { dev: SYNCER })).json?.login === null);
    for (const w of [id, pond?.id]) if (w) await request('DELETE', `/api/worlds/${w}`, { dev: SYNCER });
  });

  await section('orb push (the kit)', async () => {
    const KITTER = device('kitter');
    const FRIEND = device('kitfriend');
    const root = fileURLToPath(new URL('..', import.meta.url));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-push-'));
    const cfg = (who) => path.join(dir, `.cfg-${who}`);
    const run = (folder, who, args = []) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(root, 'kit/bin/orb.mjs'), 'push', folder, '--no-shot', ...args], { env: { ...process.env, ORB_SITE: BASE, ORB_CONFIG_DIR: cfg(who), ORB_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('close', (code) => resolve({ code, out }));
      });
    const approve = async (who, dev) => {
      const pending = JSON.parse(fs.readFileSync(path.join(cfg(who), 'credentials.json'), 'utf8'))[BASE]?.pending;
      return request('POST', '/api/kit/approve', { dev, body: { code: pending?.code ?? '' } });
    };
    const world = path.join(dir, 'pond');
    fs.mkdirSync(path.join(world, 'src'), { recursive: true });
    fs.mkdirSync(path.join(world, 'node_modules/x'), { recursive: true });
    fs.writeFileSync(path.join(world, 'index.html'), `<!doctype html><title>Kit Pond ${TOKEN}</title><script src="src/main.js"></script>`);
    fs.writeFileSync(path.join(world, 'src/main.js'), 'let fish = 1;');
    fs.writeFileSync(path.join(world, 'node_modules/x/a.js'), 'skipped');
    const LONG = `src/${'a-rather-long-folder-name/'.repeat(5)}far.js`;
    const DEEP = `src/${'d/'.repeat(30)}x.js`;
    for (const [p, t] of [[LONG, 'let far = true;'], [DEEP, 'too deep']]) {
      fs.mkdirSync(path.dirname(path.join(world, p)), { recursive: true });
      fs.writeFileSync(path.join(world, p), t);
    }

    const first = await run(world, 'a');
    check('the first push shows a link to allow it, and stops (no terminal)', first.code === 2 && /\/kit\/[A-Z0-9]{4}-[A-Z0-9]{4}/.test(first.out), first.out);
    check('a wrong code is refused', (await request('POST', '/api/kit/approve', { dev: KITTER, body: { code: 'AAAA-AAAA' } })).status === 404);
    check('allowing it in the browser', (await approve('a', KITTER)).status === 200);
    const made = await run(world, 'a', ['-m', 'Fish']);
    const meta = JSON.parse(fs.readFileSync(path.join(world, 'orb.json'), 'utf8'));
    check('the next push signs in and makes a new world', made.code === 0 && /Made a new world/.test(made.out) && /^[\w-]+$/.test(meta.world) && meta.url.startsWith(BASE), made.out);
    const w1 = (await get(KITTER, meta.world)).json?.world;
    check('…the browser’s own, with the folder’s files (not node_modules)', w1?.canEdit && w1.name === `Kit Pond ${TOKEN}` && w1.forkable && !!w1.tree, w1 && { canEdit: w1.canEdit, name: w1.name });
    const tree = (await request('GET', `/api/tree/${w1?.tree}/src/main.js`)).text;
    const far = (await request('GET', `/api/tree/${w1?.tree}/${LONG}`)).text;
    const nm = (await request('GET', `/api/tree/${w1?.tree}/node_modules/x/a.js`)).status;
    check('…long paths arrive, node_modules doesn’t', tree === 'let fish = 1;' && far === 'let far = true;' && nm === 404, { tree, far, nm });
    check('…and what a world can’t hold is said, not lost quietly', /Left out 1 file/.test(made.out) && made.out.includes(DEEP), made.out);
    fs.writeFileSync(path.join(world, 'src/main.js'), 'let fish = 2;');
    const again = await run(world, 'a', ['-m', 'More fish']);
    const w2 = (await get(KITTER, meta.world)).json?.world;
    const versions = (await request('GET', `/api/worlds/${meta.world}/versions`, { dev: KITTER })).json?.versions ?? [];
    check('a push after a change is a new version of it', again.code === 0 && /Pushed version 2/.test(again.out) && w2?.version === 2 && versions[0]?.prompt === 'More fish', again.out);
    check('…and nothing changed, nothing new', /Nothing changed/.test((await run(world, 'a')).out) && (await get(KITTER, meta.world)).json?.world?.version === 2);

    const fork = path.join(dir, 'fork');
    fs.cpSync(world, fork, { recursive: true });
    fs.writeFileSync(path.join(fork, 'src/main.js'), 'let fish = 3;');
    await run(fork, 'b');
    await approve('b', FRIEND);
    const remix = await run(fork, 'b');
    const fmeta = JSON.parse(fs.readFileSync(path.join(fork, 'orb.json'), 'utf8'));
    const rw = (await get(FRIEND, fmeta.world)).json?.world;
    check('pushing someone else’s world makes your remix, and orb.json follows it', /Made your remix/.test(remix.out) && fmeta.remixOf === meta.world && rw?.canEdit && rw.forkedFrom?.id === meta.world, [remix.out, fmeta]);
    check('…their world is untouched', (await get(KITTER, meta.world)).json?.world?.version === 2);

    const bare = path.join(dir, 'bare');
    fs.mkdirSync(bare);
    fs.writeFileSync(path.join(bare, 'main.js'), '1');
    check('a folder without index.html is refused before sending', /no index.html/.test((await run(bare, 'a')).out));
    const forged = await request('POST', '/api/kit/push', { raw: zlib.gzipSync(Buffer.alloc(1024)), type: 'application/gzip', headers: { authorization: 'Bearer orbk_eyJrIjoia2l0In0.forged' } });
    check('a forged token can’t push', forged.status === 401, forged.status);
    for (const [dev, id] of [[KITTER, meta.world], [FRIEND, fmeta.world]]) await request('DELETE', `/api/worlds/${id}`, { dev });
  });

  await section('Delete', async () => {
    const id = state.main.id;
    const r = await request('DELETE', `/api/worlds/${id}`, { dev: OWNER });
    check('owner DELETE → { ok: true }', r.status === 200 && r.json.ok === true, r.json);
    check('deleted world → 404', (await get(OWNER, id)).status === 404);
    check('its versions → 404', (await request('GET', `/api/worlds/${id}/versions`, { dev: OWNER })).status === 404);
    check('its thumbnail → 404', (await request('GET', `/api/worlds/${id}/thumb?v=3`)).status === 404);
    const f = (await get(OTHER, state.fork.id)).json.world;
    check('remix survives with forkedFrom cleared', f && f.forkedFrom === null, f && f.forkedFrom);
    // Clean up the rest of this run's worlds.
    const leftovers = [state.fork?.id, state.blocky?.id, state.bare?.id, ...(state.accountWorlds || [])].filter(Boolean);
    const mine = (await list(OWNER, { mine: '1', q: TOKEN })).json.worlds.map((w) => w.id);
    for (const w of [...leftovers, ...mine]) {
      for (const dev of [OWNER, OTHER, ACCOUNT_DEV]) {
        const res = await request('DELETE', `/api/worlds/${w}`, { dev, cookie: SECRET && TEST_USER ? sessionCookie(TEST_USER) : undefined });
        if (res.status === 200 || res.status === 404) break;
      }
    }
  });
}

// ------------------------------------------------------------------------------------------

const server = await ensureServer();
let failed = 0;
try {
  await run();
} finally {
  stopServer(server);
  FAKE?.close();
  failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? ` — ${failed} FAILED` : ''}`);
}
process.exit(failed ? 1 : 0);
