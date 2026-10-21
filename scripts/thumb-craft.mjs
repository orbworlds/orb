#!/usr/bin/env node
// Renders Orbcraft's thumbnail (public/templates/craft.webp, Orb’s picture of it) in the game itself: Haven at golden hour seen from the
// Wilds — its wall, towers and lamps, the beacon going up into the sky — with someone in a cape setting out from its
// gate, a friend waving them off, and a zombie coming out of the trees for them; the game's title in the sky. The shot
// is staged through the game's debug hooks (craft.html?debug exposes window.__oc) in a June season (Haven dresses for
// the month it's in, and October's would carve pumpkins on every post), drawn at twice the size in Chromium and
// finished with sharp. Run it again after changing how the Wilds, Haven, the people or their looks are drawn:
//
//   node scripts/thumb-craft.mjs [--out <file.webp|png>] [--preview: the raw shot to /tmp/thumb-craft.png] [--fast: at 1×] [--game <a checkout of orbworlds/orbcraft>/index.html]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { launch, routeCdn } from '../kit/lib/browser.mjs';
import { originalFile } from './original.mjs';
import { grain, steady, svg, titleShot } from './thumb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out'), preview = args.includes('--preview'), fast = args.includes('--fast');
const out = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(root, 'public/templates/craft.webp');
// the game: --game <its index.html>, or the Original as Orb serves it (its repository's)
const GAME = await originalFile('orb-craft');
const W = 1280, H = 800;

// The shot, from Haven's middle: `x` east (on the right, looking north), `z` south, `y` up from Haven's ground. The
// camera stands in Haven's plaza (May is cherry blossom time there) in the Wilds' late afternoon sun, looking north
// past the keepers and the two portals to the gate, open on the Wilds: someone in a cape sets out, sword drawn, a
// friend waves, another heads for Ten Nights' portal, and a zombie waits outside the gate (they can't come in).
const SHOT = {
  date: Date.UTC(2027, 4, 12, 12), t: 560, fov: 52,
  cam: [3.2, 3.5, 10.6], look: [0.4, 3.1, -20],
  // [x, z, kind, faces [x, z]]: monsters out in the Wilds
  mobs: [[0.1, -24, 'zombie', [3.2, 10.6]]],
  // who's in it, where ([x, z]), facing the camera (turned by `turn`) or a point, their pose (radians), and the height
  // to look for the ground from (under the gate's arch)
  cast: [
    { name: 'Wren', at: [3.9, 3.1], face: 'cam', turn: -0.85, held: 's3', seed: 7, look: { skin: '#f2c9a1', hair: '#c9873a', shirt: '#3a8ad8', pants: '#2e3a5c', eyes: '#3f8a3a', long: true },
      wear: { cape: 'cape-phoenix' }, pose: { armR: [-1.25, 0, 0.25], armL: [0.45, 0, -0.15], legs: [0.5, -0.5] } },
    { name: 'Pip', at: [-2.4, -5.6], face: [3.9, 3.1], held: '', seed: 21, look: { skin: '#a8714a', hair: '#2a2328', shirt: '#7be04f', pants: '#3a2e22', eyes: '#2a2a2a' },
      wear: { hat: 'hat-cowboy' }, pose: { armR: [-2.8, 0, 0.45], armL: [0.1, 0, -0.1], legs: [0.1, -0.1] } },
    { name: 'Juno', at: [5.2, -13.2], face: [6.5, -17], held: 's2', seed: 33, look: { skin: '#c68c5f', hair: '#1a1418', shirt: '#c07aff', pants: '#2a2a32', eyes: '#2a2a2a' },
      wear: { outfit: 'fit-ninja' }, pose: { armR: [0.5, 0, 0.1], armL: [-0.5, 0, -0.1], legs: [-0.6, 0.6] } },
  ],
  // the boards in the Hall of Fame, and the statues of the season's best on its podium
  boards: ['Mira', 'Kofi', 'Juniper', 'Rafa', 'Lin', 'Odessa', 'Tomasz', 'Ines', 'Beck', 'Sol'],
};

