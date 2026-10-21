#!/usr/bin/env node
// Records the looping video previews Explore and the start screen play on world cards
// (public/previews/<id>.webm and .mp4, listed with a hash of each in src/data/previews.json). Each world is played in Chromium
// with its clock taken over: time stands still between frames, so a frame is drawn, captured and
// only then does the world move on by 1/30 s. The video is as smooth as on a fast GPU however slow
// software WebGL is here. Embedded worlds are recorded from their site, Orb's own from Orb's files in
// the kit's host (the frame and runtime they get on Orb). The end crossfades into the start so it loops.
//
//   node scripts/previews.mjs [id …]          the worlds in SHOTS below (default: all of them)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from '../kit/lib/browser.mjs';
import { serve, TREE } from '../kit/lib/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = process.env.ORB_SITE || 'https://orbworlds.com';
const W = 640, H = 400, FPS = 30, SECONDS = 4, FADE = 0.6;
// The page is drawn at SCALE device pixels per CSS pixel, so the video is (W × H) · SCALE: cards are
// shown up to 1.7× their CSS size on high-density screens, and the lead tile larger still.
const SCALE = 2;
// the world runs at 60 frames a second (some lower their resolution when slower); every other one is kept (a heavy world's
// shot can say `sub: 1`: 30, all kept)
const SUB = 2;
// QUICK=1: every sixth frame of the first two seconds, to check a shot before recording it
const QUICK = !!process.env.QUICK;

