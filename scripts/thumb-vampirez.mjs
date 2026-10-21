#!/usr/bin/env node
// Renders VampireZ's thumbnail (public/templates/vampirez.webp, Orb’s picture of it) in the game itself: the Count lunging off a
// rooftop in Hollowmere, the castle behind him under a blood moon with bats crossing it, and the game's title in the
// sky. The shot is staged through the game's debug hooks (vampirez.html?debug exposes window.__vz), drawn at twice the
// size in Chromium and finished with sharp. Run it again after changing how Hollowmere, the vampires or the logo look:
//
//   node scripts/thumb-vampirez.mjs [--out <file.webp|png>] [--game <a checkout of orbworlds/vampirez>/index.html]
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
const out = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(root, 'public/templates/vampirez.webp');
// the game: --game <its index.html>, or the Original as Orb serves it (its repository's)
const GAME = await originalFile('orb-vampirez');
const W = 1280, H = 800;

// The shot, in Hollowmere's blocks: the camera hangs over the street in front of the slate-roofed house by the river,
// and the Count stands on its ridge. The moon is moved up behind the castle's keep.
const SHOT = {
  cam: [63.3, 17.7, 62.4], look: [62.1, 21.4, 72.0], fov: 48,
  moon: [0.1, 0.52, 0.85], moonScale: 2.8, moonColor: ['#ff4a3a', 2.4], blood: 0.55, fog: ['#2e1c52', 0.022],
  count: { x: 61.5, y: 18, z: 66.9, yaw: 3.05, eyes: 1.5,
    pose: { lean: 0.36, armL: -1.65, armR: -1.15, armY: 0.55, legs: [-0.55, 0.42], neck: 0.22, turn: 0.18, cape: [0.75, 0, -0.95] } },
  // [x, y, z, target x, y, z, intensity, distance, angle, penumbra, colour]: his face, and the cape's lining from below
  key: [63.6, 19.6, 63.2, 61.4, 19.3, 66.9, 10, 9, 0.32, 0.7, '#e0d6ff'],
  under: [62.9, 18.2, 64.4, 62.4, 19.5, 67.4, 6, 6, 0.45, 0.8, '#ff6a5a'],
  rim: [63.4, 21.2, 68.2, 18, 5, '#ff6a3a'],
  // bats placed on screen, across the moon and clear of the title: [x, y (0–1), distance, turn from facing us, wing
  // flap, size, roll]
  flock: [[0.26, 0.395, 30, 0.3, 0.5, 1.6, 0.2], [0.305, 0.33, 32, -0.2, -0.4, 1.5, -0.1], [0.327, 0.25, 28, 0.5, 0.7, 1.7, 0.15],
    [0.375, 0.3, 34, -0.4, 0.2, 1.4, 0], [0.395, 0.19, 30, 0.2, -0.6, 1.6, -0.2], [0.437, 0.24, 33, -0.6, 0.5, 1.3, 0.1],
    [0.275, 0.2, 36, 0.1, 0.3, 1.3, 0], [0.225, 0.3, 38, 0.2, -0.5, 1.2, 0], [0.16, 0.15, 40, 0.3, 0.6, 1.25, 0.1],
    [0.1, 0.24, 42, -0.2, -0.3, 1.1, -0.1], [0.205, 0.105, 44, 0.4, 0.4, 1.1, 0.2], [0.49, 0.36, 31, -0.3, 0.6, 1.35, -0.15],
    [0.88, 0.385, 29, -0.4, 0.6, 1.5, 0.15], [0.945, 0.335, 33, 0.2, -0.4, 1.3, -0.1], [0.91, 0.46, 31, 0.3, 0.3, 1.2, 0.05]],
  motes: { at: [61.0, 20.0, 68.5], spread: [7, 5, 5], n: 46 },     // blood-red sparks drifting round him
};

// The title, top right (clear of where link previews put Orb's mark and the world's name): the game's logo in its own
// font and colours, with a hand-drawn Z (the font's Z is drawn like a 2). Sizes are in px of the 1280×800 frame;
// drips are [x in font pixels from the word's left (or the Z's), length].
const TITLE = { size: 124, right: 1228, top: 70, depth: 5, glow: 0.75, shade: 0.85, tagline: 'SURVIVE UNTIL DAWN',
  drips: [[2.2, 3.2], [27.5, 2.2], [3, 5, true]] };

