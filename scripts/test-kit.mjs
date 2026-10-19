#!/usr/bin/env node
// The Orb kit (kit/, on npm as @orbworlds/kit, published by scripts/publish-kit.mjs): the package
// holds Orb's runtime; a small world plays through it in a browser as two players (two
// tabs): Orb's runtime is there, rooms join the tabs, orb.store is shared, saves survive a reload,
// the shop sells through the kit's sheet, invite links work, and nothing throws. Then `orb test`
// passes that world and fails one that throws, and `orb share` links a fork to Orb.
//
//   node scripts/test-kit.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, routeCdn } from './pw.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed++;
};

// ---- the package -------------------------------------------------------------------------------

const tgz = execFileSync(process.execPath, [path.join(root, 'scripts/publish-kit.mjs'), '--dry'], { encoding: 'utf8' }).trim().split('\n').pop();
const listed = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' });
check('the package has the kit, its runtime and types', ['package/bin/orb.mjs', 'package/lib/server.mjs', 'package/lib/runtime.js', 'package/lib/browser.mjs', 'package/lib/smoke.mjs', 'package/orb.d.ts'].every((f) => listed.includes(f)), listed);
check('its runtime is Orb’s', fs.readFileSync(path.join(root, 'kit/lib/runtime.js'), 'utf8').includes('room.setState'));

// A world to play: a canvas, a shop list, and which Orb world it is.
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-kit-world-'));
fs.writeFileSync(path.join(world, 'orb.json'), JSON.stringify({ name: 'Kit test', world: 'orb-kit-test', url: 'https://orbworlds.com/orb/kit-test', repo: 'orbworlds/kit-test' }));
fs.writeFileSync(path.join(world, 'index.html'), `<!doctype html><html><body style="margin:0;background:#123">
<script type="application/json" id="orb-shop">{ "items": [ { "id": "hat", "name": "Party hat", "price": 100, "emoji": "🎉" }, { "id": "cape", "name": "Cape", "price": 200 } ] }</script>
<canvas id="c" width="800" height="500"></canvas>
<script>const g = document.getElementById('c').getContext('2d'); g.fillStyle = '#7bf'; g.fillRect(100, 100, 300, 200);</script>
</body></html>`);

// ---- playing through the kit -------------------------------------------------------------------

