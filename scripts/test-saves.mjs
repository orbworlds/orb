#!/usr/bin/env node
// Game progress that follows an account (src/lib/savesync.ts, src/server/saves.ts), in a real
// browser: a world that counts its levels in localStorage is played on one device, then on
// another signed into the same account (the count goes on), and by a guest (who starts over).
//
//   node scripts/test-saves.mjs
//
// Starts `next dev` on :3107 (ORB_TEST_PORT) with the mock AI and a fresh database
// (.data/pglite-saves). Exit code 0 = all checks passed.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './pw.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.ORB_TEST_PORT || '3107';
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = '.data/pglite-saves';

const results = [];
function check(name, ok, detail) {
  results.push(!!ok);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}
const device = (label) => `test-${label}-${crypto.randomBytes(8).toString('hex')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, urlPath, { dev, body, cookie } = {}) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { ...(dev ? { 'x-orb-device': dev } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, headers: res.headers, cookie: /orb_session=[^;]+/.exec(res.headers.get('set-cookie') || '')?.[0] ?? null };
}

/** A world that is a game with one save: each start is the next level. */
const GAME = `<!doctype html><html><head><title>Level up</title></head><body><h1 id="lvl">…</h1><script>
const n = Number(localStorage.getItem('level') || 0) + 1;
localStorage.setItem('level', String(n));
document.getElementById('lvl').textContent = 'level ' + n;
</script></body></html>`;

async function startServer() {
  fs.rmSync(path.join(root, DATA_DIR), { recursive: true, force: true });
  const env = { ...process.env, ORB_MOCK_AI: '1', ORB_PGLITE_DIR: DATA_DIR, ORB_SECRET: 'orb-test-secret', NEXT_TELEMETRY_DISABLED: '1' };
  for (const k of ['POSTGRES_URL', 'DATABASE_URL']) delete env[k];
  console.log(`Starting next dev on :${PORT} (PGlite: ${DATA_DIR}) …`);
  const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '-p', PORT], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next dev exited early:\n${log.slice(-2000)}`);
    try {
      if ((await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(90_000) })).ok) return { child, log: () => log };
    } catch {}
    await sleep(1000);
  }
  throw new Error(`next dev did not become ready:\n${log.slice(-2000)}`);
}

async function stopServer({ child }) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  await Promise.race([exited, sleep(15_000)]);
}

const server = await startServer();
const browser = await launch();

/** A browser on a device (its own device key), signed in with `cookie` if given. */
async function deviceBrowser(key, cookie) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((k) => {
    try {
      localStorage.setItem('orb:device', k);
    } catch {
      /* the world's own frame */
    }
  }, key);
  if (cookie) {
    const [name, value] = cookie.split('=');
    await ctx.addCookies([{ name, value, url: BASE }]);
  }
  const page = await ctx.newPage();
  page.setDefaultTimeout(90_000);
  return { ctx, page };
}

/** Open the world and read the level it shows. */
async function play(page, worldId) {
  await page.goto(`${BASE}/w/${worldId}`, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      const text = await f.locator('#lvl').textContent({ timeout: 200 }).catch(() => null);
      if (text && /level \d+/.test(text)) return Number(/\d+/.exec(text)[0]);
    }
    await sleep(300);
  }
  return null;
}

/** Leave the page so its last save is written (and, signed in, sent up). */
async function leave(page) {
  await page.goto('about:blank');
  await sleep(5500);
}

try {
  const MAKER = device('maker');
  const world = (await request('POST', '/api/worlds', { dev: MAKER, body: { name: 'Level up', code: GAME } })).json.world;
  const A = device('laptop');
  const account = await request('POST', '/api/auth/signup', { dev: A, body: { username: `player-${crypto.randomBytes(3).toString('hex')}`, password: 'correct horse battery' } });
  check('a world that saves its level, and an account', !!world?.id && !!account.cookie, account.json);

  console.log('\nOn the laptop, signed in');
  const laptop = await deviceBrowser(A, account.cookie);
  check('the first start is level 1', (await play(laptop.page, world.id)) === 1);
  check('…and the next one level 2: progress kept in this browser', (await play(laptop.page, world.id)) === 2);
  await leave(laptop.page);
  const saves = await request('GET', '/api/saves', { cookie: account.cookie });
  check('the progress went up to the account', saves.status === 200 && saves.json?.saves?.some((s) => s.worldId === world.id), saves.json);

  console.log('\nOn the phone, signed into the same account');
  const phone = await deviceBrowser(device('phone'), account.cookie);
  const phoneLevel = await play(phone.page, world.id);
  check('it goes on from the laptop’s progress: level 3', phoneLevel === 3, phoneLevel);
  await leave(phone.page);

  console.log('\nBack on the laptop');
  check('it takes the phone’s newer progress: level 4', (await play(laptop.page, world.id)) === 4);
  await leave(laptop.page);

  console.log('\nSomeone else, without an account');
  const guest = await deviceBrowser(device('guest'));
  check('a guest starts at level 1 (their progress stays in their browser)', (await play(guest.page, world.id)) === 1);
  const own = await request('GET', '/api/saves', { dev: device('x') });
  check('saves are for accounts → 401 without one', own.status === 401, own.json);

  console.log('\nThe saves API');
  const at = Date.now();
  const put = await request('PUT', `/api/saves/${world.id}`, { cookie: account.cookie, body: { data: { level: '41' }, at } });
  check('a newer copy is kept', put.status === 200 && put.json?.saved === true, put.json);
  const older = await request('PUT', `/api/saves/${world.id}`, { cookie: account.cookie, body: { data: { level: '1' }, at: at - 60_000 } });
  check('…an older one is not (the account’s copy is newer)', older.status === 200 && older.json?.saved === false && older.json.reason === 'older', older.json);
  const fresh = await fetch(`${BASE}/api/saves/${world.id}?since=${at}`, { headers: { cookie: account.cookie } });
  check('asking with the newest time gets nothing new → 204 with the account’s time', fresh.status === 204 && Number(fresh.headers.get('x-orb-save-at')) === at, fresh.status);
  const got = await request('GET', `/api/saves/${world.id}?since=0`, { cookie: account.cookie });
  check('…and with an older one, the save', got.status === 200 && got.json?.data?.level === '41' && got.json.at === at, got.json);
  const bad = await request('PUT', `/api/saves/${world.id}`, { cookie: account.cookie, body: { data: { level: 41 }, at } });
  check('values must be strings → 400', bad.status === 400, bad.json);
  const none = await request('PUT', '/api/saves/nosuchworld', { cookie: account.cookie, body: { data: {}, at } });
  check('no such world → 404', none.status === 404, none.json);
} catch (e) {
  check('unexpected exception', false, e?.stack?.split('\n').slice(0, 4).join(' | ') ?? String(e));
} finally {
  await browser.close();
  await stopServer(server);
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) console.log(server.log().slice(-3000));
process.exit(failed ? 1 : 0);