/** Runs in the page: sets the shot up and keeps it in place every frame. Returns where the moon is on screen. */
function stage(S) {
  const vz = window.__vz, cam = vz.camera, V3 = cam.position.constructor, M4 = cam.matrix.constructor;
  const Q = cam.quaternion.constructor, E = cam.rotation.constructor;
  for (const el of document.querySelectorAll('body > *:not(canvas)')) el.style.visibility = 'hidden';
  Object.defineProperty(cam, 'fov', { get: () => S.fov, set() {}, configurable: true });   // the title camera resets it
  vz.camOverride = [...S.cam, ...S.look];
  vz.MAPS.hollowmere.moon = S.moon;
  vz.loadMap('hollowmere');
  vz.setSky(S.blood, 0, 0);
  const moon = vz.scene.children.find((o) => o.isMesh && o.renderOrder === -9);
  moon.scale.setScalar(S.moonScale);
  // chimney smoke reads as dark smudges on the sky
  for (const o of vz.scene.children) if (o.isPoints && o.material.blending === 1 && o.geometry.attributes.aCol) o.visible = false;

  const c = S.count;
  const count = vz.spawn({ team: 'V', name: 'Count', x: c.x, y: c.y, z: c.z, yaw: c.yaw, look: { shirt: '#c3123a', hair: '#141018' }, cos: { vskin: 'classic', cape: 'crimson' } });
  const m = count.model;
  m.root.remove(m.tag); m.tag = null;

  const spot = vz.scene.children.find((o) => o.isSpotLight), Point = vz.scene.children.find((o) => o.isPointLight).constructor;
  const under = new spot.constructor(), rim = new Point();
  vz.scene.add(under, under.target, rim);
  const aim = (l, [x, y, z, tx, ty, tz, i, d, a, pen, col]) => {
    l.position.set(x, y, z); l.target.position.set(tx, ty, tz); l.target.updateMatrixWorld();
    Object.assign(l, { intensity: i, distance: d, angle: a, penumbra: pen, decay: 1 }); l.color.set(col);
  };
  aim(under, S.under);
  rim.position.set(S.rim[0], S.rim[1], S.rim[2]); Object.assign(rim, { intensity: S.rim[3], distance: S.rim[4], decay: 1.2 }); rim.color.set(S.rim[5]);

  const bats = vz.scene.children.filter((o) => o.isInstancedMesh && !o.frustumCulled && o.instanceMatrix.count === 64);   // body, left wing, right wing
  const bm = new M4(), fm = new M4(), q = new Q(), e = new E(), p = new V3(), s = new V3();
  const place = () => { cam.position.set(...S.cam); cam.lookAt(...S.look); cam.updateMatrixWorld(); };
  const drawFlock = () => {
    place();
    S.flock.forEach(([sx, sy, d, turn, flap, size, roll], i) => {
      p.set(sx * 2 - 1, 1 - sy * 2, 0.5).unproject(cam).sub(cam.position).normalize().multiplyScalar(d).add(cam.position);
      e.set(0, Math.atan2(cam.position.x - p.x, cam.position.z - p.z) + turn, roll, 'YXZ'); q.setFromEuler(e); s.setScalar(size);
      bm.compose(p, q, s); bats[0].setMatrixAt(i, bm);
      bats[1].setMatrixAt(i, bm.clone().multiply(fm.makeRotationZ(flap))); bats[2].setMatrixAt(i, bm.clone().multiply(fm.makeRotationZ(-flap)));
    });
    for (const b of bats) { b.count = S.flock.length; b.instanceMatrix.needsUpdate = true; }
  };

  let seed = 7;
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < S.motes.n; i++) {
    const [x, y, z] = S.motes.at.map((v, k) => v + (r() - 0.5) * S.motes.spread[k]);
    vz.glow.spawn(x, y, z, (r() - 0.5) * 0.2, 0.15 + r() * 0.3, (r() - 0.5) * 0.2, 60, 0.05 + r() * 0.07, r() < 0.6 ? vz.COL.blood : vz.COL.ember, { grav: 0, drag: 0, alpha: 0.5 + r() * 0.5 });
  }

  // Each frame the game animates its characters, lights and bats: put the shot back just before it's drawn.
  const P = c.pose, render = vz.renderer.render.bind(vz.renderer);
  vz.renderer.render = (scene, camera) => {
    if (scene === vz.scene) {
      m.hips.rotation.set(P.lean, 0, 0);
      m.armL.rotation.set(P.armL, P.armY, -0.06); m.armR.rotation.set(P.armR, -P.armY, 0.06);
      m.legL.rotation.set(P.legs[0], 0, 0); m.legR.rotation.set(P.legs[1], 0, 0);
      m.neck.rotation.set(P.neck, P.turn, 0);
      m.capePivot.rotation.set(...P.cape);
      m.mat.emissiveIntensity = c.eyes;
      aim(spot, S.key);
      drawFlock();
      vz.scene.fog.color.set(S.fog[0]); vz.scene.fog.density = S.fog[1];
      moon.material.color.set(S.moonColor[0]).multiplyScalar(S.moonColor[1]);
    }
    return render(scene, camera);
  };
  place();
  const mp = new V3(...S.moon).multiplyScalar(250).add(cam.position).project(cam);
  return [mp.x * 0.5 + 0.5, 0.5 - mp.y * 0.5];
}

