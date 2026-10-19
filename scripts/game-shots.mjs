#!/usr/bin/env node
// Screenshots of Orb's open-source worlds, for their READMEs: they live in each world's repository
// (docs/screenshots/<n>.webp), the only place they are. Each world is cloned (the branch Orb plays,
// src/data/originals.json), played for a moment through the Orb kit as Orb runs it (or opened
// directly, for worlds whose debug and shot modes read the address), and a few moments of it are
// kept and committed to its repository as the org's GitHub App. The big games' first shot is their
// thumbnail, staged by scripts/thumb-<game>.mjs. Run it again after a world's looks change:
//
//   ORB_APP_ID=… ORB_APP_KEY=… node scripts/game-shots.mjs [--only <repo>] [--dry: into .data/shots/<repo> instead]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { launch } from './pw.mjs';
import { serve } from '../kit/lib/server.mjs';
import { appLogin, gitAs } from './org-app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src/data/originals.json'), 'utf8'));
const arg = (name) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : null);
const only = arg('only'), dry = process.argv.includes('--dry');
const W = 1280, H = 800;
const TREE = '0'.repeat(64);

execFileSync(process.execPath, [path.join(root, 'scripts/publish-kit.mjs'), '--runtime'], { stdio: 'ignore' }); // the kit's runtime
const app = await appLogin(catalog.org);
const { git, commit } = gitAs(app);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-shots-'));

const save = async (png, file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp(png).resize(W, H, { fit: 'cover' }).webp({ quality: 82 }).toFile(file);
};
const thumb = (game, file) => execFileSync(process.execPath, [path.join(root, `scripts/thumb-${game}.mjs`), '--out', file, '--game', path.join(current.dir, 'index.html')], { stdio: 'ignore' });
const current = { dir: '' };