// The title, top right (clear of where link previews put Orb's mark and the world's name), in the game's font: Orb in
// white, craft in grass green, on a block edge of grass and earth like the game's own logo (in capitals the font's C
// all but closes, and reads as an O at a card's size).
const TITLE = { size: 128, right: 1236, top: 48, depth: 0, step: 0.18, words: ['Orb', 'craft'], tagline: 'ONE WORLD FOR EVERYONE' };

/** Runs in the page: a fixed June day, so Haven wears summer (before the game's script reads the date); `stage`
 *  stops it, since the Wilds' sky follows the time of day and drawing the shot takes a while. */
function fixDate(at) {
  const Real = Date, t0 = performance.now();
  const now = () => window.__frozenAt ?? at + (performance.now() - t0);
  class Fixed extends Real { constructor(...a) { super(...(a.length ? a : [now()])); } static now() { return now(); } }
  window.Date = Fixed;
}
/** Runs in the page: a stand-in for Orb's runtime (the Wilds on your own, its boards filled in). */
function fakeOrb(names) {
  const DAY = 86400000, now = Date.now(), season = new Date(now).toISOString().slice(0, 7), day = new Date(now).toISOString().slice(0, 10);
  const week = Math.floor((now - 4 * DAY) / (7 * DAY)), fits = ['fit-knight', 'fit-ninja', 'fit-astro'], hats = ['hat-crown', 'hat-horns', 'hat-wizard'], capes = ['cape-gilded', 'cape-nebula', 'none'];
  const sb = {}, lbw = {}, lbd = {};
  names.forEach((n, i) => {
    sb['u' + i] = [n, 12400 - i * 830, 14 - i, 60 - i * 3, i % 3, season, fits[i % 3], hats[i % 3], capes[i % 3]];
    lbw['u' + i] = [n, 3900 - i * 260, 3, 9, week];
    lbd['u' + i] = [n, 720 - i * 47, 1, 3, day];
  });
  const m = new Map(Object.entries({ 'oc:sb': sb, 'oc:lbw': lbw, 'oc:lbd': lbd }));
  window.orb = {
    me: { id: 'thumb', name: 'Wren', color: '#5ed1ff' }, world: { id: 'thumb', name: 'Orbcraft' },
    room: { invited: null, invite: async () => '', join(cb) { setTimeout(() => cb({ type: 'joined', self: { id: 'thumb:x' }, peers: [], live: true }), 30); return { send() {}, setState() {}, leave() {} }; } },
    store: { get: async (k) => m.get(k) ?? null, set: async (k, v) => (m.set(k, v), v), incr: async () => 1, push: async () => [], merge: async (k, p) => { const v = { ...(m.get(k) || {}), ...p }; m.set(k, v); return v; }, list: async () => ({}) },
    shop: { owned: async () => [], buy: async () => ({ ok: false }) }, capture() {}, toast() {},
  };
}