/**
 * Runs in a page of its own: the title as one SVG on the font's pixel grid (u = 1/16 em: caps are 10u tall, strokes
 * 2u, the baseline at 0.819 em), so the letters, the Z, the 3D edge and the drips line up.
 */
async function drawTitle(T) {
  const fs = T.size, u = fs / 16, cap = 10 * u, base = 0.819 * fs, word = 'Vampire', track = fs * 0.02;
  await document.fonts.load(`700 ${fs}px "Pixelify Sans"`);
  const g = document.createElement('canvas').getContext('2d');
  g.font = `700 ${fs}px "Pixelify Sans"`;
  const zx = g.measureText(word).width + track * (word.length - 1) + u * 1.2;
  const zRows = ['XXXXXXXX', 'XXXXXXXX', '.....XXX', '....XXX.', '...XXX..', '..XXX...', '.XXX....', 'XXX.....', 'XXXXXXXX', 'XXXXXXXX'];
  const rect = (x, y, w, h) => `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(w + 0.5).toFixed(2)}" height="${(h + 0.5).toFixed(2)}"/>`;
  let z = '', drips = '';
  zRows.forEach((r, y) => [...r].forEach((c, x) => { if (c === 'X') z += rect(zx + x * u, base - cap + y * u, u, u); }));
  for (const [x0, len, onZ] of T.drips) {      // a run, the drop swelling at its end, and a last bead below
    const x = (onZ ? zx : 0) + x0 * u, y = base - 0.2 * u;
    drips += rect(x, y, u * 1.4, len * u) + rect(x - 0.3 * u, y + (len - 0.4) * u, u * 2, u * 1.6) + rect(x + 0.1 * u, y + (len + 1.1) * u, u * 1.2, u * 0.8);
  }
  const text = `<text x="0" y="${base}" font-family="Pixelify Sans" font-weight="700" font-size="${fs}" letter-spacing="${track}">${word}</text>`;
  const at = (dy, fill, body) => `<g transform="translate(0 ${dy.toFixed(2)})" fill="${fill}">${body}</g>`;
  let edge = '';      // the logo's 3D edge: dark crimson, darker further down
  for (let i = T.depth; i >= 1; i--) edge += at(i * u * 0.5, i > T.depth / 2 ? '#1c0710' : '#3a0d1c', text) + at(i * u * 0.5, i > T.depth / 2 ? '#2a0410' : '#6d0a1f', z + drips);
  const w = zx + 9 * u, h = base + T.depth * u * 0.5 + (T.tagline ? fs * 0.42 : 0) + 6 * u, x = T.right - w, y = T.top;
  const tag = T.tagline ? `<text x="${(w - u) / 2}" y="${base + T.depth * u * 0.5 + fs * 0.36}" text-anchor="middle" font-family="Pixelify Sans" font-weight="500"
    font-size="${(fs * 0.19).toFixed(1)}" letter-spacing="${(fs * 0.075).toFixed(1)}" fill="#f4e8ff" stroke="#14061c" stroke-width="${(u * 0.9).toFixed(2)}" paint-order="stroke" filter="url(#lift)">${T.tagline}</text>` : '';
  document.body.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800" style="display:block"><defs>
    <radialGradient id="shade"><stop offset="0" stop-color="#0a0316" stop-opacity="0.7"/><stop offset="1" stop-color="#0a0316" stop-opacity="0"/></radialGradient>
    <linearGradient id="wg" x1="0" y1="${base - cap}" x2="0" y2="${base}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffffff"/><stop offset="0.5" stop-color="#f3e9ff"/><stop offset="1" stop-color="#d6c2f2"/></linearGradient>
    <linearGradient id="zg" x1="0" y1="${base - cap}" x2="0" y2="${base + 6 * u}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff7186"/><stop offset="0.45" stop-color="#ff3157"/><stop offset="1" stop-color="#b30d2b"/></linearGradient>
    <filter id="glow" x="-40%" y="-60%" width="180%" height="220%"><feGaussianBlur in="SourceAlpha" stdDeviation="${(fs * 0.13).toFixed(1)}" result="b"/><feFlood flood-color="#ff1e46" flood-opacity="${T.glow}" result="f"/><feComposite in="f" in2="b" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="lift" x="-10%" y="-80%" width="120%" height="260%"><feGaussianBlur in="SourceAlpha" stdDeviation="${(fs * 0.06).toFixed(1)}" result="b"/><feFlood flood-color="#0a0216" flood-opacity="0.85" result="f"/><feComposite in="f" in2="b" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <ellipse cx="${x + w / 2}" cy="${y + h * 0.48}" rx="${w * 0.72}" ry="${h * 0.9}" fill="url(#shade)" opacity="${T.shade}"/>
  <g transform="translate(${x.toFixed(2)} ${y})">
    <g fill="#14061c" stroke="#14061c" stroke-width="${(u * 1.3).toFixed(2)}" stroke-linejoin="round">${at(T.depth * u * 0.5, '#14061c', text + z + drips)}${text}${z}${drips}</g>
    ${edge}<g fill="url(#wg)">${text}</g><g filter="url(#glow)" fill="url(#zg)">${z}${drips}</g>${tag}
  </g></svg>`;
}

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await steady(ctx);
const page = await ctx.newPage();
await routeCdn(page);
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(pathToFileURL(GAME).href + '?debug');
await page.waitForFunction(() => window.__vz?.game.state === 'title', null, { timeout: 120_000 });
const [mx, my] = await page.evaluate(stage, SHOT);
await page.evaluate(() => new Promise((done) => { let n = 0; const f = () => (++n >= 8 ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
const shot = await page.screenshot();
await ctx.close();

const title = await titleShot(browser, GAME, drawTitle, TITLE, W, H);
await browser.close();

// Finishing: a Lanczos downsample, a little more contrast and colour, the top of the sky deepened toward indigo (not
// around the moon), a soft vignette, light sharpening and a faint grain so the smooth sky doesn't band in WebP.
const sky = svg(W, H, `<defs>
  <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22145a"/><stop offset="0.55" stop-color="#22145a" stop-opacity="0"/></linearGradient>
  <radialGradient id="h" gradientUnits="userSpaceOnUse" cx="${mx * W}" cy="${my * H}" r="${0.36 * H}"><stop offset="0.35" stop-color="#000"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
  <mask id="k"><rect width="${W}" height="${H}" fill="#fff"/><rect width="${W}" height="${H}" fill="url(#h)"/></mask>
</defs><rect width="${W}" height="${H}" fill="url(#g)" mask="url(#k)" opacity="0.45"/>`);
const vignette = svg(W, H, `<defs><radialGradient id="v" cx="54%" cy="46%" r="72%"><stop offset="0.55" stop-color="#0c0418" stop-opacity="0"/>
  <stop offset="1" stop-color="#0c0418" stop-opacity="0.42"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#v)"/>`);

const graded = await sharp(shot).resize(W, H, { kernel: 'lanczos3' }).modulate({ saturation: 1.08 }).linear(1.08, -6).png().toBuffer();
const finished = await sharp(graded)
  .composite([{ input: sky, blend: 'multiply' }, { input: vignette, blend: 'over' }, { input: await grain(W, H), blend: 'soft-light' }])
  .sharpen({ sigma: 0.55, m1: 0.6, m2: 1.2 })
  .png().toBuffer();
const done = sharp(finished).composite([{ input: await sharp(title).resize(W, H, { kernel: 'lanczos3' }).png().toBuffer() }]);
fs.mkdirSync(path.dirname(out), { recursive: true });
await (out.endsWith('.png') ? done.png() : done.webp({ quality: 90, effort: 6, smartSubsample: true })).toFile(out);
console.log(`${path.relative(root, out)}: ${W}×${H}, ${Math.round(fs.statSync(out).size / 1024)} KB`);
