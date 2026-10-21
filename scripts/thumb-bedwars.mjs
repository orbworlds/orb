#!/usr/bin/env node
// Renders Bed Wars' thumbnail (public/templates/bedwars.webp, Orb’s picture of it) in the game itself: Red's crowned champion bringing a
// diamond sword down on Blue's bed on Sunset Mesa, Blue's ninja running in to stop it, team bridges reaching out to
// the middle and the other islands in the evening haze, and the game's title in the sky. The shot is staged through the
// game's debug hooks (bedwars.html?debug exposes window.__bw), drawn at twice the size in Chromium and finished with
// sharp. Run it again after changing how the arenas, the people or their looks are drawn:
//
//   node scripts/thumb-bedwars.mjs [--out <file.webp|png>] [--game <a checkout of orbworlds/bedwars>/index.html]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { launch, routeCdn } from '../kit/lib/browser.mjs';
import { originalFile } from './original.mjs';
import { grain, steady, svg, titleShot } from './thumb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(root, 'public/templates/bedwars.webp');
// the game: --game <its index.html>, or the Original as Orb serves it (its repository's)
const GAME = await originalFile('orb-bedwars');
const W = 1280, H = 800;

// The shot, in the frame of Blue's base (team 1) on Sunset Mesa (arena 2): `a` blocks inward from the island's middle
// toward the arena's middle, `s` blocks to the side, `y` up from the island's top. The camera hangs behind the bed.
const SHOT = {
  mp: 2, base: 1, fov: 50,
  cam: [-6.9, -0.3, 3.3], look: [2, 0.7, 0.9],
  // [team, from [a, s], to [a, s]]: bridges out of Blue's front, one below the island's top
  bridges: [[0, [5, 0], [34, 0]], [2, [5, 3], [30, 18]], [3, [5, -3], [28, -16]]],
  // decorations out of the camera's way: everything above the island's top in these [a0, a1, s0, s1] boxes
  clear: [[-9, -1.6, -9, -2.2], [-9, -1.6, 2.2, 9]],
  // [a, s, y, count, colour, options]: bits of Blue's bed and sparks where the sword comes down
  fx: [[-2.9, 0, 0.7, 10, '#4b8bff', { soft: true, spread: 1.6, size: 0.12 }], [-2.6, 0, 1.0, 26, '#ffcf4a', { spread: 2.2, size: 0.09, mul: 2.2 }]],
  // who's in it, where ([a, s]), facing the camera (turned by `turn`) or someone, and their pose (radians)
  cast: [
    { team: 0, name: 'Red', at: [-0.95, 0.05], face: 'cam', turn: 0.6, held: 's3', pitch: -0.3, wear: { hat: 'hat-crown' }, seed: 3,
      pose: { armR: [-3.4, 0, 0.6], armL: [0.5, 0, -0.2], legs: [0.45, -0.45] } },
    { team: 1, name: 'Blue', at: [1.0, -2.1], face: [-0.95, 0.05], held: 's2', seed: 11, wear: { outfit: 'fit-ninja' },
      pose: { armR: [-1.5, 0, 0.1], armL: [0.6, 0, -0.1], legs: [-0.6, 0.6] } },
  ],
};

// The title, top right (clear of where link previews put Orb's mark and the world's name), in the game's font: BED in
// Red's colour, WARS in Blue's, a dark 3D edge under both.
const TITLE = { size: 132, right: 1236, top: 52, depth: 6, tagline: 'SOLO · DUOS · TRIOS · SQUADS' };