const { serve } = await import(path.join(root, 'kit/lib/server.mjs'));
const server = await serve({ dir: world, port: 0, quiet: true });
const browser = await launch();
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  await routeCdn(context);
  const open = async (player) => {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${server.url}?player=${player}`);
    const frame = await waitFrame(page);
    await frame.waitForFunction(() => !!window.orb, null, { timeout: 30000 });
    return { page, frame, errors };
  };
  const a = await open(1);
  const b = await open(2);

  check('the world runs with Orb’s runtime (window.orb)', await a.frame.evaluate(() => typeof window.orb?.store?.get === 'function' && typeof window.orb?.room?.join === 'function'));
  check('each tab is its own player', (await a.frame.evaluate(() => window.orb.me.name)) === 'Player 1' && (await b.frame.evaluate(() => window.orb.me.name)) === 'Player 2');
  check('the world knows which Orb world it is', (await a.frame.evaluate(() => window.orb.world.id)) === 'orb-kit-test');

  const joinRoom = (f) =>
    f.evaluate(
      () =>
        new Promise((resolve) => {
          const seen = new Set();
          const room = window.orb.room.join(
            (e) => {
              if (e.type === 'joined') e.peers.forEach((p) => seen.add(p.name));
              if (e.type === 'join') seen.add(e.peer.name);
              if (e.type === 'message') window.__kitMsg = e.data;
              window.__kitSeen = [...seen];
            },
            { name: 'kit-test' },
          );
          window.__kitRoom = room;
          resolve(true);
        }),
    );
  await joinRoom(a.frame);
  await joinRoom(b.frame);
  await a.page.waitForTimeout(600);
  check('two tabs meet in a room', (await a.frame.evaluate(() => window.__kitSeen)).includes('Player 2') && (await b.frame.evaluate(() => window.__kitSeen)).includes('Player 1'));
  await a.frame.evaluate(() => window.__kitRoom.send({ hi: 1 }));
  await b.page.waitForTimeout(200);
  check('room messages arrive', (await b.frame.evaluate(() => window.__kitMsg))?.hi === 1);

  await a.frame.evaluate(() => window.orb.store.set('kit-test', { n: 1 }));
  await a.frame.evaluate(() => window.orb.store.merge('kit-test', { m: 2 }));
  check('orb.store is shared between players', JSON.stringify(await b.frame.evaluate(() => window.orb.store.get('kit-test'))) === '{"n":1,"m":2}');
  check('orb.store keeps Orb’s limits', (await a.frame.evaluate(() => window.orb.store.set('kit-big', 'x'.repeat(9000)).then(() => 'ok', (e) => e.message))).includes('8 KB'));

  const url = await a.frame.evaluate(() => window.orb.room.invite('squad-1'));
  check('invite links open the world in that room', typeof url === 'string' && url.endsWith('/?room=squad-1'), url);

  await a.frame.evaluate(() => localStorage.setItem('kit-save', 'kept'));
  await a.page.waitForTimeout(500);
  await a.page.reload();
  a.frame = await waitFrame(a.page);
  await a.frame.waitForFunction(() => !!window.orb, null, { timeout: 30000 });
  check('saves survive a reload', (await a.frame.evaluate(() => localStorage.getItem('kit-save'))) === 'kept');
  check('…and belong to their player', (await b.frame.evaluate(() => localStorage.getItem('kit-save'))) === null);

  const items = await a.frame.evaluate(() => window.orb.shop.items());
  check('the shop sells the page’s own list', Array.isArray(items) && items.length === 2, JSON.stringify(items).slice(0, 120));
  const buying = a.frame.evaluate((id) => window.orb.shop.buy(id), items[0].id);
  await a.page.locator('#sheet.open').waitFor({ timeout: 5000 });
  check('buying asks in the kit’s sheet', (await a.page.locator('#sheet-name').textContent()) === items[0].name);
  await a.page.click('#sheet-buy');
  check('…and the player gets it', (await buying).ok === true && (await a.frame.evaluate(() => window.orb.shop.owned())).includes(items[0].id));

  await a.page.waitForTimeout(4000);
  const errorsShown = await a.page.locator('#errors').isVisible();
  check('the world runs without an error', !errorsShown && !a.errors.length, errorsShown ? await a.page.locator('#errors').textContent() : a.errors.join('; '));
  await a.page.screenshot({ path: path.join(os.tmpdir(), 'orb-kit-test.png') });
} finally {
  await browser.close();
  await server.close();
}

// ---- orb test -------------------------------------------------------------------------------------

const orbBin = path.join(root, 'kit/bin/orb.mjs');
const run = (dir, ...a) => { try { return { ok: true, out: execFileSync(process.execPath, [orbBin, ...a], { cwd: dir, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, SMOKE_WAIT: '3000' } }) }; } catch (e) { return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` }; } };
// Playwright comes from the project using the kit: here, Orb's
const passed = run(root, 'test', world);
check('orb test passes a world that draws without an error', passed.ok, passed.out);
const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-kit-broken-'));
fs.writeFileSync(path.join(broken, 'index.html'), '<!doctype html><canvas width=400 height=300></canvas><script>throw new Error("kaboom")</script>');
const failing = run(root, 'test', broken);
check('…and fails one that throws, saying what', !failing.ok && failing.out.includes('kaboom'), failing.out);

// ---- orb share in a fork ---------------------------------------------------------------------------

execFileSync('git', ['init', '-q'], { cwd: world });
execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/someone/kit-test.git'], { cwd: world });
const said = run(world, 'share').out;
check('orb share in a fork links to importing it on Orb', said.includes('/?import=github.com%2Fsomeone%2Fkit-test') && said.includes('?remix'), said);
fs.rmSync(world, { recursive: true, force: true });
fs.rmSync(broken, { recursive: true, force: true });

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

async function waitFrame(page) {
  for (let i = 0; i < 150; i++) {
    for (const f of page.frames().filter((x) => x !== page.mainFrame())) {
      try {
        if (await f.evaluate(() => !!window.orb && document.readyState !== 'loading')) return f;
      } catch {
        /* still loading, or replaced */
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error('the world frame never loaded');
}