// A recipe per world: `open(query?, { host, player })` → { page, frame }; `shot()` keeps the next picture.
const RECIPES = {
  async bedwars({ open, shot, png }) {
    await png(thumb.bind(null, 'bedwars'));
    const { page } = await open('debug');
    await page.addStyleTag({ content: '#lockHint, #tip { display: none !important }' });
    await page.waitForFunction(() => window.__bw?.game.mode === 'lobby', null, { timeout: 90000 });
    await page.waitForTimeout(2500);
    await page.keyboard.press('Escape'); // the daily reward
    await page.waitForTimeout(400);
    if (await page.evaluate(() => window.__bw.game.state === 'pause')) await page.keyboard.press('Escape');
    await page.evaluate(() => { const b = window.__bw; b.cam.dist = 6.5; b.cam.pitch = -0.28; });
    await page.waitForTimeout(2000);
    await shot();
    // a match a minute in, in first person: your sword in hand, the islands bridged
    await page.evaluate(() => { const b = window.__bw; b.mp = 1; b.playMode('duos'); });
    await page.evaluate(() => { window.__bw.match.cd = 0.05; });
    await page.waitForFunction(() => window.__bw.match.phase === 'play', null, { timeout: 30000 });
    await page.evaluate(() => { window.__bw.speed = 18; });
    await page.waitForTimeout(5000);
    await page.evaluate(() => {
      const b = window.__bw, p = b.player, w = b.world(), base = w.bases[p.team];
      b.speed = 1; p.prot = 99; b.cam.first = true; p.sword = 2; p.inv.wool = 24;
      b.setSel(b.hotbarItems().findIndex((i) => i.kind === 'sword'));
      b.cam.yaw = Math.atan2(base.x - w.center.x, base.z - w.center.z); b.cam.pitch = -0.12;
    });
    await page.waitForTimeout(2500);
    await shot();
  },
  async orbcraft({ open, shot, png, best }) {
    await png(thumb.bind(null, 'craft'));
    const { page } = await open('debug&nodaily');
    await page.waitForFunction(() => window.__oc?.player && document.getElementById('loading')?.classList.contains('out'), null, { timeout: 120000 });
    await page.evaluate(() => { const o = window.__oc, c = o.wildClock(); o.clockShift = (o.clockShift || 0) - c.t + 60; });
    await page.waitForTimeout(5000);
    await shot();
    await page.evaluate(() => window.__oc.openPanel('travel'));
    await page.waitForTimeout(700);
    await page.locator('button', { hasText: /^Go$/ }).first().click({ timeout: 5000 }).catch(() => {});
    await page.evaluate(() => window.__oc.closePanel?.());
    await page.waitForTimeout(6000);
    await best([0, 1.6, 3.14, -1.6].map((yaw) => () => page.evaluate((y) => { const o = window.__oc; if (o.cam) { o.cam.yaw = y; o.cam.pitch = -0.2; o.cam.dist = 7; } }, yaw)));
  },
  async vampirez({ open, shot, png, best }) {
    await png(thumb.bind(null, 'vampirez'));
    const { page } = await open('debug&nodaily');
    await page.waitForFunction(() => window.__vz?.game, null, { timeout: 90000 });
    await page.waitForTimeout(5000);
    await page.evaluate(() => window.__vz.closePanels());
    await page.waitForTimeout(600);
    await shot();
    await page.evaluate(() => window.__vz.start());
    await page.waitForTimeout(9000);
    await best([0, 1.6, 3.14, -1.6].map((yaw) => () => page.evaluate((y) => { const v = window.__vz; v.cam.yaw = y; v.cam.pitch = -0.1; }, yaw)));
  },
  async 'foxfire-fjord'({ open, shot }) {
    // its shot mode says when the scene is ready and counts frames (tools/shot.mjs); software rendering is slow
    for (const q of ['shot&view=overview&time=22.5&aurora=0.9', 'shot&view=cabin&time=23&aurora=0.8', 'shot&view=lake&time=12.5']) {
      const { page } = await open(q);
      await page.waitForFunction(() => window.__SCENE_READY__ === true, null, { timeout: 600000, polling: 1000 });
      const f0 = await page.evaluate(() => window.__FRAMES__ || 0);
      await page.waitForFunction((s) => (window.__FRAMES__ || 0) >= s + 6, f0, { timeout: 600000, polling: 500 });
      await shot(900000);
      await page.close();
    }
  },
  async wildbrush({ open, shot }) {
    // its showcases of the paints (src/elements/demo.js), once it has drawn its first frames (window.__wb.ready)
    for (const q of ['shot&elementsdemo=fire', 'shot&elementsdemo=meadow', 'shot&elementsdemo=ice']) {
      const { page } = await open(q);
      await page.waitForFunction(() => window.__wb?.ready, null, { timeout: 900000, polling: 1000 }); // 20 frames drawn
      await page.waitForTimeout(3000);
      await shot(900000);
      await page.close();
    }
  },
  async 'wish-lanterns'({ open, shot }) {
    const { page, frame } = await open(null, { host: true });
    await page.waitForTimeout(9000);
    await shot();
    const input = frame.locator('input, textarea').first();
    await input.fill('That everyone gets home safe tonight').catch(() => {});
    await frame.locator('button', { hasText: /Release/ }).first().click().catch(() => {});
    await page.waitForTimeout(5000);
    await shot();
  },
  async 'community-garden'({ open, shot }) {
    const { page } = await open(null, { host: true });
    await page.waitForTimeout(7000);
    for (const [x, y] of [[560, 560], [700, 600], [640, 520], [780, 540], [500, 620], [860, 610]]) { await page.mouse.click(x, y); await page.waitForTimeout(500); }
    await page.waitForTimeout(7000);
    await shot();
  },
  async hangout({ open, shot }) {
    const extra = [];
    for (const [n, name] of [[2, 'Mia'], [3, 'Theo'], [4, 'Sam']]) extra.push(await open(null, { host: true, player: n, name }));
    for (const [i, e] of extra.entries()) { await e.page.keyboard.down(['KeyA', 'KeyD', 'KeyW'][i]); await e.page.waitForTimeout(700 + i * 300); await e.page.keyboard.up(['KeyA', 'KeyD', 'KeyW'][i]); }
    const { page, frame } = await open(null, { host: true, player: 1, name: 'Ana' });
    await page.waitForTimeout(8000);
    await shot();
    await frame.locator('button').first().click().catch(() => {});
    await page.waitForTimeout(800);
    await shot();
  },
  async 'seashell-island'({ open, shot }) {
    const { page } = await open(null, { host: true });
    await page.waitForTimeout(8000);
    await shot();
    await page.mouse.click(640, 400);
    await page.keyboard.down('KeyW'); await page.waitForTimeout(2500); await page.keyboard.up('KeyW');
    await page.mouse.move(640, 400); await page.mouse.down(); await page.mouse.move(420, 380, { steps: 12 }); await page.mouse.up();
    await page.waitForTimeout(1500);
    await shot();
  },
  async 'block-garden'({ open, shot }) {
    const { page } = await open(null, { host: true });
    await page.waitForTimeout(7000);
    for (let i = 0; i < 6; i++) for (const [x, y] of [[600, 470], [660, 470], [720, 470]]) { await page.keyboard.press(`Digit${(i % 4) + 1}`); await page.mouse.click(x, y - i * 2); await page.waitForTimeout(150); }
    await page.waitForTimeout(1500);
    await shot();
    await page.keyboard.press('KeyN');
    await page.waitForTimeout(3000);
    await shot();
  },
  async 'star-runner'({ open, shot }) {
    const { page } = await open(null, { host: true });
    await page.waitForTimeout(6000);
    await shot();
    await page.mouse.click(640, 400);
    await page.keyboard.press('Space');
    await page.waitForTimeout(3200);
    await page.keyboard.press('Space');
    await page.waitForTimeout(250);
    await shot();
  },
  async 'glow-paint'({ open, shot }) {
    const { page } = await open(null, { host: true });
    await page.waitForTimeout(6000);
    const loop = async (cx, cy, r, turns) => {
      await page.mouse.move(cx + r, cy); await page.mouse.down();
      for (let a = 0; a <= Math.PI * 2 * turns; a += 0.12) await page.mouse.move(cx + Math.cos(a) * r * (1 - a / (14 * turns)), cy + Math.sin(a) * r * 0.7);
      await page.mouse.up();
    };
    await loop(520, 380, 170, 2); await loop(780, 420, 140, 2); await loop(650, 300, 90, 1);
    await page.waitForTimeout(1500);
    await shot();
    await page.keyboard.press('KeyL');
    await page.mouse.move(640, 400); await page.mouse.down(); await page.mouse.move(480, 380, { steps: 15 }); await page.mouse.up();
    await page.waitForTimeout(1500);
    await shot();
  },
  async 'dream-room'({ open, shot }) {
    const { page, frame } = await open(null, { host: true });
    await page.waitForTimeout(7000);
    const items = frame.locator('#tray button, .tray button, [data-kind], [data-item]');
    const n = Math.min(await items.count().catch(() => 0), 6);
    for (let i = 0; i < n; i++) { await items.nth(i).click().catch(() => {}); await page.mouse.click(460 + i * 70, 470 + (i % 2) * 60); await page.waitForTimeout(400); }
    await page.waitForTimeout(1500);
    await shot();
    await page.keyboard.press('KeyN');
    await page.waitForTimeout(2500);
    await shot();
  },
};

