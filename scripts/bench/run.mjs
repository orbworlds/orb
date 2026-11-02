#!/usr/bin/env node
// Orb's first-turn bench: the builder as people meet it. Each request in prompts.txt is sent from
// Orb's home page by a new visitor, on a server of this checkout started for the run (its own fresh
// database), and the first turn is watched:
//   first — when the first version of the new world reaches the screen, and how it looks then
//   back  — when Orb hands back (the build stops), and how the world looks then
//   cost  — what the turn's model calls cost, its steps and its looks (from the server's traces)
// Each request's run goes to .data/bench/<label>/<id>/ (first.png and back.png: the world with the
// chat closed; first-full.png and back-full.png: the screen; run.json); summary.json has them all.
//   ANTHROPIC_API_KEY=… node scripts/bench/run.mjs <label> [--only drive,f1] [--repeat 2] [--parallel 3] [--port 3190]
// The server builds on Orb's AI as production does (Claude Opus 5.5 at medium effort). To try a
// change, run it from a checkout with the change and compare labels: scripts/bench/judge.mjs.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { launch } from '../../kit/lib/browser.mjs';
import { root, startNext, stopNext } from '../harness.mjs';

const args = process.argv.slice(2);
const label = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i > 0 ? args[i + 1] : fallback;
};
if (!label || label.startsWith('--')) {
  console.error('usage: node scripts/bench/run.mjs <label> [--only id,id] [--repeat n] [--parallel n] [--port n]');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) console.warn('No ANTHROPIC_API_KEY: builds will use whatever model this checkout is set up for.');