/** Runs in the page: sets the shot up and holds it (the clock barely moves). */
function stage(S) {
  const b = window.__bw, w = b.world(), T = b.TEAMS;
  for (const el of document.querySelectorAll('body > *:not(canvas)')) el.style.visibility = 'hidden';
  b.speed = 0.0001;
  for (const e of b.ents) { e.dead = true; e.x = -999; }
  const base = w.bases[S.base], inw = [-base.out[0], -base.out[1]], side = [-inw[1], inw[0]];
  const rel = (a, s, y = 0) => [base.x + inw[0] * a + side[0] * s, w.Y + y, base.z + inw[1] * a + side[1] * s];
  for (const [a0, a1, s0, s1] of S.clear) {
    for (let a = a0; a <= a1; a += 0.5) for (let s = s0; s <= s1; s += 0.5) {
      const [x, , z] = rel(a, s);
      for (let y = w.Y; y < w.Y + 14; y++) if (b.getB(Math.floor(x), y, Math.floor(z))) b.setBlock(Math.floor(x), y, Math.floor(z), b.B.AIR);
    }
  }
  for (const [t, f, to] of S.bridges) {
    const p0 = rel(f[0], f[1]), p1 = rel(to[0], to[1]), n = Math.ceil(Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) * 2);
    for (let i = 0; i <= n; i++) {
      const x = Math.floor(p0[0] + ((p1[0] - p0[0]) * i) / n), z = Math.floor(p0[2] + ((p1[2] - p0[2]) * i) / n);
      if (!b.getB(x, w.Y - 1, z)) b.setBlock(x, w.Y - 1, z, T[t].wool);
    }
  }
  for (const [a, s, y, n, hex, o] of S.fx) {
    const [x, yy, z] = rel(a, s, y);
    b.burst(x, yy, z, n, b.COL.white.clone().set(hex).multiplyScalar(o.mul || 1), { speed: 0, up: 0, life: 99, ...o });
  }
  const cam = rel(...S.cam), look = rel(...S.look), poses = [];
  for (const c of S.cast) {
    const [x, y, z] = rel(c.at[0], c.at[1]);
    const e = b.spawnEnt({ name: c.name, team: c.team, look: b.lookFor(c.name, T[c.team].hex), seed: c.seed, tagColor: T[c.team].hex, x, y, z,
      wear: { ...b.player.wear, outfit: 'default', hat: 'none', title: 'none', plate: 'none', ...c.wear } });
    e.held = c.held; e.sword = 3;
    const tg = c.face === 'cam' ? [cam[0], cam[2]] : (([px, , pz]) => [px, pz])(rel(c.face[0], c.face[1]));
    e.yaw = Math.atan2(tg[0] - x, tg[1] - z) + (c.turn || 0);
    e.pitch = c.pitch || 0;
    b.dressModel(e);
    if (e.model.tag) { e.model.root.remove(e.model.tag); e.model.tag = null; }
    poses.push([e.model, c.pose]);
  }
  // Each frame the game animates its people: put the poses back just before the frame is drawn.
  const render = b.renderer.render.bind(b.renderer);
  b.renderer.render = (scene, camera) => {
    for (const [m, P] of poses) {
      m.armR.rotation.set(...P.armR); m.armL.rotation.set(...P.armL);
      m.legL.rotation.set(P.legs[0], 0, 0); m.legR.rotation.set(P.legs[1], 0, 0);
    }
    return render(scene, camera);
  };
  b.match.tp = [];
  b.camOverride = [...cam, ...look];
  const c3 = b.camera;
  Object.defineProperty(c3, 'fov', { get: () => S.fov, set() {}, configurable: true });
  c3.updateProjectionMatrix();
}