// How each preview is shot: `wait` ms of real time for the world to load, then `steps` (real time,
// before the clock is taken over), then `hold` keys held down while recording. `drag` turns the
// camera slowly with the mouse during the recording ([dx, dy] px per second from the middle, or a path: t s → [x, y] px), with
// `button` held; `swing(dx, dy, x, y)` is the path out by [dx, dy] and back over the clip, easing in and out (a camera that
// trails the mouse comes back to rest where it started), so the clip's end meets its start. `scroll` scrolls (px
// per second), `press` holds keys for stretches of it ([key, from s, to s]). `settle` runs the world that many seconds on the recorder's clock
// before the first frame kept (default 0.5; for worlds whose intro plays out in game time). A step's `wheel` scrolls once at the middle (to zoom
// in before recording), and its `look` moves the mouse [dx, dy] px from the middle (to turn a pointer-locked camera). `lead`
// ({ seconds, hold: [keys] }) walks that long on the recorder's clock with those keys down before the shot settles, for a world too
// slow to walk anywhere in real time. `screenshot` captures the page rather than its canvas (a transparent canvas over a CSS backdrop), and
// `patch` ([find, replace] in the world's code) lets `setup` reach a world's own state. `company` opens that many more players
// (Orb's own worlds). `init` runs in the page before its own scripts (to look on as a world loads). `scale` draws the page at that many device pixels per CSS pixel
// (default SCALE) and `size` is the video's [width, height] (default the page's at that scale); `viewport` is the page's [width, height] in CSS
// pixels (default W × H; some sites take a small window for a turned phone); `crf` is [VP9, H.264] quality
// (higher is smaller). `crop` keeps only [x, y, width, height] (CSS px) of the picture, for a world that draws its own
// buttons and credits into its canvas. `mouse(t)` gives [x, y, down] for each frame of the recording (t in seconds): a
// path the pointer follows, pressing to build or paint as it goes. Orb's single-file games are opened as a file with `file` as the query (their debug hooks): `ready` waits for the
// game, `setup` (after the steps) stages it and may define `window.__shot(t)`, called before each frame with the
// recording's time in seconds (to fly the camera). `query` is added to an embedded world's address (its own switches: an
// autopilot, a stage). `blank` clears the picture before each frame, for a world that counts on the browser to (it draws
// over the last one, leaving ghosts here, where frames are kept until captured).
const swing = (dx, dy, x = W / 2, y = H / 2) => (t) => { const e = (1 - Math.cos((2 * Math.PI * t) / SECONDS)) / 2; return [x + dx * e, y + dy * e]; };
// The pointer hopping from point to point of `p` (0.7 s each), pressing for a moment at each.
const hop = (p) => (t) => { const m = p.length - 1, k = Math.floor(t / 0.7), f = Math.min(1, ((t % 0.7) / 0.7) * 1.6), [a, b] = [p[k % m], p[(k % m) + 1]]; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, t % 0.7 > 0.5 && t % 0.7 < 0.6]; };
const SHOTS = {
  // Monolith Wilds: a slow glide in over the basin of monuments toward the red peaks (its `cam` view leaves its controls out)
  'aw-monolith-wilds': {
    query: 'cam=-998,330,1248&look=-398,250,452', ready: () => !!window.__MW?.ready, readyTimeout: 600000, wait: 30000,
    setup: () => {
      const mw = window.__MW;
      if (!mw?.ctx) return;
      const cam = mw.ctx.camera, p0 = cam.position.clone(), d = new mw.THREE.Vector3(0.6, -0.06, -0.8).normalize();
      const side = new mw.THREE.Vector3(0.8, 0, 0.6);
      window.__shot = (t) => {
        cam.position.copy(p0).addScaledVector(d, 45 * t);
        cam.lookAt(p0.clone().addScaledVector(d, 1200).addScaledVector(side, 12 * t));
      };
    },
  },
  // Merge Conflict: its own capture mode, a bot-against-bot bout drawn frame by frame at film quality (no HUD), past the opening
  'aw-merge-conflict': {
    query: 'mode=capture&scene=botfight&fps=30&s=2', crf: [52, 34], ready: () => !!window.__cap, wait: 5000,
    setup: () => {
      if (!window.__cap) return;
      window.__cap.skip(90);
      window.__shot = () => window.__cap.frame();
    },
  },
  // Backroad Rally drives itself with ?autopilot: the Finnish gravel stage at 90 km/h, through the forest (past the
  // meadow at its start: it drives in real time while it loads, and gets less far when drawn at 2×)
  'aw-backroad-rally': { query: 'mode=quick&stage=finland&autopilot=90', wait: 150000, settle: 6, crf: [48, 32] },
  // Molazone: the rider in the desert, and the world turning beneath the wheels as it scrolls on to the next
  'ext-molazone': { viewport: [1024, 640], wait: 45000, steps: [{ click: [512, 573], wait: 20000 }], scroll: 200, crf: [46, 30] },
  // Odyssey: Enter sets sail and the wind carries the ship on (its autopilot's camera ends up in the rigging here)
  'ext-odyssey': { wait: 40000, steps: [{ key: 'Enter', wait: 60000 }], settle: 2, blank: true, crf: [44, 30] },
  // Flowline: dropping in and carving down the groomed run, an edge one way and then the other
  'ext-flowline': { wait: 30000, steps: [{ click: [320, 162], wait: 20000 }], settle: 3, press: [['d', 0.4, 0.9], ['a', 2.2, 2.7], ['a', 3.6, 4.2]] },
  // Tiny Planet: building a little town across the planet, a house at a time (its buttons and credit cropped off)
  'ext-tiny-planet': {
    wait: 40000, steps: [{ click: [48, 112], wait: 3000 }], scale: 3, crop: [110, 50, 416, 260],
    // from cell to cell over the planet's face, pressing for a moment on each
    mouse: hop([[270, 170], [300, 158], [332, 172], [350, 200], [322, 218], [290, 228], [264, 206], [298, 192], [270, 170]]),
  },
  // Brick Town: houses going up on an empty block, a click a storey (the town it starts with knocked down first, a
  // right click a block; its buttons and credit cropped off)
  'ext-brick-town': {
    wait: 30000, scale: 3, crop: [152, 140, 336, 210],
    steps: [0, 1, 2].flatMap(() => Array.from({ length: 13 * 15 }, (_, i) => ({ click: [200 + (i % 13) * 20, 60 + Math.floor(i / 13) * 20], button: 'right', wait: 250 }))),
    mouse: hop([[270, 282], [322, 302], [372, 280], [322, 252], [290, 262], [352, 266], [322, 282], [262, 298], [270, 282]]),
  },
  // Fluid: ink swirled through the water with the pointer held down, round and round in a figure eight (let go for a
  // moment now and then: each stroke takes a new colour)
  'ext-fluid': {
    wait: 20000, crf: [54, 34], setup: () => document.querySelectorAll('.dg.ac').forEach((el) => el.remove()),   // its settings panel, over the canvas
    mouse: (t) => [320 + 210 * Math.sin((2 * Math.PI * t) / 2.8), 200 + 110 * Math.sin((4 * Math.PI * t) / 2.8), t % 1.4 < 1.3],
  },
  // Ancient Earth: the globe of 240 million years ago turning, Pangaea coming round (the page's text is outside its canvas)
  'ext-ancient-earth': { wait: 25000, scale: 3.5, crop: [136, 85, 368, 230], crf: [44, 28] },
  // Marble Blast: past its menu into Time Trial (the tenth level), rolling off the start pad down its long straight
  'ext-marble-blast': {
    wait: 30000, hold: ['w'],
    steps: [{ click: [105, 42], wait: 4000 }, ...Array(9).fill({ click: [480, 264], wait: 3000 }), { click: [417, 264], wait: 30000 }],
  },
  // HexGL: its HUD turned off in the menu, past the controls card, racing off the start line and round the first bends,
  // steered by looking ahead on its collision map (the track's open pixels) and turning toward the side with more room
  'ext-hexgl': {
    wait: 20000, steps: [{ click: [320, 297], wait: 1000 }, { click: [320, 155], wait: 10000 }, { click: [320, 200], wait: 60000 }],
    crf: [48, 32],
    hold: ['ArrowUp'],
    setup: () => {
      const c = window.hexGL?.components?.shipControls;
      if (!c) return;
      window.__shot = () => {
        const m = c.collisionMap;
        if (!m?.loaded) return;
        const x = m.pixels.width / 2 + c.dummy.position.x * c.collisionPixelRatio, z = m.pixels.height / 2 + c.dummy.position.z * c.collisionPixelRatio;
        // how far the track is open at angle a off the ship's heading (positive: to its left)
        const open = (a) => {
          const v = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
          c.dummy.matrix.rotateAxis(v);
          let d = 1;
          while (d < 150 && (m.getPixel(Math.round(x + v.x * d), Math.round(z + v.z * d))?.r ?? 0) === 255) d++;
          return d;
        };
        const l = open(0.15) + open(0.35), r = open(-0.15) + open(-0.35);
        c.key.left = l > r * 1.15;
        c.key.right = r > l * 1.15;
      };
    },
  },
  // Tiny Skies: flying in toward the little planet, its islands and airships coming up to meet the plane
  // (its sky runs a 195 s day and night on the wall clock, offset by the world's seed: `init` reads the seed as the world
  // joins and `setup` moves its clock to mid-morning)
  'ext-tiny-skies': {
    crf: [44, 29], wait: 30000, steps: [{ click: [478, 347], wait: 15000 }], hold: ['w'],
    init: () => {
      const f = window.fetch;
      window.fetch = async (...a) => {
        const r = await f(...a);
        if (/auto-join/.test(String(a[0]))) r.clone().json().then((j) => { window.__tsSeed = j.seed ?? 42; }).catch(() => {});
        return r;
      };
    },
    setup: () => {
      const seed = window.__tsSeed ?? 42, now = Date.now, cycle = (((now() / 1000 + (seed % 195)) % 195) + 195) % 195;
      const off = ((10 - cycle + 195) % 195) * 1000;
      Date.now = () => now() + off;
    },
  },
  // Walden walks with WASD (not the arrows), and a held mouse button swings the sword: walking down the path to the arch
  'ext-walden': { wait: 60000, steps: [{ click: [320, 200], wait: 35000 }], hold: ['w'], crf: [47, 32] },
  'aw-fall-line': { wait: 40000, crf: [50, 32] },
  'ext-cyber-city-orion': { crf: [48, 32], wait: 60000, steps: [{ click: [320, 276], wait: 60000 }], hold: ['w'], drag: [10, 0] },
  // Claybound is a side-on platformer that sets its level up slowly here: running right, jumping up the steps
  'ext-claybound': { wait: 40000, steps: [{ click: [152, 168], wait: 150000 }], crf: [43, 29], hold: ['d'], press: [['w', 1.3, 1.8], ['w', 2.9, 3.3], ['w', 4.3, 4.8]] },
  // King's Gambit: an AI-vs-AI duel, paused (its engines move on real-time timers, many a frame here), the camera
  // orbiting the torchlit board in the ruined temple. Its controls are the page's, not the canvas's
  'ext-kings-gambit': {
    wait: 15000, steps: [{ click: [320, 200], wait: 8000 }], crf: [44, 28],
    setup: async () => {
      const press = (re) => {
        const b = [...document.querySelectorAll('button')].find((el) => re.test(el.textContent.trim() || el.getAttribute('aria-label')));
        b?.click();
        return !!b;
      };
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      if (!press(/^ai vs ai$/i)) return;
      await pause(1500);
      press(/^start ai vs ai$/i);
      await pause(10000);
      press(/^camera: orbit$/i);
      press(/^pause the ai vs ai duel$/i);
      await pause(5000);
    },
  },
  // SynthCity: launched from its terminal in free roam, gliding over the neon city at night
  'aw-synthcity': {
    crf: [46, 30], wait: 20000,
    setup: async () => {
      const go = document.getElementById('enterBtn');
      if (!go) return;
      window.userSettings.worldSeed = 9746;
      $('input[name=settingsMode][value=freeroam]').prop('checked', true).trigger('change');
      go.click();
      await new Promise((r) => setTimeout(r, 90000));
    },
    hold: ['w'],
  },
  // Susurrus: past its ink sketch in the colour world, the camera gliding in toward the island on its scrolled path and back
  // (its verse and buttons are the page's, not the canvas's)
  'ext-susurrus': {
    viewport: [1024, 640], wait: 40000, settle: 2,
    setup: async () => {
      const el = [...document.querySelectorAll('div')].find((e) => e.scrollHeight > e.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(e).overflowY));
      if (!el) return;
      // the ink has spread over the whole picture by 70% of the way down, and past 80% the camera hardly moves
      const at = (f) => { el.scrollTop = f * (el.scrollHeight - el.clientHeight); };
      at(0.71);
      await new Promise((r) => setTimeout(r, 20000));
      window.__shot = (t) => at(0.71 + 0.1 * (1 - Math.cos((2 * Math.PI * t) / 5)) / 2);
    },
  },
  // Jumper Lab: the robot crab scuttling sideways across the living-room floor (its panels are the page's, not the canvas's)
  'ext-jumper-lab': { wait: 15000, hold: ['d'] },
  'aw-aimees-papercraft': { wait: 25000, steps: [{ click: [320, 282], wait: 15000 }], scroll: 1400, crf: [46, 30] },
  // Verdant: the traveler following the trail from the campfire toward the Sanctuary, the camera with them (filmed as
  // a page: reading its canvas gives an old picture)
  'ext-verdant': {
    ready: () => !!window.__world, wait: 20000, steps: [{ wheel: -300, wait: 3000 }, { wheel: -300, wait: 5000 }], screenshot: true, settle: 2.5, crf: [47, 30],
    setup: () => {
      const w = window.__world;
      if (!w) return;
      if (w.cinematic?.active) w.toggleCinematic();
      w.goToArea('sanctuary');
      // everything but the canvas (and what holds it) out of the picture
      const hide = (el) => { for (const c of el.children) if (c.tagName === 'CANVAS') continue; else if (c.querySelector('canvas')) hide(c); else c.style.display = 'none'; };
      hide(document.body);
    },
  },
  'ext-sisyphus': { wait: 25000, steps: [{ click: [320, 200], wait: 3000 }], hold: ['ArrowRight', 'd'] },
  // Emberglade: into the glade, sprinting across the meadow toward the trees, the camera turning a little
  'ext-emberglade': { wait: 40000, steps: [{ click: [112, 260], wait: 30000 }], hold: ['w', 'Shift'], drag: [12, 0], crf: [46, 31] },
  // Kansō: past the title and the tour, a cherry bonsai on the bench, the camera turning slowly round it
  'ext-kanso': { wait: 25000, steps: [{ click: [320, 354], wait: 8000 }, { click: [373, 329], wait: 3000 }, { click: [320, 336], wait: 15000 }], drag: [15, 0] },
  // Pelagic Ocean: the swells rolling under the clouds, as it opens
  'ext-pelagic-ocean': { wait: 40000 },
  // Sakura Realm: under the tree (walked up to first), its blossom and the meadow in the wind
  'aw-sakura-realm': { wait: 40000, steps: [{ click: [320, 200], wait: 5000 }], lead: { seconds: 3, hold: ['w'] }, crf: [44, 29] },
  // Point Lookout: surf breaking along the beach below the headland (past its loader's enter button)
  'ext-point-lookout': { wait: 30000, steps: [{ click: [320, 200], wait: 20000 }] },
  // Komorebi: the whole garden turning a little and back, pagoda, blossom and koi pond (filmed as a page: its canvas is see-through)
  'ext-komorebi': {
    wait: 30000, steps: [...Array(5).fill({ wheel: -200, wait: 1500 }), { wheel: -200, wait: 25000 }], screenshot: true, settle: 5.5,
    drag: (t) => [W / 2 + 50 * Math.sin((2 * Math.PI * t) / SECONDS), H / 2],
    setup: () => { for (const el of document.querySelectorAll('.ui, #sulat-demo-referral-overlay')) el.style.display = 'none'; },
  },
  // Beyond Fable: flying low over pines along a lakeshore on a clear afternoon, turned away from the mountain it starts
  // facing (its world, hour and weather are set by the address)
  'ext-beyond-fable': { query: 'seed=3777735625&tod=0.68&weather=clear', wait: 40000, steps: [{ click: [320, 200], wait: 15000 }, { key: 'f', wait: 3000 }, { look: [1496, 0], wait: 5000 }], lead: { seconds: 3, hold: ['Space'] }, hold: ['w'], crf: [47, 32] },
  // Voxel Frontline: over a barrier, down the road and round another into the foundry at the start of a wave (deployed
  // in its probe mode: it won't start on a screen this narrow)
  'ext-voxel-frontline': {
    ready: () => !!window.frontline, wait: 20000, hold: ['w'], press: [['Space', 0.9, 1.1], ['Space', 1.3, 1.5], ['d', 2.4, 3.4]],
    setup: async () => { window.frontline.start({ probe: true }); await new Promise((r) => setTimeout(r, 15000)); },
  },
  // Long Wind: past the title and the first chapter's opening, the swordsman in the golden grass leaping at the bandits (the drag's
  // button is his strike) as the camera turns and back (walking on into them brings the fight's letterbox)
  'aw-long-wind': {
    ready: () => /click to begin/.test(document.body.innerText), readyTimeout: 1200000, wait: 120000, drag: swing(160, 0), crf: [47, 30],
    // clicked until the title gives way (a click while it's still loading does nothing), then the chapter's opening
    // shot plays out (slowly here)
    setup: async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const title = () => /click to begin/.test(document.body.innerText);
      if (!title()) return;
      for (let t = 0; t < 36 && title(); t++) {
        const el = document.elementFromPoint(320, 312) ?? document.body;
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, clientX: 320, clientY: 312 }));
        }
        await wait(5000);
      }
      await wait(330000);
    },
  },
  'aw-turbo-kart-rally': { wait: 30000, steps: [{ key: 'Enter', wait: 4000 }, { key: 'Enter', wait: 1500 }, { key: 'Enter', wait: 1500 }, { key: 'Enter', wait: 1500 }, { key: 'Enter', wait: 15000 }], hold: ['ArrowUp'] },
  // Wish Lanterns: on the dock at night, looking slowly across the lake as the lanterns rise
  'orb-lanterns': { wait: 15000, drag: [10, 0] },
  // Community Garden: closer in, turning around the flower bed and back
  'orb-garden': { crf: [46, 30], wait: 15000, steps: [{ wheel: -600, wait: 5000 }], drag: swing(70, 0) },
  // Hangout: strolling along the plaza past the fountain and the others there at dusk, and back
  'orb-hangout': {
    wait: 20000, company: 3,
    patch: [['const camOffset = ', 'window.__hangout = { self, camera }; const camOffset = ']],
    setup: () => {
      const { self: me, camera } = window.__hangout ?? {};
      if (!me) return;
      // in front of the others (they stand where they came in, just before the fountain), the camera settled behind
      const p = me.group.position;
      p.set(3, 0, 9);
      camera.position.set(3, 5.2, 22.5);
      camera.lookAt(3, 1.4, 6);
      window.__shot = (t) => {
        const a = (2 * Math.PI * t) / 4;
        p.set(3 - 12 * (1 - Math.cos(a)) / 2, 0, 9);
        me.heading = Math.abs(Math.sin(a)) < 0.3 ? 0 : Math.sin(a) > 0 ? -Math.PI / 2 : Math.PI / 2;   // facing us when it stops
      };
    },
  },
  // Seashell Island: the camera swinging around the little explorer on the beach, the hut, palms and the sea
  'orb-island': { wait: 20000, drag: swing(120, 20) },
  // Block Garden: closer in, turning around the floating island and its cottage and back
  'orb-blocks': { wait: 15000, steps: [{ wheel: -400, wait: 5000 }], drag: swing(70, 0) },
  // Star Runner: running the candy clouds, switching lanes for stars and jumping the jellies (it steers itself here)
  'orb-runner': {
    wait: 10000,
    patch: [['let overAt = 0;', 'let overAt = 0; window.__runner = { get state() { return state; }, get lane() { return lane; }, get speed() { return speed; }, obstacles, starPool, moveLane, jump, startGame };']],
    setup: async () => {
      const r = window.__runner;
      if (!r) return;
      const laneOf = (m) => Math.round(m.position.x / 1.8);
      const near = (l, from, to) => r.obstacles.filter((o) => o.visible && laneOf(o) === l && o.position.z < from && o.position.z > to);
      let played = 0, last = 0;
      const tick = (ts) => {
        played += last ? Math.min(0.05, (ts - last) / 1000) : 0; last = ts;
        if (r.state === 'play') {
          // the best lane next to this one: no gumdrop ahead, few jellies, stars to collect
          const score = (l) => (near(l, 1.2, -14).some((o) => o.userData.type === 'gum') ? -100 : 0) - near(l, 1.2, -14).length
            + 0.5 * r.starPool.filter((s) => s.visible && laneOf(s) === l && s.position.z < 0 && s.position.z > -18).length;
          const here = score(r.lane);
          for (const d of [-1, 1]) {
            const l = r.lane + d;
            if (l < -1 || l > 1 || near(l, 1.4, -3.2).length) continue;
            if (score(l) > here + 0.6) { r.moveLane(d); break; }
          }
          const at = -r.speed * 0.3;
          if (near(r.lane, at + 0.7, at - 0.7).some((o) => o.userData.type === 'jelly')) r.jump();
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      r.startGame();
      // a few seconds into the run: up to speed, the camera behind
      for (const until = Date.now() + 600000; played < 3 && Date.now() < until;) await new Promise((ok) => setTimeout(ok, 500));
    },
  },
  // Glow Paint: a rainbow ribbon painted in a loop around the glowing picture hung in the air
  'orb-paint': { wait: 15000, drag: (t) => { const a = Math.PI + 2.3 * Math.PI * (t / SECONDS), r = 1 - 0.12 * t / SECONDS; return [320 + 255 * r * Math.cos(a), 185 + 140 * r * Math.sin(a)]; } },
  // Dream Room: closer in, turning the cozy room a little and back (its canvas is transparent over the page's backdrop)
  'orb-room': { wait: 15000, steps: [{ wheel: -80, wait: 5000 }], drag: swing(-75, 0, 85, 200), screenshot: true,
    setup: () => {
      if (![...document.querySelectorAll('canvas')].some((c) => c.__orbGL)) return;   // the world's frame, not the kit's host
      for (const el of document.querySelectorAll('body > *:not(canvas)')) el.style.visibility = 'hidden';
    },
  },
  // Nova Lancer: its mission intro runs in game time, so the clip starts after it, firing and weaving low over the sea
  'aw-nova-lancer': { crf: [48, 32], wait: 30000, steps: [{ key: 'Enter', wait: 10000 }], settle: 16, hold: ['Space'], press: [['ArrowLeft', 0.8, 1.8], ['ArrowRight', 2.8, 3.8]] },
  // Villa Marea: its tour's opening shot, gliding in over the bay toward the villa at golden hour (T out of the tour and
  // back in starts that shot again, just before the clock is taken over; `settle` is well into it, nearer the villa)
  'ext-villa-marea': {
    ready: () => document.getElementById('loader')?.classList.contains('done'), readyTimeout: 1800000, wait: 5000, settle: 6,
    setup: () => {
      if (!document.getElementById('loader')) return;
      for (let k = 0; k < 2; k++) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT', key: 't' }));
    },
  },
  // Palmera Bay: cruising the coast boulevard at sunset, kept on the road as it bends (the game's own curve for it)
  'aw-palmera-bay': {
    wait: 30000, steps: [{ key: 'Enter', wait: 10000 }], settle: 3, hold: ['w'], crf: [55, 36],
    setup: () => {
      const car = window.__game?.car;
      if (!car) return;
      // the sea sits so close under the land that software GL's depth lets it flash through the street
      const w = window.__game.world;
      w.scene.traverse((o) => { if (o.material === w.oceanMat) o.position.y = -2; });
      const road = (z) => -125 + 16 * Math.sin(z * 0.0105 + 0.5) + 7 * Math.sin(z * 0.031 + 2) - 5;
      const slope = (z) => 16 * 0.0105 * Math.cos(z * 0.0105 + 0.5) + 7 * 0.031 * Math.cos(z * 0.031 + 2);
      window.__shot = () => {
        const z = car.pos.y;
        car.h = Math.atan2(slope(z + 8), 1);
        car.pos.x += (road(z) - car.pos.x) * 0.05;
      };
      window.__shot();
    },
  },
  // Kaiju Dokan: the monster wading up a street of the sunset city, its tail toppling towers (a detailed city: smaller files at a higher crf)
  'aw-kaiju-dokan': { crf: [63, 37], wait: 30000, steps: [{ click: [320, 154], wait: 10000 }], settle: 16, hold: ['w'], press: [['j', 1, 1.3], ['j', 2.5, 2.8], ['k', 3.8, 4.1]] },
  // Last Courier: the delivery robot walking up the moor, the camera in close and low, swinging gently round it and back
  'aw-last-courier': {
    wait: 40000, steps: [{ click: [92, 143], wait: 15000 }], settle: 8, hold: ['w'],
    setup: () => {
      if (typeof camState === 'undefined') return;
      camState.tDist = 3.4;
      camState.pitch = 0.2;
      const yaw = camState.yaw;
      window.__shot = (t) => { camState.yaw = yaw + 0.4 * Math.sin((2 * Math.PI * t) / 4); };
    },
  },
  // Foxfire Fjord: a glide from the fire pit past the cabin's lit glass wing to the deck and its steaming tub and back, under the aurora
  'orb-foxfire': {
    // past its first 15 s, when it checks its frame rate and may switch quality (a switch empties the canvas); it runs
    // at 30 frames a second here, and its aurora's reflections and light refresh only every second (each refresh draws the sky six times)
    ready: () => !!window.foxfire?.ctx?.controls && !!window.__SCENE_READY__, readyTimeout: 900000, wait: 20000, sub: 1, settle: 2, crf: [46, 31],
    setup: () => {
      const c = window.foxfire?.ctx?.controls;
      if (!c) return;
      Object.assign(window.foxfire.ctx.quality, { reflectRefresh: 1, envRefresh: 1 });
      // where the two viewpoints put the camera, then a slow eased glide between them (its own flights take a second)
      const cam = c.engine.camera, look = (p) => p.clone().add(cam.getWorldDirection(cam.position.clone()).multiplyScalar(20));
      c.goToViewpoint('deck', { instant: true });
      const b = [cam.position.clone(), look(cam.position)];
      c.goToViewpoint('cabin', { instant: true });
      const a = [cam.position.clone(), look(cam.position)];
      for (const el of document.querySelectorAll('canvas')) if (el !== c.engine.renderer?.domElement && el !== cam.userData?.canvas && !el.__orbGL) el.remove();
      // out and back over the clip's four seconds (SECONDS: this runs in the page), so its end dissolves into the same glide at its start
      window.__shot = (t) => {
        const e = (1 - Math.cos((2 * Math.PI * t) / 4)) / 2;
        c.teleport(a[0].clone().lerp(b[0], e), a[1].clone().lerp(b[1], e));
      };
    },
  },
  // Wildbrush: sprinting down the path, jumping and gliding (it boots slowly here: its shaders compile before the first frame)
  'orb-wildbrush': {
    ready: () => window.__wb?.ctx?.time?.frame > 30, readyTimeout: 600000, wait: 10000, steps: [{ click: [320, 200], wait: 5000 }], crf: [54, 35],
    setup: () => {
      const wb = window.__wb;
      if (!wb) return;
      const input = wb.ctx.input;
      input.inject('KeyW', true);
      input.inject('ShiftLeft', true);
      // sprint, then jump and glide (bearing left, clear of the arch's pillar), land, sprint on and jump again
      window.__shot = (t) => {
        input.inject('Space', (t > 0.6 && t < 1.9) || (t > 2.8 && t < 3.6));
        input.inject('KeyA', t > 1 && t < 1.5);
        input.inject('KeyD', t > 3.8 && t < 4.2);
      };
    },
  },
  // Bed Wars: a Duos match on Sunset Mesa, the camera chasing a bot as it bridges, buys and fights
  'orb-bedwars': {
    file: '?debug', ready: () => window.__bw?.game.mode === 'lobby', wait: 2000, crf: [42, 28],
    setup: async () => {
      const b = window.__bw;
      document.getElementById('daily')?.classList.add('hidden');
      b.mp = 2; b.playMode('duos'); b.match.cd = 0.05;
      while (b.match.phase !== 'play') await new Promise((r) => setTimeout(r, 200));
      await new Promise((r) => setTimeout(r, 15000));   // the bots have set out by now
      const live = (e) => e && e.isBot && !e.dead && !e.out;
      let bot = null, cx = 0, cy = 0, cz = 0, dx = 0, dz = 1, last = null;
      window.__shot = () => {
        // the bot furthest out from its base: bridging or raiding, in the open
        const out = (e) => { const base = b.world().bases[e.team]; return base ? Math.hypot(e.x - base.x, e.z - base.z) : 0; };
        if (!live(bot)) { bot = b.ents.filter(live).sort((p, q) => out(q) - out(p))[0]; last = null; }
        if (!bot) return;
        // which way it's heading, smoothed (its facing jumps about while it fights)
        if (last) { const mx = bot.x - last[0], mz = bot.z - last[1], m = Math.hypot(mx, mz); if (m > 0.01) { dx += (mx / m - dx) * 0.08; dz += (mz / m - dz) * 0.08; } }
        last = [bot.x, bot.z];
        const n = Math.hypot(dx, dz) || 1, tx = bot.x - (dx / n) * 8, ty = bot.y + 6.5, tz = bot.z - (dz / n) * 8;   // high, over the trees
        if (!cx && !cz) [cx, cy, cz] = [tx, ty, tz];
        cx += (tx - cx) * 0.12; cy += (ty - cy) * 0.12; cz += (tz - cz) * 0.12;
        b.camOverride = [cx, cy, cz, bot.x + (dx / n) * 3, bot.y + 1, bot.z + (dz / n) * 3];
      };
    },
  },
  // Orbcraft: setting out from Haven at golden hour, out through the plaza toward the Wilds
  'orb-craft': {
    file: '?debug&nodaily', ready: () => window.__oc?.game.mode === 'wild' && window.__oc.player && document.getElementById('loading')?.classList.contains('out'), wait: 3000,
    // the lead tile: drawn at 2.5× so its signs stay readable at that size
    scale: 2.5, crf: [46, 30],
    setup: () => {
      const o = window.__oc;
      o.renderer.setPixelRatio(2.5);
      o.renderer.setSize(innerWidth, innerHeight);
      o.clockShift = (o.clockShift || 0) - o.wildClock().t + 560;   // as its thumbnail
      for (const el of document.querySelectorAll('body > *:not(canvas)')) el.style.visibility = 'hidden';
      o.input.keys.add('KeyW');
      const yaw = o.cam.yaw;
      window.__shot = (t) => { o.cam.yaw = yaw + 0.04 * Math.sin(t * 0.7); o.input.jump = t % 1.6 < 0.08; };
    },
  },
  // Singularity: an arc around the black hole as its disk swirls and the starfield bends round it (its own hook places the camera)
  'ext-singularity': {
    wait: 30000,
    setup: () => {
      const s = window.__SINGULARITY__;
      if (!s) return;
      s.setQuality('high');
      window.__shot = (t) => {
        const a = -0.25 + 0.5 * (t / 5), r = 19 - 1.5 * (t / 5);
        s.setCamera([r * Math.sin(a), 2.6, r * Math.cos(a)], [0, 0.2, 0], 44);
      };
    },
  },
  // The Museum of Wrong Physics: strolling into the Ascending Waters, its rivers pouring up, turning slowly to take
  // the hall in (its test switches give its own hooks: the gallery to stand in, and walking without a pointer lock)
  'ext-wrong-physics': {
    query: 'test&loop&quality=high&only=atrium,upstream', ready: () => window.__museum?.ready, readyTimeout: 900000, wait: 5000, crf: [48, 31],
    setup: () => {
      const m = window.__museum;
      if (!m?.ready) return;
      m.view('upstream', 1);
      m.app.input.sim.forward = 0.2;
      window.__shot = () => m.look(0.15, 0);
    },
  },
  // Sakura: the cherry tree by the torii in full sun, petals drifting off it, the bough shaken twice
  'aw-sakura': { crf: [60, 36], wait: 30000, settle: 2, press: [['Space', 0.5, 0.6], ['Space', 2.5, 2.6]] },
  // VampireZ: a night with the bots, past the grace, the survivor running from the vampires on its own
  'orb-vampirez': {
    file: '?debug', ready: () => window.__vz?.game.state === 'title', wait: 3000, crf: [48, 31],
    setup: async () => {
      const vz = window.__vz;
      vz.start(true);
      while (vz.game.state !== 'play') await new Promise((r) => setTimeout(r, 300));
      vz.skip(vz.CONFIG.graceSeconds + 20);   // past the grace: the vampires are out
      // Walk a ring round the plaza's fire, where the survivors gather (left to the bots' own play,
      // the player stood still by a stall or the fire): the camera, behind the player, turns with it.
      const S = vz.SPAWN.survivor, cx = S.reduce((a, s) => a + s.x, 0) / S.length, cz = S.reduce((a, s) => a + s.z, 0) / S.length;
      const steer = () => {
        const P = vz.player, a = Math.atan2(P.z - cz, P.x - cx) + 0.5;
        vz.cam.yaw = Math.atan2(P.x - (cx + 6.5 * Math.cos(a)), P.z - (cz + 6.5 * Math.sin(a)));
        vz.input.stick.y = -1;
      };
      const walking = setInterval(steer, 50);
      await new Promise((r) => setTimeout(r, 10000));
      clearInterval(walking);
      window.__shot = steer;
      for (const el of document.querySelectorAll('body > *:not(canvas)')) el.style.visibility = 'hidden';
    },
  },
};

/** Runs in every frame before its scripts: a clock that only moves when the recorder says so. */
function clock({ blank: blanking } = {}) {
  const realNow = performance.now.bind(performance), RealDate = Date, realDateNow = Date.now;
  const realRaf = requestAnimationFrame.bind(window), realCancel = cancelAnimationFrame.bind(window);
  let on = false, t0 = 0, d0 = 0, t = 0, next = 1e9, queue = new Map();
  performance.now = () => (on ? t0 + t : realNow());
  const now = () => (on ? d0 + t : realDateNow());
  // Date() called without `new` returns a string, so this can't be a class
  function FakeDate(...a) {
    if (!new.target) return new RealDate(now()).toString();
    return a.length ? new RealDate(...a) : new RealDate(now());
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = now;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  window.Date = FakeDate;
  window.requestAnimationFrame = (cb) => {
    // a frame asked for before the clock was taken over but run after it waits for the next step,
    // or its real timestamp (ahead of the stopped clock) would make time run backwards
    if (!on) return realRaf((ts) => (on ? queue.set(++next, cb) : cb(ts)));
    queue.set(++next, cb);
    return next;
  };
  window.cancelAnimationFrame = (id) => (queue.has(id) ? queue.delete(id) : realCancel(id));
  // frames are drawn outside the browser's own frame loop, so WebGL must keep them until captured
  const getContext = HTMLCanvasElement.prototype.getContext, gls = new Set();
  HTMLCanvasElement.prototype.getContext = function (type, opts) {
    if (!/webgl/.test(type)) return getContext.call(this, type, opts);
    this.__orbGL = true;   // the recorder captures this canvas (not a HUD's 2D one over it)
    const gl = getContext.call(this, type, { ...opts, preserveDrawingBuffer: true });
    if (gl && blanking && !opts?.preserveDrawingBuffer) gls.add(gl);
    return gl;
  };
  // ...so with `blank` they're cleared before each frame as the browser would have (for worlds that draw over the last frame)
  function blank() {
    for (const gl of gls) {
      if (gl.isContextLost()) continue;
      const P = (k) => gl.getParameter(k), fb = P(gl.FRAMEBUFFER_BINDING), read = gl.READ_FRAMEBUFFER && P(gl.READ_FRAMEBUFFER_BINDING), color = P(gl.COLOR_CLEAR_VALUE), mask = P(gl.COLOR_WRITEMASK);
      const depth = [P(gl.DEPTH_CLEAR_VALUE), P(gl.DEPTH_WRITEMASK)], stencil = [P(gl.STENCIL_CLEAR_VALUE), P(gl.STENCIL_WRITEMASK)], scissor = gl.isEnabled(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0); gl.colorMask(true, true, true, true); gl.clearDepth(1); gl.depthMask(true); gl.clearStencil(0); gl.stencilMask(0xffffffff);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      if (gl.READ_FRAMEBUFFER) gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
      if (scissor) gl.enable(gl.SCISSOR_TEST);
      gl.clearColor(...color); gl.colorMask(...mask); gl.clearDepth(depth[0]); gl.depthMask(depth[1]); gl.clearStencil(stencil[0]); gl.stencilMask(stencil[1]);
    }
  }
  window.__orbClock = {
    start() { if (!on) { t0 = realNow(); d0 = realDateNow(); t = 0; on = true; } },
    // one of the browser's own frames: the mouse moves since reach the page only with one
    frame: () => new Promise((done) => { realRaf(() => done()); setTimeout(done, 5000); }),
    pending: () => queue.size,
    step(ms) {
      t += ms;
      const run = [...queue.values()]; queue = new Map();
      if (run.length) blank();
      for (const cb of run) try { cb(t0 + t); } catch (e) { console.error(e); }
    },
  };
}

/** The world's picture as JPEG bytes: its biggest canvas (a WebGL one first), read directly (screenshots of a canvas drawn
 *  between the browser's own frames can come out black, and this leaves the game's HUD out), or a
 *  screenshot when there's no big canvas or it can't be read. */
async function capture(page) {
  const found = await Promise.all(page.frames().map((f) => f.evaluate(() => {
    let best = null;
    for (const c of document.querySelectorAll('canvas')) {
      const st = getComputedStyle(c);
      if (st.visibility === 'hidden' || st.display === 'none' || +st.opacity < 0.1) continue;
      const r = c.getBoundingClientRect(), area = r.width * r.height * (c.__orbGL ? 4 : 1);
      if (!best || area > best.area) best = { c, area };
    }
    if (!best || best.area < innerWidth * innerHeight * 0.5) return null;
    try { return { area: best.area, gl: !!best.c.__orbGL, data: best.c.toDataURL('image/jpeg', 0.92) }; } catch { return null; }
  }).catch(() => null)));
  const best = found.filter((f) => f && f.data.length > 5000).sort((a, b) => b.area - a.area)[0];
  if (best) return Buffer.from(best.data.split(',')[1], 'base64');
  // a WebGL canvas caught empty: no frame now (a screenshot would show what was on screen long ago, a loading card)
  if (found.some((f) => f?.gl)) return null;
  return page.screenshot({ timeout: 300000, type: 'jpeg', quality: 92 });
}

/** Runs fn in every frame of the page. A world that stops answering (a frame stuck in a loop) fails its recording
 *  after ten minutes rather than hanging the run. */
async function frames(page, fn, arg) {
  let timer;
  const stuck = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('the world stopped answering')), 600000); });
  try {
    await Promise.race([Promise.all(page.frames().map((f) => f.evaluate(fn, arg).catch(() => {}))), stuck]);
  } finally {
    clearTimeout(timer);
  }
}