const only = opt('only', '').split(',').filter(Boolean);
const repeat = Number(opt('repeat', 1));
const parallel = Number(opt('parallel', 2));
const port = Number(opt('port', 3190));
const base = `http://localhost:${port}`;
const out = path.join(root, '.data/bench', label);
const sharp = createRequire(path.join(root, 'package.json'))('sharp'); // Next's own image library
/** How different two screenshots look, 0 to 1 (small greyscale versions, pixel by pixel). */
async function apart(a, b) {
  const tiny = (png) => sharp(png).resize(48, 30, { fit: 'fill' }).greyscale().raw().toBuffer();
  const [x, y] = await Promise.all([tiny(a), tiny(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d += Math.abs(x[i] - y[i]);
  return d / x.length / 255;
}
// A desktop screen, but a small one: test machines draw worlds in software, slowly, and every pixel counts.
const SCREEN = { width: 1120, height: 700 };
/** A first turn still going after this long has lost the person anyway: it's stopped and counted so. */
const CAP_MS = 12 * 60_000;
const PRICES = { 'claude-opus-5-5': [4, 20, 0.4, 5], 'claude-sonnet-5-5': [2, 10, 0.2, 2.5], 'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125] }; // $ per M: in, out, cache read, cache write

const prompts = fs
  .readFileSync(path.join(root, 'scripts/bench/prompts.txt'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => ({ id: l.split('|')[0].trim(), prompt: l.slice(l.indexOf('|') + 1).trim() }))
  .filter((p) => !only.length || only.includes(p.id));
const runs = prompts.flatMap((p) => Array.from({ length: repeat }, (_, n) => ({ ...p, name: repeat > 1 ? `${p.id}-${n + 1}` : p.id })));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const server = await startNext({
  port,
  env: {
    ORB_PGLITE_DIR: path.join(out, '.db'),
    // a bench is many new visitors at once from one address: let them all build
    ORB_FREE_DAILY_PER_DEVICE: '1000', ORB_FREE_DAILY_PER_IP: '100000', ORB_FREE_DAILY_PER_ACCOUNT: '1000',
    ORB_FREE_DAILY_USD: '1000', ORB_FREE_DAILY_USD_ANON: '1000', ORB_GUEST_CREDITS: '1000000', ORB_FREE_CREDITS: '1000000',
  },
});
// Every route a build uses, compiled before the clock runs (a dev server compiles on first use).
for (const [method, url] of [['GET', '/'], ['GET', '/w/warmup'], ['POST', '/api/agent/jobs'], ['POST', '/api/agent/tick'], ['POST', '/api/events'], ['GET', `/api/tree/${'0'.repeat(64)}/index.html`], ['GET', `/lab/${process.env.ORB_LAB_KEY || 'dev-lab'}/traces/export?limit=1`]])
  await fetch(`${base}${url}`, { method, ...(method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}) }).then((r) => r.text()).catch(() => '');
const browser = await launch();
{
  const page = await browser.newPage();
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: /Step into a/ }).waitFor({ timeout: 180_000 });
  await page.close();
}

/** How the island every new world starts as looks here: taken once, while nothing has changed it yet. */
let islandLook = null;

/** One request, sent by a new visitor: watched until Orb hands back (or CAP_MS, then stopped). */
async function one(run) {
  const dir = path.join(out, run.name);
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: SCREEN });
  const page = await ctx.newPage();
  // seenFirst: when the world on screen first looked different from the island it starts as (its
  // first version people see; earlier versions can change files the screen doesn't show yet);
  // seenBack: when the build stopped. Both by this browser, which draws worlds in software and so
  // shows them a little late. firstWrite, back: by the server's clock, from its traces (below).
  const r = { id: run.id, name: run.name, prompt: run.prompt, seenFirst: null, seenBack: null, firstWrite: null, back: null };
  let t0 = 0;
  const trees = []; // [tree, seconds after sending]: the island the new world starts as, then each version
  page.on('request', (req) => {
    const m = /\/api\/tree\/([0-9a-f]{64})\/index\.html/.exec(req.url());
    if (m && t0 && !trees.some(([t]) => t === m[1])) trees.push([m[1], (Date.now() - t0) / 1000]);
  });
  // the world alone, as it is with the chat closed (and the whole screen, as the person sees it)
  const world = async () => {
    const hide = await page.addStyleTag({ content: 'aside[aria-label="Orb"] { visibility: hidden !important; }' });
    const png = await page.screenshot({ timeout: 120_000 });
    await hide.evaluate((el) => el.remove());
    return png;
  };
  const keep = async (name, png) => {
    fs.writeFileSync(path.join(dir, `${name}.png`), png);
    await page.screenshot({ path: path.join(dir, `${name}-full.png`), timeout: 120_000 });
  };
  const building = () => page.locator('[aria-label="Stop building"]').count();
  try {
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: /Step into a/ }).waitFor({ timeout: 180_000 });
    const box = page.locator('#orb-hero-composer');
    // a page that isn't ready yet ignores Enter: send again until the build starts
    for (let attempt = 0; attempt < 5 && !r.started; attempt++) {
      await page.waitForTimeout(2000);
      await box.fill(run.prompt);
      t0 = Date.now();
      trees.length = 0;
      await box.press('Enter');
      r.started = await page.locator('[aria-label="Stop building"]').first().waitFor({ timeout: 45_000 }).then(() => true, () => false);
    }
    if (!r.started) throw new Error('the build never started');
    let island = null;
    let checked = 1;
    for (const end = t0 + CAP_MS; ; ) {
      if (Date.now() > end) {
        r.capped = true; // never handed back in time: stop it, as a person would
        await page.locator('[aria-label="Stop building"]').first().click({ timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(5000);
        break;
      }
      const now = (Date.now() - t0) / 1000;
      // the island, before anything changes it: a quick build can change it before it's been taken here,
      // so the first clean look at it is kept for every request
      if (!island && trees.length && now - trees[0][1] > 3) {
        const png = await world();
        if (trees.length === 1) islandLook ??= png;
        island = trees.length === 1 ? png : islandLook ?? png;
      }
      // each new version, once it has had a few seconds to draw: is it the first that looks new?
      if (island && r.seenFirst === null && trees.length > checked && now - trees[trees.length - 1][1] > 5) {
        checked = trees.length;
        const png = await world();
        if ((await apart(png, island)) > 0.05) {
          r.seenFirst = trees[trees.length - 1][1];
          await keep('first', png);
        }
      }
      if (!(await building())) {
        const back = (Date.now() - t0) / 1000;
        await page.waitForTimeout(3000);
        if (!(await building())) {
          r.seenBack = back;
          break;
        }
      }
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(6000); // the last version on screen
    const last = await world();
    await keep('back', last);
    // the first change to show came only with the last version: it's the first version too
    if (r.seenFirst === null && island && (await apart(last, island)) > 0.05) {
      r.seenFirst = trees.length > 1 ? trees[trees.length - 1][1] : r.seenBack;
      await keep('first', last);
    }
    r.versions = Math.max(0, trees.length - 1);
    r.url = page.url();
  } catch (e) {
    r.error = String(e).slice(0, 300);
  }
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(r, null, 2));
  console.log(`${run.name}: first seen ${r.seenFirst ?? '—'} s · back ${r.seenBack ?? '—'} s${r.error ? ` · ${r.error}` : ''}`);
  await ctx.close();
  return r;
}