/** Runs in the page: sets the shot up and holds it (the clock barely moves). */
async function stage(S) {
  const o = window.__oc, w = o.world(), h = w.haven;
  for (const el of document.querySelectorAll('body > *:not(canvas)')) el.style.visibility = 'hidden';
  o.speed = 0.0001;
  const at = (x, y, z) => [h.x + x, h.y + y, h.z + z];
  const ground = (x, z, from = 60) => { let y = from; while (y > 1 && !o.getB(Math.floor(x), y - 1, Math.floor(z))) y--; return y; };
  // the time of day, and the sun (its shadows sharpest round the gate)
  window.__frozenAt = Date.now();
  const c = o.wildClock(); o.clockShift = (o.clockShift || 0) - c.t + S.t;
  for (const e of [...o.ents]) if (e.mob) o.removeEnt(e);
  const p = o.player, [fx, , fz] = at(0, 0, -26);
  Object.assign(p, { x: fx, z: fz, y: ground(fx, fz), ry: ground(fx, fz), dead: true });
  o.wildSun(o.wildClock()); o.placeSun();
  await o.refreshBoards();
  // the labels over the keepers and the statues are for players, not for a picture
  o.scene.traverse((ob) => { if (ob.isSprite && ob.userData?.c) ob.visible = false; });
  const cam = at(...S.cam), look = at(...S.look), poses = [];
  for (const cst of S.cast) {
    const [x, , z] = at(cst.at[0], 0, cst.at[1]), y = ground(x, z, cst.from == null ? 60 : h.y + cst.from);
    const e = o.spawnEnt({ name: cst.name, team: 3, look: cst.look, seed: cst.seed, x, y, z, wear: { ...p.wear, outfit: 'default', hat: 'none', cape: 'none', trail: 'none', title: 'none', plate: 'none', ...cst.wear } });
    e.puppet = true; e.held = cst.held; e.armor = cst.armor | 0;
    const tg = cst.face === 'cam' ? [cam[0], cam[2]] : at(cst.face[0], 0, cst.face[1]).filter((_, i) => i !== 1);
    e.yaw = Math.atan2(tg[0] - x, tg[1] - z) + (cst.turn || 0);
    o.dressModel(e);
    if (e.model.tag) { e.model.root.remove(e.model.tag); e.model.tag = null; }
    poses.push([e.model, cst.pose]);
  }
  for (const [mx, mz, kind, faces] of S.mobs) {
    const [x, , z] = at(mx, 0, mz), e = o.spawnMob(kind, x, ground(x, z), z), [tx, , tz] = at(faces[0], 0, faces[1]);
    e.yaw = Math.atan2(tx - x, tz - z);
    if (e.model.tag) e.model.tag.visible = false;
    poses.push([e.model, { armR: [-1.45, 0, 0.05], armL: [-1.5, 0, -0.05], legs: [0.35, -0.35] }]);
  }
  // Each frame the game animates its people: put the poses back just before the frame is drawn.
  const render = o.renderer.render.bind(o.renderer);
  o.renderer.render = (scene, camera) => {
    if (scene === o.scene) for (const [m, P] of poses) {
      if (!m.armR) continue;
      m.armR.rotation.set(...P.armR); m.armL.rotation.set(...P.armL);
      m.legL.rotation.set(P.legs[0], 0, 0); m.legR.rotation.set(P.legs[1], 0, 0);
      if (m.tag) m.tag.visible = false;
    }
    return render(scene, camera);
  };
  o.camOverride = [...cam, ...look];
  Object.defineProperty(o.camera, 'fov', { get: () => S.fov, set() {}, configurable: true });
  o.camera.updateProjectionMatrix();
}

