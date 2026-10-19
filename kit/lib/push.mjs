// `orb push`: put the world in a folder on Orb, as the person (no dependencies).
//
// The first time on a computer the kit signs in: it shows a link with a code, the person opens it
// where they use Orb and allows it, and the kit keeps the token it gets
// (~/.config/orb/credentials.json, or ORB_TOKEN). In a terminal it waits for that; otherwise (a
// coding agent, CI) it prints the link and exits, and the next `orb push` picks the sign-in up.
//
// Then it sends the folder's files as a .tar.gz. orb.json's `world` is where they go: a new version
// of that world when it is yours, a remix of it when it is someone else's (orb.json then points at
// your remix), a new world when there is none (orb.json gets it). With Playwright installed it
// also takes a screenshot for the world's card.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

export const DEFAULT_SITE = 'https://orbworlds.com';
const SKIP = new Set(['node_modules', 'orb-kit', 'test', 'tests']);
const WAIT_MS = 10 * 60 * 1000;

const configFile = () => path.join(process.env.ORB_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'orb'), 'credentials.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(all) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
}

function saveSite(site, entry) {
  const all = readConfig();
  if (entry) all[site] = entry;
  else delete all[site];
  writeConfig(all);
}

async function call(site, method, url, { token, body, type } = {}) {
  let res;
  try {
    res = await fetch(`${site}${url}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(type ? { 'content-type': type } : {}), 'user-agent': 'orb-kit' },
      body,
    });
  } catch (e) {
    throw new Error(`Couldn't reach ${site} (${e.cause?.code || e.message}).`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, data, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function showLink(url, code) {
  console.log(`\n  To let this computer push worlds to Orb as you, open:\n\n    ${url}\n\n  and press Allow (the code there is ${code}).\n`);
}

/** The kit's token for `site`: ORB_TOKEN, the saved one, or a sign-in (null: not yet — the link was shown). */
export async function signIn(site, { wait = process.stdout.isTTY, quiet = false } = {}) {
  if (process.env.ORB_TOKEN) return process.env.ORB_TOKEN;
  const saved = readConfig()[site];
  if (saved?.token) return saved.token;
  let pending = saved?.pending && Date.now() - saved.pending.at < WAIT_MS ? saved.pending : null;
  if (pending) {
    const got = await pollOnce(site, pending.poll);
    if (got) return got;
    if (got === null) pending = null;
  }
  if (!pending) {
    const r = await call(site, 'POST', '/api/kit/login');
    if (r.status !== 200 || !r.data?.poll) throw new Error(r.data?.message || `Orb didn't start the sign-in (HTTP ${r.status}).`);
    pending = { poll: r.data.poll, code: r.data.code, url: r.data.url, at: Date.now() };
    saveSite(site, { pending });
  }
  if (!quiet || !wait) showLink(pending.url, pending.code);
  if (!wait) {
    console.log('  Then run `orb push` again: it carries on from there.\n');
    return null;
  }
  console.log('  Waiting…');
  const until = pending.at + WAIT_MS;
  while (Date.now() < until) {
    await sleep(2000);
    const got = await pollOnce(site, pending.poll);
    if (got) return got;
    if (got === null) break;
  }
  saveSite(site, null);
  throw new Error('The sign-in link expired. Run `orb push` again for a new one.');
}

/** The token once allowed (and saved), undefined while waiting, null when the sign-in is gone. */
async function pollOnce(site, poll) {
  const r = await call(site, 'GET', `/api/kit/login?poll=${encodeURIComponent(poll)}`);
  if (r.status === 200 && r.data?.token) {
    saveSite(site, { token: r.data.token, name: r.data.name });
    console.log(r.data.name ? `  Signed in as ${r.data.name}.` : '  Signed in.');
    return r.data.token;
  }
  if (r.status === 202) return undefined;
  return null;
}

export function signOut(site) {
  const had = !!readConfig()[site];
  saveSite(site, null);
  return had;
}

/** The world's files: everything in the folder but dot files, node_modules and test folders. */
export function collect(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk('');
  return out.sort();
}

/** A .tar.gz of these files (ustar; a pax header for paths too long for it). */
export function tarGz(dir, files) {
  const blocks = [];
  const header = (name, size, type = '0', prefix = '') => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
    h.write('        ', 148);
    h.write(type, 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    h.write(prefix, 345, 155, 'utf8');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
  };
  const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);
  for (const f of files) {
    const data = fs.readFileSync(path.join(dir, f));
    const bytes = Buffer.byteLength(f);
    if (bytes > 100) {
      const record = (len) => `${len} path=${f}\n`;
      let len = Buffer.byteLength(record(0));
      while (Buffer.byteLength(record(len)) !== len) len = Buffer.byteLength(record(len));
      const pax = Buffer.from(record(len));
      blocks.push(header('PaxHeader', pax.length, 'x'), pax, pad(pax.length));
    }
    blocks.push(header(bytes > 100 ? f.slice(-100) : f, data.length), data, pad(data.length));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** A screenshot of the world as Orb shows it (JPEG), or null without Playwright. */
async function screenshot(dir) {
  let launch;
  try {
    ({ launch } = await import('./browser.mjs'));
  } catch {
    return null;
  }
  const { serve } = await import('./server.mjs');
  const kit = await serve({ dir, port: 0, watch: false, quiet: true });
  let browser;
  try {
    browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${kit.url}?bare`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(Number(process.env.ORB_SHOT_WAIT || 8000));
    return await page.screenshot({ type: 'jpeg', quality: 78, timeout: 60000 });
  } catch {
    return null;
  } finally {
    await browser?.close().catch(() => {});
    await kit.close();
  }
}

/**
 * Push the world in `dir` (`project`: where orb.json lives). Returns { url, outcome, world } or
 * null when the sign-in link was shown and the push has to be run again.
 */
export async function push({ dir, project, site, message, fresh = false, shot = true, log = console.log }) {
  const metaFile = path.join(project, 'orb.json');
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  } catch {
    /* none yet */
  }
  const files = collect(dir);
  if (!files.includes('index.html')) throw new Error(`There is no index.html in ${path.relative(process.cwd(), dir) || 'this folder'}: Orb runs a world from it.`);
  const body = tarGz(dir, files);

  let token = await signIn(site);
  if (!token) return null;
  const q = new URLSearchParams();
  if (meta.world && !fresh) q.set('world', meta.world);
  if (meta.name) q.set('name', meta.name);
  if (message) q.set('message', message);
  log(`Pushing ${files.length} file${files.length === 1 ? '' : 's'} (${Math.round(body.length / 1024)} KB)…`);
  let r = await call(site, 'POST', `/api/kit/push?${q}`, { token, body, type: 'application/gzip' });
  if (r.status === 401 && !process.env.ORB_TOKEN) {
    saveSite(site, null);
    token = await signIn(site);
    if (!token) return null;
    r = await call(site, 'POST', `/api/kit/push?${q}`, { token, body, type: 'application/gzip' });
  }
  if (r.status !== 200 || !r.data?.world) throw new Error(r.data?.message || `Orb didn't take the push (HTTP ${r.status}): ${r.text.slice(0, 200)}`);
  const { world, outcome, url, skipped = [] } = r.data;
  if (skipped.length) log(`Left out ${skipped.length} file${skipped.length === 1 ? '' : 's'} Orb can't hold (a name or folder depth it doesn't take): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '…' : ''}`);

  if (outcome === 'created' || outcome === 'remixed' || meta.world !== world.id || meta.url !== url) {
    const next = { ...meta, name: meta.name || world.name, world: world.id, url };
    if (outcome === 'remixed') next.remixOf = meta.world;
    fs.writeFileSync(metaFile, `${JSON.stringify(next, null, 2)}\n`);
  }
  if (shot && outcome !== 'unchanged') {
    const img = await screenshot(dir);
    if (img && img.length <= 500_000) await call(site, 'PUT', `/api/worlds/${encodeURIComponent(world.id)}/thumb`, { token, body: img, type: 'image/jpeg' });
  }
  return { url, outcome, world };
}