const queue = [...runs];
const results = [];
await Promise.all(Array.from({ length: parallel }, async () => {
  while (queue.length) results.push(await one(queue.shift()));
}));
await browser.close();

// What each turn cost, from the server's own traces (matched by the request, newest first).
const traces = (await (await fetch(`${base}/lab/${process.env.ORB_LAB_KEY || 'dev-lab'}/traces/export?limit=${runs.length * 3 + 10}`)).text())
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((t) => t.mode === 'build');
await stopNext(server);
const used = new Set();
for (const r of results) {
  const t = traces.find((x) => !used.has(x.id) && x.prompt?.trim() === r.prompt);
  if (!t) continue;
  used.add(t.id);
  const [pin, pout, pread, pwrite] = PRICES[t.model] ?? PRICES['claude-opus-5-5'];
  let usd = 0;
  let lookMs = 0;
  let cut = 0;
  const start = Date.parse(t.events?.[0]?.at ?? t.startedAt);
  for (const e of t.events ?? []) {
    const s = e.summary ?? {};
    if (e.type === 'look') lookMs += s.ms ?? 0;
    if (e.type !== 'step') continue;
    // the first version: the end of the first step that wrote the world's files (they're saved right then)
    if (r.firstWrite === null && (s.tools ?? []).some((x) => x === 'write_file' || x === 'edit_file')) r.firstWrite = Math.round((Date.parse(e.at) - start) / 100) / 10;
    if (s.finish === 'length') cut++;
    const u = s.usage ?? {};
    usd += ((u.in ?? 0) - (u.cacheRead ?? 0) - (u.cacheWrite ?? 0)) * pin + (u.cacheRead ?? 0) * pread + (u.cacheWrite ?? 0) * pwrite + (u.out ?? 0) * pout;
  }
  Object.assign(r, { back: Math.round((t.durationMs ?? 0) / 100) / 10, model: t.model, usd: Math.round(usd / 1e4) / 100, steps: t.steps, looks: t.meta?.looks ?? 0, lookSeconds: Math.round(lookMs / 1000), cutOff: cut, status: t.status });
  fs.writeFileSync(path.join(out, r.name, 'run.json'), JSON.stringify(r, null, 2));
}

const med = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const summary = {
  label,
  runs: results.length,
  seenFirstMedian: med(results.map((r) => r.seenFirst)),
  neverChanged: results.filter((r) => r.seenFirst === null).length,
  firstWriteMedian: med(results.map((r) => r.firstWrite)),
  backMedian: med(results.map((r) => r.back)),
  backWithoutLooksMedian: med(results.filter((r) => r.back !== null).map((r) => r.back - (r.lookSeconds ?? 0))),
  usdMean: mean(results.filter((r) => r.usd !== undefined).map((r) => r.usd)),
  stepsMedian: med(results.map((r) => r.steps)),
  looksMedian: med(results.map((r) => r.looks)),
  cutOff: results.filter((r) => r.cutOff).length,
  capped: results.filter((r) => r.capped).length,
  failed: results.filter((r) => r.error || r.status === 'error').length,
};
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ summary, results }, null, 2));
const s = (v) => (v === null ? '—' : `${Math.round(v)} s`);
console.log(`\n${label}: ${summary.runs} turns · first seen ${s(summary.seenFirstMedian)} (never: ${summary.neverChanged}; first files written ${s(summary.firstWriteMedian)}) · hands back ${s(summary.backMedian)} (${s(summary.backWithoutLooksMedian)} without looks) · $${summary.usdMean?.toFixed(2) ?? '—'} a turn · ${summary.stepsMedian ?? '—'} steps, ${summary.looksMedian ?? '—'} looks · cut off ${summary.cutOff} · not back in ${CAP_MS / 60_000} min ${summary.capped} · failed ${summary.failed}`);