const browser = await launch();
for (const g of catalog.worlds.filter((x) => !only || x.repo === only)) {
  const recipe = RECIPES[g.repo];
  if (!recipe) { console.log(`${g.repo}: no recipe`); continue; }
  // the world as Orb plays it (its branch), and its main, where the screenshots go
  const full = `${catalog.org}/${g.repo}`;
  const dir = path.join(tmp, `${g.repo}-play`), main = path.join(tmp, g.repo);
  git(tmp, 'clone', '--quiet', '--depth', '1', '--branch', g.branch, `https://github.com/${full}.git`, dir);
  if (g.branch === 'main') fs.cpSync(dir, main, { recursive: true }); else git(tmp, 'clone', '--quiet', '--depth', '1', `https://github.com/${full}.git`, main);
  current.dir = dir;
  const kit = await serve({ dir, port: 0, watch: false, quiet: true });
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const out = dry ? path.join(root, '.data/shots', g.repo) : path.join(main, 'docs/screenshots');
  fs.rmSync(out, { recursive: true, force: true });
  let n = 0, page0 = null;
  const open = async (query, { host = false, player = 1, name } = {}) => {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`  ${g.repo}: ${e.message.slice(0, 160)}`));
    const url = host ? `${kit.url}?bare&player=${player}${name ? `&name=${encodeURIComponent(name)}` : ''}` : `${kit.url}api/tree/${TREE}/index.html${query ? `?${query}` : ''}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    if (host) await page.waitForFunction(() => document.querySelector('iframe'), null, { timeout: 30000 });
    else await page.addStyleTag({ content: '#lockHint { display: none !important }' }).catch(() => {}); // "click to look around": the mouse isn't ours headless
    const frame = host ? (await page.waitForTimeout(500), page.mainFrame().childFrames()[0]) : page.mainFrame();
    page0 = page;
    return { page, frame };
  };
  const shot = async (timeout = 180000) => { const png = await page0.screenshot({ timeout }); await save(png, path.join(out, `${++n}.webp`)); console.log(`  ${g.repo}/${n}.webp`); };
  // of a few framings, the one with the most in it (the biggest picture): never a wall
  const best = async (framings) => {
    let top = null;
    for (const set of framings) { await set(); await page0.waitForTimeout(1500); const p = await page0.screenshot({ timeout: 180000 }); if (!top || p.length > top.length) top = p; }
    await save(top, path.join(out, `${++n}.webp`)); console.log(`  ${g.repo}/${n}.webp (best of ${framings.length})`);
  };
  const png = async (make) => { const f = path.join(tmp, `${g.repo}-${n + 1}.png`); make(f); await save(fs.readFileSync(f), path.join(out, `${++n}.webp`)); console.log(`  ${g.repo}/${n}.webp (thumbnail)`); };
  console.log(g.repo);
  try {
    await recipe({ open, shot, png, best });
    if (!dry && n) {
      git(main, 'add', '-A', 'docs/screenshots');
      if (git(main, 'status', '--porcelain')) { commit(main, 'Screenshots, as the world looks now'); git(main, 'push', '--quiet', 'origin', 'HEAD:main'); console.log(`  ${full}: pushed`); }
    }
  } catch (e) {
    console.log(`  ${g.repo} failed: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
  await ctx.close();
  await kit.close();
}
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