async function record(browser, id, shot) {
  const res = await fetch(`${SITE}/api/worlds/${id}`);
  const world = res.ok ? (await res.json()).world : null;
  if (!world) throw new Error(`${SITE} didn't send ${id} (${res.status})`);
  let url = world.externalUrl && shot.query ? `${world.externalUrl}${world.externalUrl.includes('?') ? '&' : '?'}${shot.query}` : world.externalUrl, kit = null, code = world.code ?? '';
  for (const [find, replace] of shot.patch ?? []) {
    if (!code.includes(find)) throw new Error(`the world's code has no ${JSON.stringify(find)} to patch`);
    code = code.replace(find, replace);
  }
  const dir = shot.file != null || world.kind === 'native' ? fs.mkdtempSync(path.join(os.tmpdir(), 'orb-preview-')) : null;
  if (dir) fs.writeFileSync(path.join(dir, 'index.html'), code);
  if (shot.file != null) {
    url = pathToFileURL(path.join(dir, 'index.html')).href + shot.file;
  } else if (world.kind === 'native') {
    kit = await serve({ dir, port: 0, watch: false, quiet: true });
    url = `${kit.url}?bare`;
  }
  const [vw, vh] = shot.viewport ?? [W, H];
  const context = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: shot.scale ?? SCALE });
  const page = await context.newPage();
  // (a crop is drawn finer, to come out at the usual size)
  const [outW, outH] = shot.size ?? (shot.crop ? [W * SCALE, H * SCALE] : [Math.round(W * (shot.scale ?? SCALE)), Math.round(H * (shot.scale ?? SCALE))]);
  try {
    await page.addInitScript(clock, { blank: !!shot.blank });
    if (shot.init) await page.addInitScript(shot.init);
    // Orb's own worlds: the kit's host, with the world's files from Orb
    if (kit) await context.route(new RegExp(`/api/tree/${TREE}/`), async (route) => {
      const rest = new URL(route.request().url()).pathname.split(`/api/tree/${TREE}/`)[1] || 'index.html';
      if (rest === 'index.html' && shot.patch) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: code });
      const r = await fetch(`${SITE}/api/tree/${world.tree}/${rest}`);
      route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) });
    });
    await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
    // other players: more tabs of the browser, each a player in the world's room (drawn small, they only stand about)
    for (let k = 0; k < (kit ? shot.company ?? 0 : 0); k++) {
      const other = await context.newPage();
      await other.setViewportSize({ width: 160, height: 100 });
      await other.goto(`${url}&player=${k + 2}`, { waitUntil: 'commit', timeout: 60000 });
    }
    // the world may be in a frame (Orb's own worlds run in the kit host's): ask every frame
    if (shot.ready) {
      const until = Date.now() + (shot.readyTimeout ?? 180000);
      while (!(await Promise.all(page.frames().map((f) => f.evaluate(shot.ready).catch(() => false)))).some(Boolean)) {
        if (Date.now() > until) throw new Error('the world never got ready');
        await page.waitForTimeout(1000);
      }
    }
    await page.waitForTimeout(shot.wait ?? 10000);
    for (const s of shot.steps ?? []) {
      if (s.click) await page.mouse.click(...s.click, { button: s.button ?? 'left' });
      if (s.key) await page.keyboard.press(s.key);
      if (s.wheel) { await page.mouse.move(vw / 2, vh / 2); await page.mouse.wheel(0, s.wheel); }
      if (s.look) { await page.mouse.move(vw / 2, vh / 2); await page.mouse.move(vw / 2 + s.look[0], vh / 2 + s.look[1], { steps: 40 }); }
      if (s.wait) await page.waitForTimeout(s.wait);
    }
    if (shot.setup) await frames(page, shot.setup);
    for (const k of shot.hold ?? []) await page.keyboard.down(k);
    const at = typeof shot.drag === 'function' ? shot.drag : (t) => [vw / 2 + shot.drag[0] * t, vh / 2 + shot.drag[1] * t];
    if (shot.drag) { await page.mouse.move(...at(0)); await page.mouse.down({ button: shot.button ?? 'left' }); }
    await frames(page, () => window.__orbClock?.start());
    // the world's loop is on the recorder's clock once its frame asked for before is queued (a slow world's next
    // real frame can take many seconds here); until then a step would run nothing
    for (const until = Date.now() + 120000; Date.now() < until;) {
      const n = await Promise.all(page.frames().map((f) => f.evaluate(() => window.__orbClock?.pending() ?? 0).catch(() => 0)));
      if (n.some(Boolean)) break;
      await page.waitForTimeout(250);
    }
    // half a second (or `settle` seconds) before the first frame kept, so the shot is settled (the camera where it starts)
    await frames(page, () => window.__shot?.(0));
    const sub = shot.sub ?? SUB, step = 1000 / FPS / sub;
    if (shot.lead) {
      for (const k of shot.lead.hold) await page.keyboard.down(k);
      for (let i = 0; i < Math.round(shot.lead.seconds * FPS * sub); i++) await frames(page, (ms) => window.__orbClock?.step(ms), step);
      for (const k of shot.lead.hold) await page.keyboard.up(k);
    }
    for (let i = 0; i < Math.round((shot.settle ?? 0.5) * FPS * sub); i++) await frames(page, (ms) => window.__orbClock?.step(ms), step);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-frames-`));
    const n = QUICK ? 48 : Math.round((SECONDS + FADE) * FPS);
    let down = false, last = null, lastMean = 0, dimRun = 0;
    for (let i = 0; i < n; i++) {
      await frames(page, (t) => window.__shot?.(t), i / FPS);
      if (shot.mouse) {
        const [x, y, press] = shot.mouse(i / FPS);
        await page.mouse.move(x, y);
        if (!!press !== down) await ((down = !!press) ? page.mouse.down() : page.mouse.up());
      }
      for (const [key, from, to] of shot.press ?? []) {
        if (i === Math.round(from * FPS)) await page.keyboard.down(key);
        if (i === Math.round(to * FPS)) await page.keyboard.up(key);
      }
      for (let k = 0; k < sub; k++) await frames(page, (ms) => window.__orbClock?.step(ms), step);
      if (shot.scroll) await page.mouse.wheel(0, shot.scroll / FPS);
      if (QUICK && i % 6) continue;
      if (shot.drag) {
        await page.mouse.move(...at(i / FPS));
        await frames(page, () => window.__orbClock?.frame());
      }
      // every frame the same size (some worlds change their canvas's resolution as they go); a canvas caught empty
      // (or black) is drawn again without the clock moving, or the frame before it kept. So is one much darker than the
      // frame before (a black block over part of it: some worlds draw one now and then); dark three frames running, it's a cut
      let frame = null, dim = null, mean = 0;
      for (let tries = 0; tries < 4; tries++) {
        if (tries) await frames(page, () => window.__orbClock?.step(0));
        const pic = shot.screenshot ? await page.screenshot({ timeout: 300000, type: 'jpeg', quality: 92 }) : await capture(page);
        if (!pic) continue;
        let img = sharp(pic);
        if (shot.crop) {
          const k = (await img.metadata()).width / W, [x, y, w, h] = shot.crop.map((v) => Math.round(v * k));
          img = sharp(await img.extract({ left: x, top: y, width: w, height: h }).toBuffer());
        }
        frame = await img.resize(outW, outH, { fit: 'cover' }).jpeg({ quality: 92 }).toBuffer();
        const { channels } = await sharp(frame).stats();
        mean = (channels[0].mean + channels[1].mean + channels[2].mean) / 3;
        if (!last || (channels.slice(0, 3).some((c) => c.mean > 6) && mean > lastMean / 2)) break;
        if (channels.slice(0, 3).some((c) => c.mean > 6)) dim = [frame, mean];
        frame = null;
      }
      dimRun = !frame && dim ? dimRun + 1 : 0;
      if (!frame && dim && dimRun >= 3) [frame, mean] = dim;
      if (!frame) [frame, mean] = [last, lastMean];
      if (!frame) throw new Error('no picture from the world');
      last = frame;
      lastMean = mean;
      fs.writeFileSync(path.join(dir, `${String(QUICK ? i / 6 : i).padStart(4, '0')}.jpg`), frame);
    }
    return dir;
  } finally {
    await context.close();
    kit?.close?.();
  }
}

/** Frames → VP9 WebM and H.264 MP4 whose last FADE seconds dissolve into the first, so they loop without a jump. */
function encode(dir, base, [vp9, h264] = [40, 27]) {
  const fade = `[0:v]split[a][b];[a]trim=start=${FADE},setpts=PTS-STARTPTS[main];[b]trim=0:${FADE},setpts=PTS-STARTPTS[head];` +
    `[main][head]xfade=transition=fade:duration=${FADE}:offset=${SECONDS - FADE},format=yuv420p[v]`;
  const input = ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, '%04d.jpg'), '-filter_complex', fade, '-map', '[v]', '-an'];
  execFileSync('ffmpeg', [...input, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(vp9), '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', `${base}.webm`]);
  execFileSync('ffmpeg', [...input, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(h264), '-movflags', '+faststart', `${base}.mp4`]);
}

// the kit's host needs Orb's runtime, built from src/lib/runtime each time (an older build lacks what host.js imports)
execFileSync('node', [path.join(root, 'scripts/publish-kit.mjs'), '--runtime'], { stdio: 'inherit' });
const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS);
const browser = await launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-features=IsolateSandboxedIframes', '--autoplay-policy=no-user-gesture-required'] });
const listFile = path.join(root, 'src/data/previews.json');
const added = {};
for (const id of ids) {
  try {
    const dir = await record(browser, id, SHOTS[id] ?? {});
    if (QUICK) {
      const sheet = path.join(os.tmpdir(), `${id}-quick.jpg`);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(dir, '%04d.jpg'), '-vf', 'scale=320:200,tile=4x2', '-frames:v', '1', sheet]);
      console.log(`· ${id}  ${sheet}`);
      continue;
    }
    const base = path.join(root, 'public/previews', id);
    encode(dir, base, SHOTS[id]?.crf);
    fs.rmSync(dir, { recursive: true });
    const hash = createHash('sha256');
    for (const ext of ['webm', 'mp4']) hash.update(fs.readFileSync(`${base}.${ext}`));
    added[id] = hash.digest('hex').slice(0, 8);
    console.log(`✓ ${id}  ${['webm', 'mp4'].map((ext) => `${(fs.statSync(`${base}.${ext}`).size / 1024).toFixed(0)} KB ${ext}`).join(', ')}`);
  } catch (e) {
    console.log(`✗ ${id}  ${e.message}`);
  }
}
// read again just before writing: another run may have added its own since
const list = { ...JSON.parse(fs.readFileSync(listFile, 'utf8')), ...added };
if (!QUICK) fs.writeFileSync(listFile, `${JSON.stringify(Object.fromEntries(Object.entries(list).sort()), null, 2)}\n`);
await browser.close();