/** Runs in a page of its own: the title as one SVG, in the font the game embeds. */
async function drawTitle(T) {
  const fs = T.size, u = fs / 16;
  await document.fonts.load(`700 ${fs}px "Pixelify Sans"`);
  const g = document.createElement('canvas').getContext('2d');
  g.font = `700 ${fs}px "Pixelify Sans"`;
  const [t1, t2] = T.words, w1 = g.measureText(t1).width, w2 = g.measureText(t2).width, w = w1 + w2, base = 0.82 * fs;
  const x = T.right - w, y = T.top;
  const word = (dx, text, fill, extra = '') => `<text x="${dx.toFixed(1)}" y="${base}" font-family="Pixelify Sans" font-weight="700" font-size="${fs}" fill="${fill}" ${extra}>${text}</text>`;
  const both = (f1, f2, extra) => word(0, t1, f1, extra) + word(w1, t2, f2, extra);
  let edge = '';
  for (let i = T.depth; i >= 1; i--) edge += `<g transform="translate(0 ${(i * u * T.step).toFixed(2)})">${both(i > T.depth / 2 ? '#4a2e18' : '#3d7a26', i > T.depth / 2 ? '#4a2e18' : '#3d7a26')}</g>`;
  const tagY = base + T.depth * u * T.step + fs * 0.34;
  document.body.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800" style="display:block"><defs>
    <radialGradient id="shade"><stop offset="0" stop-color="#1a1408" stop-opacity="0.5"/><stop offset="1" stop-color="#1a1408" stop-opacity="0"/></radialGradient>
    <linearGradient id="white" x1="0" y1="${base - fs * 0.62}" x2="0" y2="${base}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e4ecf2"/></linearGradient>
    <linearGradient id="green" x1="0" y1="${base - fs * 0.62}" x2="0" y2="${base}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#d4ff9a"/><stop offset="0.5" stop-color="#a8f06e"/><stop offset="1" stop-color="#6cc83a"/></linearGradient>
    <filter id="lift" x="-10%" y="-60%" width="120%" height="220%"><feGaussianBlur in="SourceAlpha" stdDeviation="${(fs * 0.07).toFixed(1)}" result="b"/><feFlood flood-color="#120c04" flood-opacity="0.7" result="f"/><feComposite in="f" in2="b" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <ellipse cx="${x + w / 2}" cy="${y + fs * 0.62}" rx="${w * 0.7}" ry="${fs * 1.05}" fill="url(#shade)"/>
  <g transform="translate(${x.toFixed(2)} ${y})" filter="url(#lift)">
    <g stroke="#120c04" stroke-width="${(u * 0.3).toFixed(2)}" stroke-linejoin="round"><g transform="translate(0 ${(T.depth * u * T.step).toFixed(2)})">${both('#120c04', '#120c04')}</g>${both('#120c04', '#120c04')}</g>
    ${edge}${both('url(#white)', 'url(#green)')}
    <text x="${(w / 2).toFixed(1)}" y="${tagY.toFixed(1)}" text-anchor="middle" font-family="Pixelify Sans" font-weight="600" font-size="${(fs * 0.2).toFixed(1)}" letter-spacing="${(fs * 0.05).toFixed(1)}"
      fill="#fff6ea" stroke="#120c04" stroke-width="${(u * 0.9).toFixed(2)}" paint-order="stroke">${T.tagline}</text>
  </g></svg>`;
}

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: fast ? 1 : 2 });
await steady(ctx);
await ctx.addInitScript(fixDate, SHOT.date);
await ctx.addInitScript(fakeOrb, SHOT.boards);
const page = await ctx.newPage();
await routeCdn(page);
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(pathToFileURL(GAME).href + '?debug&nodaily');
await page.waitForFunction(() => window.__oc?.game.mode === 'wild' && window.__oc.player && document.getElementById('loading').classList.contains('out'), null, { timeout: 120_000 });
await page.evaluate(stage, SHOT);
await page.evaluate(() => new Promise((done) => { let n = 0; const f = () => (++n >= 90 ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
const shot = await page.screenshot();
// where the camera is and where each of the cast lands on the picture (for adjusting the shot)
const where = preview ? await page.evaluate(() => {
  const o = window.__oc, c = o.camera, h = o.world().haven, r = (v) => Math.round(v * 10) / 10;
  return JSON.stringify({ cam: [c.position.x - h.x, c.position.y - h.y, c.position.z - h.z].map(r), cast: o.ents.filter((e) => e.puppet && !e.keeper && !e.statue || e.mob).map((e) => {
    const p = e.model.root.position.clone(); p.y += 1; p.project(c); return [e.name, r((p.x + 1) * 640), r((1 - p.y) * 400), r(e.y - h.y)];
  }) });
}) : '';
await ctx.close();
if (preview) { fs.writeFileSync('/tmp/thumb-craft.png', shot); await browser.close(); console.log('/tmp/thumb-craft.png', where); process.exit(0); }

const title = await titleShot(browser, GAME, drawTitle, TITLE, W, H);
await browser.close();

// Finishing: a Lanczos downsample, a little more contrast and colour, a soft vignette, light sharpening and a faint
// grain so the smooth sky doesn't band in WebP.
const vignette = svg(W, H, `<defs><radialGradient id="v" cx="50%" cy="54%" r="74%"><stop offset="0.55" stop-color="#1a1408" stop-opacity="0"/>
  <stop offset="1" stop-color="#1a1408" stop-opacity="0.38"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#v)"/>`);

const graded = await sharp(shot).resize(W, H, { kernel: 'lanczos3' }).modulate({ saturation: 1.1 }).linear(1.08, -6).png().toBuffer();
const finished = await sharp(graded)
  .composite([{ input: vignette, blend: 'over' }, { input: await grain(W, H), blend: 'soft-light' }])
  .sharpen({ sigma: 0.55, m1: 0.6, m2: 1.2 })
  .png().toBuffer();
const done = sharp(finished).composite([{ input: await sharp(title).resize(W, H, { kernel: 'lanczos3' }).png().toBuffer() }]);
fs.mkdirSync(path.dirname(out), { recursive: true });
await (out.endsWith('.png') ? done.png() : done.webp({ quality: 84, effort: 6, smartSubsample: true })).toFile(out);
console.log(`${path.relative(root, out)}: ${W}×${H}, ${Math.round(fs.statSync(out).size / 1024)} KB`);