/** Runs in a page of its own: the title as one SVG, in the font the game embeds. */
async function drawTitle(T) {
  const fs = T.size, u = fs / 16;
  await document.fonts.load(`700 ${fs}px "Pixelify Sans"`);
  const g = document.createElement('canvas').getContext('2d');
  g.font = `700 ${fs}px "Pixelify Sans"`;
  const gap = fs * 0.28, w1 = g.measureText('BED').width, w2 = g.measureText('WARS').width, w = w1 + gap + w2, base = 0.82 * fs;
  const x = T.right - w, y = T.top;
  const word = (dx, text, fill, extra = '') => `<text x="${dx.toFixed(1)}" y="${base}" font-family="Pixelify Sans" font-weight="700" font-size="${fs}" fill="${fill}" ${extra}>${text}</text>`;
  const both = (f1, f2, extra) => word(0, 'BED', f1, extra) + word(w1 + gap, 'WARS', f2, extra);
  let edge = '';
  for (let i = T.depth; i >= 1; i--) edge += `<g transform="translate(0 ${(i * u * 0.55).toFixed(2)})">${both(i > T.depth / 2 ? '#3a0a12' : '#6a121d', i > T.depth / 2 ? '#0a1a3e' : '#14306e')}</g>`;
  const tagY = base + T.depth * u * 0.55 + fs * 0.34;
  document.body.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800" style="display:block"><defs>
    <radialGradient id="shade"><stop offset="0" stop-color="#1a0a14" stop-opacity="0.55"/><stop offset="1" stop-color="#1a0a14" stop-opacity="0"/></radialGradient>
    <linearGradient id="red" x1="0" y1="${base - fs * 0.62}" x2="0" y2="${base}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff9aa0"/><stop offset="0.45" stop-color="#ff4b55"/><stop offset="1" stop-color="#d22a36"/></linearGradient>
    <linearGradient id="blue" x1="0" y1="${base - fs * 0.62}" x2="0" y2="${base}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#a8c8ff"/><stop offset="0.45" stop-color="#4b8bff"/><stop offset="1" stop-color="#2a5ad2"/></linearGradient>
    <filter id="lift" x="-10%" y="-60%" width="120%" height="220%"><feGaussianBlur in="SourceAlpha" stdDeviation="${(fs * 0.07).toFixed(1)}" result="b"/><feFlood flood-color="#12060e" flood-opacity="0.75" result="f"/><feComposite in="f" in2="b" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <ellipse cx="${x + w / 2}" cy="${y + fs * 0.62}" rx="${w * 0.7}" ry="${fs * 1.05}" fill="url(#shade)"/>
  <g transform="translate(${x.toFixed(2)} ${y})" filter="url(#lift)">
    <g stroke="#12060e" stroke-width="${(u * 1.4).toFixed(2)}" stroke-linejoin="round"><g transform="translate(0 ${(T.depth * u * 0.55).toFixed(2)})">${both('#12060e', '#12060e')}</g>${both('#12060e', '#12060e')}</g>
    ${edge}${both('url(#red)', 'url(#blue)')}
    <text x="${(w / 2).toFixed(1)}" y="${tagY.toFixed(1)}" text-anchor="middle" font-family="Pixelify Sans" font-weight="600" font-size="${(fs * 0.2).toFixed(1)}" letter-spacing="${(fs * 0.05).toFixed(1)}"
      fill="#fff6ea" stroke="#12060e" stroke-width="${(u * 0.9).toFixed(2)}" paint-order="stroke">${T.tagline}</text>
  </g></svg>`;
}

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await steady(ctx);
const page = await ctx.newPage();
await routeCdn(page);
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(pathToFileURL(GAME).href + '?debug');
await page.waitForFunction(() => window.__bw?.game.mode === 'lobby', null, { timeout: 120_000 });
await page.evaluate((mp) => { document.getElementById('daily').classList.add('hidden'); const b = window.__bw; b.mp = mp; b.playMode('duos'); }, SHOT.mp);
await page.evaluate(() => { window.__bw.match.cd = 0.05; });
await page.waitForFunction(() => window.__bw.match.phase === 'play', null, { timeout: 30_000 });
await page.evaluate(stage, SHOT);
await page.evaluate(() => new Promise((done) => { let n = 0; const f = () => (++n >= 30 ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
const shot = await page.screenshot();
await ctx.close();

const title = await titleShot(browser, GAME, drawTitle, TITLE, W, H);
await browser.close();

// Finishing: a Lanczos downsample, a little more contrast and colour, a soft vignette, light sharpening and a faint
// grain so the smooth sky doesn't band in WebP.
const vignette = svg(W, H, `<defs><radialGradient id="v" cx="50%" cy="54%" r="74%"><stop offset="0.55" stop-color="#1a0a14" stop-opacity="0"/>
  <stop offset="1" stop-color="#1a0a14" stop-opacity="0.4"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#v)"/>`);

const graded = await sharp(shot).resize(W, H, { kernel: 'lanczos3' }).modulate({ saturation: 1.12 }).linear(1.1, -8).png().toBuffer();
const finished = await sharp(graded)
  .composite([{ input: vignette, blend: 'over' }, { input: await grain(W, H), blend: 'soft-light' }])
  .sharpen({ sigma: 0.55, m1: 0.6, m2: 1.2 })
  .png().toBuffer();
const done = sharp(finished).composite([{ input: await sharp(title).resize(W, H, { kernel: 'lanczos3' }).png().toBuffer() }]);
fs.mkdirSync(path.dirname(out), { recursive: true });
await (out.endsWith('.png') ? done.png() : done.webp({ quality: 90, effort: 6, smartSubsample: true })).toFile(out);
console.log(`${path.relative(root, out)}: ${W}×${H}, ${Math.round(fs.statSync(out).size / 1024)} KB`);
