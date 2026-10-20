#!/usr/bin/env node
// Build a world on a running Orb the way a visitor would, and keep what happened: screenshots while
// it builds, the finished world (as a visitor sees it, after a drag and a tap), its files, and a
// summary (time to the first step, total time, steps, the builder's words, page errors).
//
//   node scripts/build-check.mjs "a cozy snow globe with a little cabin"            # production
//   node scripts/build-check.mjs --base http://localhost:3000 --out .data/check "…"   # any deployment
//
// The test world is deleted at the end (pass --keep to keep it), so checks against production
// leave nothing behind in Explore. The page stays open for the whole build: the builder plays the
// world in it (its look tool), just like in a person's browser.
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './pw.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const base = opt('--base', 'https://orbworld.vercel.app').replace(/\/$/, '');
const minutes = Number(opt('--minutes', '30'));
const outArg = opt('--out', null);
const keepIdx = args.indexOf('--keep');
const keep = keepIdx >= 0 && !!args.splice(keepIdx, 1);
const prompt = args.join(' ').trim();
if (!prompt) {
  console.log('Usage: node scripts/build-check.mjs [--base <url>] [--out <dir>] [--minutes 30] [--keep] "<prompt>"');
  process.exit(1);
}
const out = outArg ?? path.join('.data', 'build-check', `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`);
fs.mkdirSync(path.join(out, 'files'), { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text().slice(0, 300)}`));

await page.goto(`${base}/?prompt=${encodeURIComponent(prompt)}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
// The home page's composer (the Orb's own chat composer is there too, hidden until it opens)
const box = page.locator('#orb-hero-composer textarea, textarea:visible').first();
await box.waitFor({ timeout: 90_000 });
await page.waitForTimeout(2500);
if (!(await box.inputValue())) await box.fill(prompt);
const t0 = Date.now();
await box.press('Enter');
log('sent:', prompt);

/** The newest assistant message with a build, from this browser's saved chats. */
const latestBuild = () =>
  page.evaluate(() => {
    let best = null;
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith('orb:chat:')) continue;
      try {
        for (const m of JSON.parse(localStorage.getItem(k) || '[]')) if (m.role === 'assistant' && m.build && (!best || m.createdAt > best.createdAt)) best = m;
      } catch {
        /* not a chat */
      }
    }
    return best && { text: best.text, status: best.build.status, steps: best.build.steps, version: best.build.toVersion, title: best.build.title, suggestions: best.build.suggestions, error: best.build.error };
  });

let state = null;
let firstStep = null;
let lastShot = 0;
for (;;) {
  await page.waitForTimeout(2000);
  state = await latestBuild().catch(() => null);
  const s = (Date.now() - t0) / 1000;
  if (state?.steps?.length && firstStep == null) firstStep = s;
  if (Date.now() - lastShot > 30_000) {
    lastShot = Date.now();
    await page.screenshot({ path: path.join(out, `building-${String(Math.round(s)).padStart(4, '0')}s.png`) });
    log(`${Math.round(s)}s`, state?.status ?? 'waiting', `${state?.steps?.length ?? 0} steps`);
  }
  if (state && state.status !== 'streaming') break;
  if (s > minutes * 60) {
    log(`still building after ${minutes} minutes — stopping the check`);
    break;
  }
}
const total = (Date.now() - t0) / 1000;
log('done:', state?.status, `${Math.round(total)}s`, state?.error ?? '');
await page.waitForTimeout(6000);
await page.screenshot({ path: path.join(out, 'owner.png') });

const pathname = new URL(page.url()).pathname;
const deviceKey = await page.evaluate(() => localStorage.getItem('orb:device') || '');
const id = pathname.startsWith('/w/')
  ? decodeURIComponent(pathname.slice(3))
  : await page.evaluate(async (p) => {
      const [h, s] = p.slice(1).split('/');
      const r = await fetch(`/api/paths?handle=${encodeURIComponent(h)}&slug=${encodeURIComponent(s)}`);
      return r.ok ? (await r.json()).id : null;
    }, pathname);
const world = id ? await (await fetch(`${base}/api/worlds/${encodeURIComponent(id)}`, { headers: { 'x-orb-device': deviceKey } })).json().then((j) => j.world, () => null) : null;

// The world's files, found by following relative references from index.html.
const files = {};
if (world?.tree) {
  const queue = ['index.html'];
  while (queue.length && Object.keys(files).length < 100) {
    const p = queue.shift();
    if (p in files) continue;
    const res = await fetch(`${base}/api/tree/${world.tree}/${p}`);
    files[p] = res.ok ? await res.text() : null;
    if (files[p] == null) continue;
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
    for (const m of files[p].matchAll(/(?:src|href)=["'](\.?\/?[\w./-]+\.(?:js|mjs|css|json|svg))["']|(?:from|import)\s*\(?\s*["'](\.{1,2}\/[\w./-]+)["']/g)) {
      const ref = (m[1] || m[2]).replace(/^\.\//, '');
      const joined = path.posix.normalize(path.posix.join(dir, ref));
      if (!/^https?:/.test(ref) && !joined.startsWith('..')) queue.push(joined);
    }
  }
} else if (world?.code) files['index.html'] = world.code;
for (const [p, text] of Object.entries(files)) {
  if (text == null) continue;
  fs.mkdirSync(path.dirname(path.join(out, 'files', p)), { recursive: true });
  fs.writeFileSync(path.join(out, 'files', p), text);
}

// What a visitor sees: the world full screen, then after a drag and a tap.
if (id) {
  const vctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const v = await vctx.newPage();
  await v.goto(`${base}${pathname}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await v.waitForTimeout(8000);
  await v.screenshot({ path: path.join(out, 'visitor-1.png') });
  await v.mouse.move(500, 400);
  await v.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await v.mouse.move(500 + i * 15, 400, { steps: 1 });
    await v.waitForTimeout(30);
  }
  await v.mouse.up();
  await v.waitForTimeout(800);
  await v.screenshot({ path: path.join(out, 'visitor-2-dragged.png') });
  await v.mouse.click(640, 420);
  await v.waitForTimeout(1500);
  await v.screenshot({ path: path.join(out, 'visitor-3-tapped.png') });
  await vctx.close();
}

const summary = { base, prompt, url: page.url(), id, status: state?.status, error: state?.error, totalSeconds: Math.round(total), firstStepSeconds: firstStep, steps: state?.steps?.map((s) => `${s.status === 'done' ? '✓' : '✗'} ${s.label}`), said: state?.text, suggestions: state?.suggestions, world: world && { name: world.name, version: world.version }, files: Object.keys(files), pageErrors: errors };
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
if (id && !keep) {
  const res = await fetch(`${base}/api/worlds/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'x-orb-device': deviceKey } });
  log(res.ok ? 'deleted the test world' : `couldn't delete the test world (${res.status}) — ${base}${pathname}`);
}
log('saved to', out);
await browser.close();
