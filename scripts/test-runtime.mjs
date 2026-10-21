#!/usr/bin/env node
// End-to-end tests for the world runtime (src/lib/runtime/*, WorldFrame) via the dev harness
// page /dev/frame. Usage:
//
//   ORB_MOCK_AI=1 ORB_PGLITE_DIR=.data/pglite-runtime npx next dev -p 3101 &   # or let the script start it
//   node scripts/test-runtime.mjs                     # ORB_TEST_BASE=http://localhost:3101 by default
//
// If nothing answers on the base URL, the script starts `next dev -p 3101` itself and stops it
// at the end. Exit code 0 = all checks passed. The browser is the kit's (kit/lib/browser.mjs).
import { createRequire } from 'node:module';
import path from 'node:path';
import { launch, routeCdn } from '../kit/lib/browser.mjs';
import { check, finish, options, root, section, startNext, stopNext } from './harness.mjs';

const require = createRequire(import.meta.url);
options.details = true;

const BASE = (process.env.ORB_TEST_BASE || 'http://localhost:3101').replace(/\/$/, '');
const PORT = new URL(BASE).port || '3101';

// ------------------------------------------------------------------------------------------
// Dev server

async function ensureServer() {
  try {
    if ((await fetch(`${BASE}/dev/frame?sample=none`, { signal: AbortSignal.timeout(60_000) })).ok) return null;
  } catch {}
  console.log(`Starting next dev on :${PORT} …`);
  return startNext({ port: PORT, ready: '/dev/frame?sample=none', echo: true, env: { ORB_MOCK_AI: '1', ORB_PGLITE_DIR: process.env.ORB_PGLITE_DIR || '.data/pglite-runtime' } });
}

// ------------------------------------------------------------------------------------------
// Mock Supabase Realtime server (Phoenix protocol vsn 2.0.0, the subset realtime-js uses for
// broadcast + presence): text frames are [join_ref, ref, topic, event, payload]; user broadcasts
// are binary (client push kind 3 → server relay kind 4).

async function startMockRealtime() {
  const { WebSocketServer } = require('next/dist/compiled/ws');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const members = new Set(); // { ws, topic, joinRef, key, self, meta }
  let refSeq = 0;
  const stats = { joins: 0, broadcasts: 0, tracks: 0 };
  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const reply = (ws, joinRef, ref, topic, response = {}) => send(ws, [joinRef, ref, topic, 'phx_reply', { status: 'ok', response }]);
  const diff = (topic, joins, leaves) => {
    for (const m of members) if (m.topic === topic) send(m.ws, [m.joinRef, null, topic, 'presence_diff', { joins, leaves }]);
  };
  const drop = (m) => {
    members.delete(m);
    if (m.meta) diff(m.topic, {}, { [m.key]: { metas: [m.meta] } });
  };
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // userBroadcastPush: kind, joinRefLen, refLen, topicLen, eventLen, metaLen, encoding, …
        const b = new Uint8Array(data);
        const [, jl, rl, tl, el, ml, encoding] = b;
        let o = 7;
        const joinRef = dec.decode(b.slice(o, (o += jl)));
        o += rl;
        const topic = dec.decode(b.slice(o, (o += tl)));
        const event = b.slice(o, (o += el));
        const meta = b.slice(o, (o += ml));
        const payload = b.slice(o);
        const sender = [...members].find((m) => m.ws === ws && m.joinRef === joinRef);
        stats.broadcasts++;
        const t = enc.encode(topic);
        const head = Uint8Array.from([4, t.length, event.length, meta.length, encoding]);
        const out = Buffer.concat([head, t, event, meta, payload]);
        for (const m of members) {
          if (m.topic === topic && (m !== sender || m.self) && m.ws.readyState === 1) m.ws.send(out);
        }
        return;
      }
      const [joinRef, ref, topic, event, payload] = JSON.parse(String(data));
      if (topic === 'phoenix') return reply(ws, null, ref, topic);
      const me = [...members].find((m) => m.ws === ws && m.topic === topic);
      if (event === 'phx_join') {
        if (me) drop(me);
        const cfg = (payload && payload.config) || {};
        const m = { ws, topic, joinRef, key: (cfg.presence && cfg.presence.key) || `anon-${++refSeq}`, self: !!(cfg.broadcast && cfg.broadcast.self), meta: null };
        members.add(m);
        stats.joins++;
        reply(ws, joinRef, ref, topic, { postgres_changes: [] });
        const state = {};
        for (const o of members) if (o.topic === topic && o.meta) state[o.key] = { metas: [o.meta] };
        send(ws, [joinRef, null, topic, 'presence_state', state]);
      } else if (event === 'presence' && me) {
        const prev = me.meta;
        if (payload.event === 'track') {
          stats.tracks++;
          me.meta = { phx_ref: `p${++refSeq}`, ...payload.payload };
          diff(topic, { [me.key]: { metas: [me.meta] } }, prev ? { [me.key]: { metas: [prev] } } : {});
        } else if (payload.event === 'untrack' && prev) {
          me.meta = null;
          diff(topic, {}, { [me.key]: { metas: [prev] } });
        }
        reply(ws, joinRef, ref, topic);
      } else if (event === 'phx_leave') {
        if (me) drop(me);
        reply(ws, joinRef, ref, topic);
      } else {
        reply(ws, joinRef, ref, topic);
      }
    });
    ws.on('close', () => {
      for (const m of [...members]) if (m.ws === ws) drop(m);
    });
  });
  // A connection that isn't there, holding presence key `key` on the topic ending in `topicEnd`
  // (what someone reusing another page's peer id would look like).
  const fakes = new Map();
  const fakePresence = (topicEnd, key, meta = {}) => {
    const topic = [...members].find((m) => m.topic.endsWith(topicEnd))?.topic;
    if (!topic) throw new Error(`no topic ending in ${topicEnd}`);
    const m = { ws: { readyState: 3, send() {} }, topic, joinRef: `fake-${key}`, key, self: false, meta: { phx_ref: `p${++refSeq}`, name: 'Fake', color: '#000000', ...meta } };
    members.add(m);
    fakes.set(key, m);
    diff(topic, { [key]: { metas: [m.meta] } }, {});
  };
  const dropFake = (key) => {
    const m = fakes.get(key);
    if (!m) return;
    fakes.delete(key);
    drop(m);
  };
  return { url: `http://127.0.0.1:${wss.address().port}`, stats, fakePresence, dropFake, close: () => new Promise((r) => wss.close(r)) };
}

// ------------------------------------------------------------------------------------------
// Harness helpers

const VIEW = { width: 480, height: 300 };

async function newContext(browser) {
  const context = await browser.newContext({ viewport: VIEW });
  await routeCdn(context);
  return context;
}

async function openHarness(context, params = {}) {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('    [pageerror]', e.message));
  const qs = new URLSearchParams({ sample: 'none', ui: '0', bg: '#ff00ff', ...params });
  await page.goto(`${BASE}/dev/frame?${qs}`, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction(() => !!window.__orbHarness, null, { timeout: 60_000 });
  return page;
}

/** openHarness with Orb's config naming the realtime server at `url`. */
async function openRealtime(context, url, params) {
  const page = await openHarness(context, params);
  await page.route('**/api/config', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ai: false, model: 'x', githubOAuth: false, passkeys: false, realtime: { url, key: 'anon' } }) }),
  );
  return page;
}

/** Wait until `fn(arg)` is true in the frame. */
const wait = (frame, fn, arg, timeout = 8000) => frame.waitForFunction(fn, arg, { timeout, polling: 50 });

const count = (page, type) => page.evaluate((t) => window.__orbHarness.events.filter((e) => e.type === t).length, type);
const eventsOf = (page, type) => page.evaluate((t) => window.__orbHarness.events.filter((e) => e.type === t).map((e) => e.data), type);
const frameCount = (page) => page.evaluate(() => document.querySelectorAll('[data-orb-world] iframe').length);

/** The newest world iframe's Playwright Frame. */
async function worldFrame(page) {
  const els = await page.$$('[data-orb-world] iframe');
  if (!els.length) throw new Error('no world iframe');
  return els[els.length - 1].contentFrame();
}

/** Show `html`, wait for its `ready` and (optionally) for the cross-fade to finish. */
async function load(page, html, { settle = true, timeout = 20_000 } = {}) {
  const before = await count(page, 'ready');
  await page.evaluate((h) => window.__orbHarness.setHtml(h), html);
  await page.waitForFunction((n) => window.__orbHarness.events.filter((e) => e.type === 'ready').length > n, before, { timeout });
  if (settle) await page.waitForFunction(() => document.querySelectorAll('[data-orb-world] iframe').length === 1, null, { timeout: 5000 });
  return worldFrame(page);
}

const doc = (body, head = '') => `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>`;
const solid = (color, extra = '') => doc(`<script>document.title = ${JSON.stringify(color)};</script>${extra}`, `<style>html,body{margin:0;height:100%;background:${color}}</style>`);

const THREE_HEAD = `<style>html,body{margin:0;height:100%;overflow:hidden}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js"}}</script>`;
const threeWorld = (bg, extra = '') =>
  doc(
    `<script type="module">
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('${bg}');
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 5);
scene.add(new THREE.HemisphereLight('#ffffff', '#444466', 2));
const cube = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), new THREE.MeshStandardMaterial({ color: '#ffb38a' }));
scene.add(cube);
renderer.setAnimationLoop((t) => { cube.rotation.set(t / 900, t / 700, 0); renderer.render(scene, camera); });
${extra}
</script>`,
    THREE_HEAD,
  );

/** Pixel statistics of an image (data URL or base64 PNG/JPEG), computed in the browser. */
async function imageStats(page, src) {
  return page.evaluate(async (s) => {
    const img = new Image();
    img.src = s;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let magenta = 0, blue = 0, green = 0, n = 0, sum = 0, sum2 = 0;
    for (let i = 0; i < d.length; i += 16) {
      const r = d[i], gr = d[i + 1], b = d[i + 2];
      n++;
      if (r > 200 && gr < 70 && b > 200) magenta++;
      if (b > 150 && r < 90 && gr < 120) blue++;
      if (gr > 120 && r < 90 && b < 130) green++;
      const l = 0.3 * r + 0.59 * gr + 0.11 * b;
      sum += l;
      sum2 += l * l;
    }
    const mean = sum / n;
    return { w: c.width, h: c.height, magenta: magenta / n, blue: blue / n, green: green / n, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) };
  }, src);
}

// ------------------------------------------------------------------------------------------
// Tests

async function testInjection(context) {
  const page = await openHarness(context);
  const LS = String.fromCharCode(0x2028);
  const out = await page.evaluate(() => {
    const H = window.__orbHarness;
    const BOM = String.fromCharCode(0xfeff);
    const cases = {
      full: '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>x</title>\n</head>\n<body>\n<script>\nvar a = 1;\n</script>\n</body>\n</html>',
      upperBom: BOM + '<!DOCTYPE HTML>\n<HTML>\n<HEAD data-x=">">\n<TITLE>x</TITLE>\n</HEAD>\n<BODY></BODY>\n</HTML>',
      noHead: '<!doctype html>\n<html>\n<body><header>hello</header></body>\n</html>',
      noHtml: '<!-- leading comment -->\n<!doctype html>\n<title>x</title>\n<canvas></canvas>',
      fragment: '<canvas></canvas>\n<script>var b = 2;</script>',
      headerFirst: '<!doctype html><html><body><header>no head</header></body></html>',
      crlf: '<!doctype html>\r\n<html>\r\n<head>\r\n</head>\r\n<body>\r\n</body>\r\n</html>',
    };
    const res = {};
    for (const [k, html] of Object.entries(cases)) {
      const injected = H.inject(html);
      const d = new DOMParser().parseFromString(injected, 'text/html');
      const first = d.head.firstElementChild;
      const lines = (s) => s.split(/\r\n|\r|\n/).length;
      res[k] = {
        firstIsRuntime: !!first && first.tagName === 'SCRIPT' && first.hasAttribute('data-orb-runtime'),
        standards: d.compatMode,
        sameLines: lines(injected) === lines(html.startsWith(BOM) ? html.slice(1) : html),
        noBom: !injected.startsWith(BOM),
        parses: (() => {
          try {
            new Function(first.textContent);
            return true;
          } catch {
            return false;
          }
        })(),
      };
    }
    return res;
  });
  for (const [k, r] of Object.entries(out)) {
    const expectStandards = k !== 'fragment';
    check(`inject[${k}]: runtime is head's first child, parses, line count unchanged`, r.firstIsRuntime && r.parses && r.sameLines && r.noBom && (!expectStandards || r.standards === 'CSS1Compat'), r);
  }
  await page.close();

  // ctx with </script>, <!-- and U+2028 inside → still exactly one runtime script and world name intact.
  const page2 = await openHarness(context, { world: 'draft-inject', name: `Evil </script><!-- ${LS} name` });
  const frame = await load(page2, doc('<p>hi</p>'));
  const name = await frame.evaluate(() => window.orb.world.name);
  check('ctx JSON is escaped safely (</script>, <!--, U+2028)', name === `Evil </script><!-- ${LS} name`, JSON.stringify(name));
  const dom = await frame.evaluate(() => ({ scripts: document.scripts.length, firstHead: document.head.firstElementChild && document.head.firstElementChild.tagName, body: document.body.innerHTML.trim() }));
  check('runtime removes its own <script> element', dom.scripts === 0 && dom.firstHead === 'META' && dom.body === '<p>hi</p>', dom);
  const frozen = await frame.evaluate(() => {
    'use strict';
    const o = window.orb;
    let threw = 0;
    try { o.store = null; } catch { threw++; }
    try { o.room.join = null; } catch { threw++; }
    try { window.orb = 1; } catch { threw++; }
    return { frozen: Object.isFrozen(o) && Object.isFrozen(o.store) && Object.isFrozen(o.room) && Object.isFrozen(o.me) && Object.isFrozen(o.world), stillOrb: typeof window.orb.capture === 'function', threw, me: o.me };
  });
  check('window.orb is frozen and non-writable', frozen.frozen && frozen.stillOrb, frozen);
  await page2.close();
}

async function testStorage(context) {
  const WORLD = 'w-storage-test';
  const page = await openHarness(context, { world: WORLD });
  await page.evaluate((w) => localStorage.removeItem('orb:ls:' + w), WORLD);
  const world = doc(`<script>
var visits = Number(localStorage.getItem('visits') || 0) + 1;
localStorage.setItem('visits', visits);
window.__visits = visits;
</script>`);
  let frame = await load(page, world);
  const api = await frame.evaluate(() => {
    const r = {};
    r.type = typeof localStorage;
    r.instanceofStorage = localStorage instanceof Storage;
    r.toStringTag = Object.prototype.toString.call(localStorage);
    localStorage.setItem('a', '1');
    localStorage.setItem('n', 5);
    localStorage.setItem('nul', null);
    localStorage.setItem('obj', { x: 1 });
    r.coerced = [localStorage.getItem('n'), localStorage.getItem('nul'), localStorage.getItem('obj')];
    r.missing = localStorage.getItem('nope');
    localStorage.prop = 'p';
    r.propGet = [localStorage.prop, localStorage.getItem('prop'), 'prop' in localStorage, localStorage.nothing];
    r.length = localStorage.length;
    r.keys = Object.keys(localStorage);
    r.key0 = localStorage.key(0);
    r.keyOut = localStorage.key(99);
    r.json = JSON.parse(JSON.stringify(localStorage));
    delete localStorage.prop;
    localStorage.removeItem('obj');
    r.afterDelete = [localStorage.getItem('prop'), 'obj' in localStorage, localStorage.length];
    r.methodsWin = typeof localStorage.getItem === 'function' && typeof localStorage.length === 'number';
    try { localStorage.setItem('only-one-arg'); } catch (e) { r.arity = e instanceof TypeError; }
    sessionStorage.setItem('s', '1');
    r.session = [sessionStorage.getItem('s'), localStorage.getItem('s'), sessionStorage.length];
    document.cookie = 'c1=hello; path=/';
    document.cookie = 'c2=world';
    const c1 = document.cookie;
    document.cookie = 'c1=; max-age=0';
    r.cookies = [c1, document.cookie];
    try {
      localStorage.setItem('huge', 'x'.repeat(2 * 1024 * 1024 + 10));
    } catch (e) {
      r.quota = e && e.name;
    }
    localStorage.removeItem('a');
    localStorage.removeItem('n');
    localStorage.removeItem('nul');
    r.visits = window.__visits;
    return r;
  });
  check('Storage API: typeof/instanceof/toString look native', api.type === 'object' && api.instanceofStorage && api.toStringTag === '[object Storage]', api.toStringTag);
  check('Storage API: string coercion + getItem(missing) → null', JSON.stringify(api.coerced) === '["5","null","[object Object]"]' && api.missing === null, api.coerced);
  // [ls.prop, getItem('prop'), 'prop' in ls, ls.nothing] — the last one is undefined (→ null in JSON).
  check('Storage API: property-style get/set/in', JSON.stringify(api.propGet) === '["p","p",true,null]', api.propGet);
  check('Storage API: length, key(i), Object.keys, JSON.stringify', api.length === 6 && api.key0 === 'visits' && api.keyOut === null && api.keys.join() === 'visits,a,n,nul,obj,prop' && api.json.a === '1', { length: api.length, keys: api.keys, key0: api.key0 });
  check('Storage API: delete / removeItem', api.afterDelete[0] === null && api.afterDelete[1] === false && api.afterDelete[2] === 4, api.afterDelete);
  check('Storage API: methods not shadowed, arity TypeError', api.methodsWin && api.arity === true);
  check('sessionStorage is separate from localStorage', JSON.stringify(api.session) === '["1",null,1]', api.session);
  check('document.cookie shim (set, read, expire)', api.cookies[0] === 'c1=hello; c2=world' && api.cookies[1] === 'c2=world', api.cookies);
  check('localStorage quota → QuotaExceededError', api.quota === 'QuotaExceededError', api.quota);

  await page.waitForTimeout(700); // debounced flush
  const saved = await page.evaluate((w) => JSON.parse(localStorage.getItem('orb:ls:' + w) || 'null'), WORLD);
  check(`parent localStorage has orb:ls:${WORLD}`, saved && saved.visits === '1' && !('huge' in saved) && !('s' in saved), saved);

  // Swap to a new html: the new frame is seeded with the live (unflushed) storage.
  await frame.evaluate(() => {
    localStorage.setItem('swap', 'yes');
    // Keys that are special on plain JS objects must survive persistence too.
    localStorage.setItem('__proto__', 'pp');
    localStorage.setItem('toString', 'ts');
  });
  frame = await load(page, world.replace('<meta charset="utf-8">', '<meta charset="utf-8"><!-- v2 -->'));
  const swapped = await frame.evaluate(() => [localStorage.getItem('swap'), window.__visits]);
  check('new frame after html swap sees the latest storage immediately', swapped[0] === 'yes' && swapped[1] === 2, swapped);

  // Reload the whole page: storage comes back from the parent's localStorage.
  await page.waitForTimeout(600);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__orbHarness);
  frame = await load(page, world);
  const after = await frame.evaluate(() => ({ visits: window.__visits, swap: localStorage.getItem('swap'), proto: localStorage.getItem('__proto__'), ts: localStorage.getItem('toString') }));
  check('localStorage persists across a full page reload (incl. "__proto__"/"toString" keys)', after.visits === 3 && after.swap === 'yes' && after.proto === 'pp' && after.ts === 'ts', after);
  await page.close();
}

async function testWorldIdChange(context) {
  const page = await openHarness(context, { world: 'draft-mig' });
  await page.evaluate(() => {
    localStorage.removeItem('orb:ls:w-migrated');
    localStorage.removeItem('orb:ls:w-forked');
  });
  const frame = await load(page, doc('<script>localStorage.setItem("m", "1"); window.__marker = 1;</script>'));
  // Draft gets saved: same frame keeps running, storage follows the new id.
  await page.evaluate(() => window.__orbHarness.setWorldId('w-migrated'));
  await page.waitForTimeout(800);
  const same = await frame.evaluate(() => window.__marker).catch(() => 'detached');
  const migrated = await page.evaluate(() => JSON.parse(localStorage.getItem('orb:ls:w-migrated') || 'null'));
  check('draft → saved id: world keeps running, localStorage migrates', same === 1 && (await frameCount(page)) === 1 && migrated && migrated.m === '1', { same, migrated });
  // Different saved id with the same html (fork): the world restarts and sees its new id.
  const n = await count(page, 'ready');
  await page.evaluate(() => window.__orbHarness.setWorldId('w-forked'));
  await page.waitForFunction((k) => window.__orbHarness.events.filter((e) => e.type === 'ready').length > k, n, { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-orb-world] iframe').length === 1, null, { timeout: 5000 });
  const id = await (await worldFrame(page)).evaluate(() => window.orb.world.id);
  check('saved → other saved id with same html: world restarts with the new id', id === 'w-forked', id);
  await page.close();
}

async function testErrors(context) {
  const page = await openHarness(context, { world: 'draft-errors' });
  // jsDelivr answers 404s with CORS headers; mimic that (routeCdn's 404 has none).
  await page.route(/does-not-exist/, (r) => r.fulfill({ status: 404, body: 'Not found', headers: { 'access-control-allow-origin': '*', 'timing-allow-origin': '*' } }));
  const html = [
    '<!doctype html>', // 1
    '<html>', // 2
    '<head>', // 3
    '<meta charset="utf-8">', // 4
    '<script src="https://cdn.jsdelivr.net/npm/three@0.186.1/build/nope-classic.js"></script>', // 5
    '</head>', // 6
    '<body>', // 7
    '<script>', // 8
    'setTimeout(function later() {', // 9
    "  throw new Error('Timer exploded');", // 10
    '}, 20);', // 11
    "Promise.reject(new Error('Nobody caught me'));", // 12
    "console.error('Something odd', { code: 42 });", // 13
    '</script>', // 14
    '<script type="module">', // 15
    "import { Nope } from 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/does-not-exist.js';", // 16
    'console.log(Nope);', // 17
    '</script>', // 18
    '<script type="module">', // 19
    "setTimeout(() => { throw new TypeError('module boom'); }, 30);", // 20
    '</script>', // 21
    '<script>', // 22
    'var broken = ;', // 23
    '</script>', // 24
    '<script>', // 25
    'for (var i = 0; i < 12; i++) console.error("spam " + i);', // 26
    '</script>', // 27
    '</body>', // 28
    '</html>', // 29
  ].join('\n');
  await load(page, html);
  await page.waitForTimeout(600);
  const errors = await eventsOf(page, 'error');
  const find = (re) => errors.find((e) => re.test(e.message));
  const e1 = find(/Timer exploded/);
  check('thrown error reported with line/col', e1 && e1.line === 10 && e1.col > 0 && /later/.test(e1.stack || ''), e1);
  const e2 = find(/Nobody caught me/);
  check('unhandled rejection reported with line', e2 && e2.line === 12 && /^Unhandled promise rejection/.test(e2.message), e2);
  const e3 = find(/Something odd/);
  check('console.error reported with call-site line', e3 && e3.line === 13 && /\{"code":42\}/.test(e3.message), e3);
  const e4 = find(/does-not-exist\.js/);
  check('404 module import reported with URL, status and the import line', e4 && e4.line === 16 && /HTTP 404/.test(e4.message), e4);
  const e5 = find(/nope-classic\.js/);
  check('failed classic <script src> reported with its line', e5 && e5.line === 5 && /^Failed to load script/.test(e5.message), e5);
  const e6 = find(/module boom/);
  check('error thrown in an inline module reported with document line', e6 && e6.line === 20, e6);
  const e7 = find(/SyntaxError|Unexpected token/);
  check('syntax error reported with its line', e7 && e7.line === 23, e7);
  const spam = errors.filter((e) => /spam/.test(e.message)).length;
  check('only the first 5 console.error calls are reported', errors.filter((e) => /^console\.error/.test(e.message)).length === 5, `${spam} spam reports`);
  if (process.env.ORB_TEST_VERBOSE) console.log(errors);
  const keys = errors.map((e) => `${e.message}|${e.line}`);
  check('no duplicate reports', new Set(keys).size === keys.length, errors.length + ' reports');
  await page.close();
}

async function testCapture(context) {
  const page = await openHarness(context, { world: 'draft-capture' });
  const frame = await load(page, threeWorld('#20406a', `setTimeout(() => window.orb?.capture(), 300);`));
  await page.waitForTimeout(200);
  const url = await page.evaluate(() => window.__orbHarness.capture());
  check('capture() returns a webp data URL', typeof url === 'string' && url.startsWith('data:image/webp;base64,') && url.length > 2000, url ? `${url.slice(0, 30)}… (${url.length} chars)` : String(url));
  if (url) {
    const st = await imageStats(page, url);
    check('capture is 640x400 and not blank', st.w === 640 && st.h === 400 && st.std > 5, st);
  }
  await page.waitForFunction(() => window.__orbHarness.events.some((e) => e.type === 'capture'), null, { timeout: 5000 }).catch(() => {});
  check('orb.capture() delivers an unsolicited capture to the host', (await count(page, 'capture')) === 1);
  const hasPDB = await frame.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    return !!gl && gl.getContextAttributes().preserveDrawingBuffer === true;
  });
  check('WebGL contexts get preserveDrawingBuffer: true', hasPDB);
  await load(page, doc('<p>No canvas here</p>'));
  check('capture() without a canvas → null', (await page.evaluate(() => window.__orbHarness.capture())) === null);
  await page.close();
}

async function testWorkers(context) {
  // A world's files are another origin than its opaque frame (like /api/tree): workers from them.
  await context.route('https://files.orb.test/**', (route) => {
    const classic = route.request().url().endsWith('classic.js');
    route.fulfill({
      headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' },
      body: classic ? `postMessage('classic ' + (2 + 2));` : `import { n } from './n.js'; postMessage('module ' + n);`,
    });
  });
  await context.route('https://files.orb.test/n.js', (route) =>
    route.fulfill({ headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }, body: 'export const n = 7;' }),
  );
  const page = await openHarness(context, { world: 'draft-workers' });
  const frame = await load(page, doc(`<script>
window.got = [];
const w1 = new Worker('https://files.orb.test/module.js', { type: 'module' });
w1.onmessage = (e) => got.push(e.data);
const w2 = new Worker('https://files.orb.test/classic.js');
w2.onmessage = (e) => got.push(e.data);
</script>`));
  await frame.waitForFunction(() => window.got.length === 2, null, { timeout: 10_000 }).catch(() => {});
  const got = await frame.evaluate(() => window.got.slice().sort());
  check('a world’s workers start from its own files (module, with imports, and classic)', got[0] === 'classic 4' && got[1] === 'module 7', got);
  const hist = await frame.evaluate(() => {
    try { history.replaceState({ a: 1 }, '', '?level=2'); history.pushState({ b: 2 }, '', '#x'); return JSON.stringify(history.state); } catch (e) { return 'threw ' + e.name; }
  });
  check('history.replaceState / pushState with an address keep their state instead of throwing', hist === '{"b":2}', hist);
  await page.close();
}

/** RGB of the pixel at (fx, fy) (fractions) of an image. */
async function pixelAt(page, src, fx, fy) {
  return page.evaluate(
    async ([s, x, y]) => {
      const img = new Image();
      img.src = s;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(Math.floor(x * c.width), Math.floor(y * c.height), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [src, fx, fy],
  );
}

async function testProbe(context) {
  const page = await openHarness(context, { world: 'draft-probe' });
  const world = threeWorld(
    '#20406a',
    `
window.__keys = []; window.__clicks = 0; window.__moves = 0; window.__locked = 0; window.__touches = 0; window.__wheel = 0;
addEventListener('keydown', (e) => window.__keys.push(e.key + ':' + e.code + ':' + e.keyCode));
const hud = document.createElement('div');
hud.textContent = 'Score: 0';
Object.assign(hud.style, { position: 'fixed', left: '12px', top: '10px', font: '600 18px system-ui', color: '#ffffff', padding: '4px 10px', borderRadius: '8px', background: 'rgba(0,0,0,.6)' });
document.body.appendChild(hud);
const btn = document.createElement('button');
btn.textContent = 'Play';
Object.assign(btn.style, { position: 'fixed', left: '50%', top: '60%', transform: 'translate(-50%,-50%)', font: '700 20px system-ui', padding: '14px 40px', background: '#ffcc00', color: '#222', border: '0', borderRadius: '999px' });
document.body.appendChild(btn);
btn.addEventListener('click', () => { window.__clicks++; btn.remove(); renderer.domElement.requestPointerLock(); hud.textContent = 'Score: 1'; });
document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement) window.__locked++; });
document.addEventListener('mousemove', (e) => { if (document.pointerLockElement === renderer.domElement) window.__moves += e.movementX; });
renderer.domElement.addEventListener('pointerdown', (e) => renderer.domElement.setPointerCapture(e.pointerId));
addEventListener('touchstart', () => window.__touches++);
addEventListener('wheel', (e) => { window.__wheel += e.deltaY; });
addEventListener('keydown', (e) => { if (e.key === 'x') setTimeout(() => { throw new Error('x pressed boom'); }, 0); });
localStorage.setItem('before', '1');
addEventListener('keydown', (e) => { if (e.key === 'p') { localStorage.setItem('during', '1'); window.orb.store.set('trial', 42).then((v) => { window.__trialSet = v; }); } });
console.log('world says hi', { level: 1 });
console.warn('careful');
window.debug = { cube };
`,
  );
  const frame = await load(page, world);
  await page.waitForTimeout(300);
  const res = await page.evaluate(() =>
    window.__orbHarness.probe({
      size: 640,
      shots: 3,
      actions: [
        { type: 'screenshot', label: 'start' },
        { type: 'key', key: 'w', ms: 200 },
        { type: 'key', key: 'Shift+d', ms: 50 },
        { type: 'key', key: 'Space' },
        { type: 'click', x: 0.5, y: 0.6 },
        { type: 'move', dx: 120, dy: 0, ms: 100 },
        { type: 'scroll', dy: 240 },
        { type: 'click', x: 0.2, y: 0.85, touch: true },
        { type: 'key', key: 'x' },
        { type: 'key', key: 'p' },
        { type: 'wait', ms: 150 },
        { type: 'eval', js: 'window.__keys.slice(0, 6)' },
        { type: 'eval', js: 'debug.cube.position' },
        { type: 'eval', js: 'return 6 * 7' },
        { type: 'eval', js: 'nope.nope' },
        { type: 'eval', js: '({ clicks: __clicks, moves: __moves, locked: __locked, wheel: __wheel, touches: __touches, trial: window.__trialSet })' },
        { type: 'eval', js: 'alert("Game over!"); confirm("Again?")' },
        { type: 'dance' },
      ],
    }),
  );
  if (process.env.ORB_TEST_VERBOSE) console.log(JSON.stringify({ ...res, shots: res.shots?.map((s) => ({ ...s, dataUrl: s.dataUrl?.slice(0, 30) })) }, null, 1));
  check('probe answers with a result', !!res && !res.unavailable && Array.isArray(res.shots), res && res.unavailable);
  if (!res || res.unavailable) return page.close();
  check('probe: a start and an end screenshot (webp, viewport size)', res.shots.length === 2 && res.shots.every((s) => s.dataUrl?.startsWith('data:image/webp')) && res.shots[0].label === 'start' && res.shots[1].label === 'end', res.shots.map((s) => [s.label, s.dataUrl?.length]));
  check('probe: size of the viewport', res.size.w === VIEW.width && res.size.h === VIEW.height, res.size);
  check('probe: says the world is drawn in software (the test browser uses SwiftShader)', res.software === true, res.software);
  const st = await imageStats(page, res.shots[1].dataUrl);
  check('probe screenshot is the viewport (scaled) and not blank', st.w === VIEW.width && st.h === VIEW.height && st.std > 5 && !res.shots[1].flat, st);
  // Inside the button, beside its label.
  const yellow = await pixelAt(page, res.shots[0].dataUrl, 0.41, 0.6);
  check('probe screenshot shows HTML on top of the canvas (the yellow button)', yellow[0] > 200 && yellow[1] > 170 && yellow[2] < 90, yellow);
  const afterClick = await pixelAt(page, res.shots[1].dataUrl, 0.41, 0.6);
  check('…and the end screenshot shows it gone after the click', !(afterClick[0] > 200 && afterClick[1] > 170 && afterClick[2] < 90), afterClick);
  const hudPx = await pixelAt(page, res.shots[1].dataUrl, 0.03, 0.06);
  check('probe screenshot paints HTML boxes (the dark HUD pill)', hudPx[0] < 90 && hudPx[1] < 90, hudPx);
  const keys = res.evals[0]?.result ?? '';
  check('probe keys: key / code / keyCode, Shift chords, Space', keys.includes('w:KeyW:87') && keys.includes('D:KeyD:68') && keys.includes(' :Space:32') && keys.includes('Shift:ShiftLeft:16'), keys);
  check('probe eval: plain objects as JSON', /"x":0/.test(res.evals[1]?.result ?? ''), res.evals[1]);
  check('probe eval: statements with return', res.evals[2]?.result === '42', res.evals[2]);
  check('probe eval: errors are reported, not thrown', res.evals[3]?.error === true && /ReferenceError/.test(res.evals[3]?.result), res.evals[3]);
  const w = JSON.parse(res.evals[4]?.result ?? '{}');
  check('probe click hits the HTML button', w.clicks === 1, w);
  check('probe: pointer lock works for synthetic input', w.locked === 1 && res.locked, w);
  check('probe: mouse-look moves arrive as movementX under pointer lock', w.moves === 120, w);
  check('probe: wheel and touch events', w.wheel === 240 && w.touches >= 1, w);
  check('probe: the on-screen text, with positions', res.ui.some((u) => u.text === 'Score: 1' && u.x < 0.1 && u.y < 0.1) && !res.ui.some((u) => u.text === 'Play'), res.ui);
  check('probe: errors during the play-test are flagged', res.errors.some((e) => /x pressed boom/.test(e.message) && e.during), res.errors);
  check('probe: no errors caused by the synthetic pointer itself', !res.errors.some((e) => /pointer/i.test(e.message)), res.errors);
  check('probe: console output is kept', res.logs.some((l) => l.level === 'log' && l.text === 'world says hi {level: 1}') && res.logs.some((l) => l.level === 'warn' && l.text === 'careful'), res.logs);
  check('probe: unknown actions are noted', res.notes.some((n) => /dance/.test(n)), res.notes);
  check('probe: dialogs neither block the play-test nor pop up; the world\'s words are noted', res.evals[5]?.error !== true && res.notes.some((n) => n === 'The world showed alert("Game over!").') && res.notes.some((n) => /confirm\("Again\?"\)/.test(n)), res.notes);
  check('probe: frame rate and the main canvas', res.fps > 3 && res.canvas?.type === 'webgl2' && res.canvas.cover > 0.95, { fps: res.fps, canvas: res.canvas });
  await page.waitForTimeout(700); // debounced storage flush
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('orb:ls:draft-probe') || '{}'));
  await page.waitForFunction(() => document.querySelectorAll('[data-orb-world] iframe').length === 1, null, { timeout: 10_000 });
  const fresh = await worldFrame(page);
  check('probe: a fresh world is left behind', (await fresh.evaluate(() => window.__clicks)) === 0 && frame !== fresh);
  const after = await fresh.evaluate(() => window.orb.store.get('trial'));
  check('probe: what the play-test does is not saved (localStorage) or shared (orb.store)', saved.before === '1' && !('during' in saved) && w.trial === 42 && after === null, { saved, during: w.trial, after });

  // A form: click into the input and type.
  await load(page, doc('<input id="name" placeholder="Your name" style="font:16px system-ui;width:200px"><p id="out">Hi nobody</p><script>document.getElementById("name").addEventListener("input", (e) => { document.getElementById("out").textContent = "Hi " + e.target.value; });</script>', '<style>body{margin:8px;background:#fff;font:16px system-ui}</style>'));
  const form = await page.evaluate(() => window.__orbHarness.probe({ actions: [{ type: 'click', x: 0.1, y: 0.05 }, { type: 'type', text: 'Ada' }] }));
  check('probe: click focuses an input and typing fills it', form.ui?.some((u) => u.text === 'Hi Ada') && form.ui.some((u) => u.tag === 'input' && u.text === '[text] Ada') && form.focus === 'input#name', form.ui ?? form);

  // Zoom: part of the screen, drawn larger (here 4×: a tenth of 480×300 → 192×120), text included.
  await load(page, doc('<div style="position:fixed;left:10px;top:10px;width:24px;height:24px;background:#e01010"></div><p style="position:fixed;left:200px;top:120px;margin:0;font:bold 20px system-ui;color:#000">HELLO</p>', '<style>body{margin:0;background:#fff}</style>'));
  const zoomed = await page.evaluate(() => window.__orbHarness.probe({ actions: [{ type: 'screenshot', label: 'corner', zoom: { x: 0, y: 0, w: 0.1, h: 0.1 } }, { type: 'screenshot', label: 'text', zoom: { x: 0.4, y: 0.37, w: 0.25, h: 0.15 } }, { type: 'screenshot', label: 'blank', zoom: { x: 0.8, y: 0.8, w: 0.15, h: 0.15 } }] }));
  const zs = zoomed.shots?.[0];
  const zst = zs?.dataUrl ? await imageStats(page, zs.dataUrl) : null;
  const red = zs?.dataUrl ? await pixelAt(page, zs.dataUrl, 0.45, 0.6) : [];
  check('probe: a zoomed screenshot shows that part of the screen, larger', zs?.label === 'corner' && zs.zoom?.w === 0.1 && zst?.w === 192 && zst?.h === 120 && red[0] > 200 && red[1] < 60, { zoom: zs?.zoom, size: zst && [zst.w, zst.h], red });
  const text = zoomed.shots?.[1]?.dataUrl ? await imageStats(page, zoomed.shots[1].dataUrl) : null;
  const blank = zoomed.shots?.[2]?.dataUrl ? await imageStats(page, zoomed.shots[2].dataUrl) : null;
  check('probe: …and the page\'s text in it', text && blank && text.std > 20 && blank.std < 3, { text: text?.std, blank: blank?.std });

  // A world that shows nothing.
  await load(page, solid('#123456'));
  const flat = await page.evaluate(() => window.__orbHarness.probe({ actions: [] }));
  check('probe: a flat screen is flagged', flat.shots?.length === 1 && flat.shots[0].flat === true && flat.canvas === null, flat.shots?.map((s) => s.flat));

  // A world that has been running a while is started fresh before it is played.
  await page.waitForTimeout(6000);
  const readyBefore = await count(page, 'ready');
  const restarted = await page.evaluate(() => window.__orbHarness.probe({ actions: [] }));
  await page.waitForTimeout(1500);
  check('probe: a world that ran a while starts fresh, and a fresh one is left behind', restarted.uptime < 3000 && (await count(page, 'ready')) >= readyBefore + 2, { uptime: restarted.uptime, readies: (await count(page, 'ready')) - readyBefore });
  await page.close();
}

/** A look on a phone plays the world phone-sized in the middle of a laptop-sized page, then puts it back. */
async function testPhoneLook(browser) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await routeCdn(context);
  const page = await openHarness(context, { world: 'draft-phone' });
  await load(page, doc('<p>hello</p>', '<style>body{margin:0;background:#fff;font:16px system-ui}</style>'));
  const res = await page.evaluate(() => window.__orbHarness.probe({ viewport: 'phone', actions: [{ type: 'eval', js: 'innerWidth + "x" + innerHeight' }] }));
  check('probe on a phone: the world plays at 390×844', res.size?.w === 390 && res.size?.h === 844 && /390x844/.test(res.evals?.[0]?.result ?? ''), res.size ?? res);
  await page.waitForFunction(() => document.querySelectorAll('[data-orb-world] iframe').length === 1, null, { timeout: 10_000 });
  const box = await page.evaluate(() => {
    const r = document.querySelector('[data-orb-world] iframe').getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height)];
  });
  check('…and a fresh full-size world is left behind', box[0] === 1200 && box[1] === 900, box);
  await context.close();
}

async function testSwap(context) {
  const page = await openHarness(context, { world: 'draft-swap' });
  // Make the incoming world slow (like a cold CDN): three.js arrives after 1.2 s. Until its
  // `ready`, the old world must stay on screen.
  await page.route(/three\.module\.js$/, async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.fallback();
  });
  const analysis = await context.newPage(); // decode screenshots off the page under test
  await analysis.goto(`${BASE}/dev/frame?sample=none&ui=0`);
  await load(page, solid('#1030d0'));
  await page.waitForTimeout(700); // the very first world fades in from nothing; let that finish

  // Sample, on every animation frame of the parent, the iframes' computed opacity.
  await page.evaluate(() => {
    window.__samples = [];
    window.__sampling = true;
    const host = document.querySelector('[data-orb-world]');
    (function tick() {
      const frames = [...host.querySelectorAll('iframe')];
      const ops = frames.map((f) => Number(getComputedStyle(f).opacity));
      const fade = Math.max(0, ...frames.flatMap((f) => f.getAnimations().map((a) => Number(a.effect.getTiming().duration) || 0)));
      window.__samples.push({ n: frames.length, max: Math.max(0, ...ops), min: Math.min(1, ...ops), fade });
      if (window.__sampling) requestAnimationFrame(tick);
    })();
  });
  const before = await count(page, 'ready');
  await page.evaluate((h) => window.__orbHarness.setHtml(h), threeWorld('#10b050'));
  const shots = [];
  let readyAt = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    const ready = !readyAt && (await count(page, 'ready')) > before;
    if (ready) readyAt = Date.now();
    shots.push({ t: Date.now() - t0, beforeReady: !readyAt, buf: await page.screenshot({ type: 'jpeg', quality: 70 }) });
    if (readyAt && Date.now() - readyAt > 1100) break;
  }
  await page.evaluate(() => (window.__sampling = false));
  const samples = await page.evaluate(() => window.__samples);
  const stats = [];
  for (const s of shots) stats.push({ t: s.t, beforeReady: s.beforeReady, ...(await imageStats(analysis, `data:image/jpeg;base64,${s.buf.toString('base64')}`)) });
  const blankest = Math.max(...stats.map((s) => s.magenta));
  const timeline = stats.map((s) => `${s.t}:${s.beforeReady ? 'L' : ''}${s.blue > 0.9 ? 'old' : s.green > 0.5 ? 'new' : 'mix'}`).join(' ');
  check(`no blank frame in ${stats.length} screenshots during the swap`, blankest < 0.01, `max blank fraction ${blankest.toFixed(4)}`);
  check('old world stays on screen while the new one loads', stats.filter((s) => s.beforeReady).every((s) => s.blue > 0.9), `${stats.filter((s) => s.beforeReady).length} shots while loading`);
  check('ends on the new world', stats[stats.length - 1].green > 0.5, stats[stats.length - 1]);
  if (process.env.ORB_TEST_VERBOSE) console.log('    timeline', timeline);
  // The old frame fades out with a ~450 ms opacity transition (not a cut). (The mid-fade frame
  // count is informational: back-to-back screenshots can starve the parent's rAF.)
  const fading = samples.filter((s) => s.n >= 2 && s.min > 0.02 && s.min < 0.98).length;
  const fadeMs = Math.max(...samples.map((s) => s.fade));
  check('outgoing world cross-fades (opacity transition ~450 ms)', fadeMs >= 400, `${fadeMs} ms transition, ${fading} sampled frames mid-fade`);
  const bad = samples.filter((s) => s.n === 0 || s.max < 0.999);
  check(`an opaque frame covered the viewport on every animation frame (${samples.length} rAF samples)`, bad.length === 0, bad.slice(0, 3));
  await page.waitForTimeout(300);
  check('old iframe removed after the fade', (await frameCount(page)) === 1);

  // Rapid updates: latest html wins, nothing piles up.
  const n0 = await count(page, 'ready');
  for (const c of ['#c03030', '#30c0c0', '#c0c030']) await page.evaluate((h) => window.__orbHarness.setHtml(h), solid(c));
  await page.waitForFunction((n) => window.__orbHarness.events.filter((e) => e.type === 'ready').length > n, n0, { timeout: 10_000 });
  await page.waitForTimeout(1500);
  const title = await (await worldFrame(page)).evaluate(() => document.title);
  check('rapid html changes settle on the latest world', title === '#c0c030' && (await frameCount(page)) === 1, `title=${title}, ready events=${(await count(page, 'ready')) - n0}`);

  // Keyboard focus follows the swap.
  await load(page, solid('#203040', '<script>addEventListener("keydown", (e) => (window.__keys = (window.__keys || "") + e.code));</script>'));
  await page.mouse.click(VIEW.width / 2, VIEW.height / 2);
  const focusedBefore = await page.evaluate(() => document.activeElement && document.activeElement.tagName);
  const fB = await load(page, solid('#304050', '<script>addEventListener("keydown", (e) => (window.__keys = (window.__keys || "") + e.code));</script>'));
  await page.keyboard.press('KeyW');
  const keys = await fB.evaluate(() => window.__keys || '');
  const focusedAfter = await page.evaluate(() => document.activeElement === document.querySelector('[data-orb-world] iframe'));
  check('keyboard focus moves to the new frame', focusedBefore === 'IFRAME' && focusedAfter && keys === 'KeyW', { focusedBefore, focusedAfter, keys });

  // reload(): re-runs the world (fresh JS state) without a blank frame.
  await fB.evaluate(() => (window.__marker = 1));
  const r0 = await count(page, 'ready');
  await page.evaluate(() => window.__orbHarness.reload());
  await page.waitForFunction((n) => window.__orbHarness.events.filter((e) => e.type === 'ready').length > n, r0, { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-orb-world] iframe').length === 1, null, { timeout: 5000 });
  const marker = await (await worldFrame(page)).evaluate(() => window.__marker);
  check('reload() re-runs the world', marker === undefined);
  await analysis.close();
  await page.close();
}

async function testStore(context) {
  // Draft: in-memory store.
  const page = await openHarness(context, { world: 'draft-store' });
  let frame = await load(page, doc('<p>store</p>'));
  const r = await frame.evaluate(async () => {
    const s = window.orb.store;
    const out = {};
    out.get0 = await s.get('k');
    out.set = await s.set('k', { a: 1, b: [1, 2] });
    out.get1 = await s.get('k');
    out.incr = [await s.incr('n'), await s.incr('n'), await s.incr('n', 5)];
    out.push = [];
    for (let i = 0; i < 4; i++) out.push = await s.push('list', 'x' + i, 3);
    await s.merge('c:1', { a: 1, b: 2 });
    out.merge = await s.merge('c:1', { b: null, c: 3 });
    await s.merge('c:2', { z: 1 });
    out.list = await s.list('c:');
    out.errors = [];
    for (const f of [() => s.set('big', 'x'.repeat(9000)), () => s.get(''), () => s.incr('n', 'a'), () => s.set('fn', () => 1), () => s.merge('c:1', [1])]) {
      try {
        await f();
        out.errors.push('resolved');
      } catch (e) {
        out.errors.push(e.name);
      }
    }
    return out;
  });
  check('draft store: get/set round-trip', r.get0 === null && r.set.a === 1 && JSON.stringify(r.get1) === '{"a":1,"b":[1,2]}', r.get1);
  check('draft store: incr', JSON.stringify(r.incr) === '[1,2,7]', r.incr);
  check('draft store: push keeps the last `max`', JSON.stringify(r.push) === '["x1","x2","x3"]', r.push);
  check('draft store: merge adds up, null removes a field', JSON.stringify(r.merge) === '{"a":1,"c":3}', r.merge);
  check('draft store: list(prefix) → those keys, in order', JSON.stringify(r.list) === '{"c:1":{"a":1,"c":3},"c:2":{"z":1}}', r.list);
  check('store rejects oversize / bad keys / bad args', r.errors.join() === 'RangeError,TypeError,TypeError,TypeError,TypeError', r.errors);
  // Survives an html swap (same page, same draft).
  frame = await load(page, doc('<p>store 2</p>'));
  const again = await frame.evaluate(() => window.orb.store.get('n'));
  check('draft store survives a world swap', again === 7, again);
  await page.close();

  // Saved world: goes through POST /api/worlds/:id/store.
  const page2 = await openHarness(context, { world: 'w-store-api' });
  const calls = [];
  let fail = false;
  await page2.route('**/api/worlds/w-store-api/store', async (route) => {
    const req = route.request();
    const body = JSON.parse(req.postData() || '{}');
    calls.push({ body, device: !!req.headers()['x-orb-device'] });
    if (fail) return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'rate_limited', message: 'Slow down', retryAfter: 3 }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value: body.op === 'incr' ? 41 + (body.by || 1) : body.op === 'get' ? { from: 'server' } : body.value }) });
  });
  frame = await load(page2, doc('<p>api</p>'));
  const r2 = await frame.evaluate(async () => [await window.orb.store.get('g'), await window.orb.store.incr('c'), await window.orb.store.set('k', [1, 2])]);
  check('saved world store calls the API', JSON.stringify(r2) === '[{"from":"server"},42,[1,2]]' && calls.length === 3 && calls.every((c) => c.device), { r2, calls });
  fail = true;
  const err = await frame.evaluate(() => window.orb.store.get('g').then(() => 'resolved', (e) => e.message));
  check('API errors reject the promise with the server message', err === 'Slow down', err);
  await page2.close();
}

async function testIsolation(context) {
  const page = await openHarness(context, { world: 'draft-iso' });
  await page.evaluate(() => {
    localStorage.setItem('orb:secret', 'parent-secret');
    document.cookie = 'orb_session=top-secret; path=/';
  });
  const frame = await load(page, doc('<p>iso</p>'));
  const r = await frame.evaluate(async () => {
    const tryIt = (f) => {
      try {
        const v = f();
        return 'READ:' + String(v).slice(0, 40);
      } catch (e) {
        return 'blocked:' + e.name;
      }
    };
    let fetchRes;
    try {
      const res = await fetch(location.ancestorOrigins?.[0] ? location.ancestorOrigins[0] + '/api/me' : '/api/me', { credentials: 'include' });
      fetchRes = 'READ:' + res.status;
    } catch (e) {
      fetchRes = 'blocked:' + e.name;
    }
    return {
      origin: window.origin,
      ownLs: localStorage.getItem('orb:secret'),
      ownKeys: Object.keys(localStorage).filter((k) => k.startsWith('orb:')),
      ownCookie: document.cookie,
      parentLs: tryIt(() => window.parent.localStorage.getItem('orb:secret')),
      parentCookie: tryIt(() => window.parent.document.cookie),
      topHref: tryIt(() => window.top.location.href),
      fetchRes,
    };
  });
  check('world runs in an opaque origin', r.origin === 'null', r.origin);
  check("world's localStorage does not see Orb's keys", r.ownLs === null && r.ownKeys.length === 0, r.ownKeys);
  check("world's document.cookie does not see Orb's cookies", !/orb_session/.test(r.ownCookie), r.ownCookie);
  check("world cannot read parent's localStorage / cookies / location", /^blocked/.test(r.parentLs) && /^blocked/.test(r.parentCookie) && /^blocked/.test(r.topHref), r);
  check("world cannot make credentialed reads of Orb's API", /^blocked/.test(r.fetchRes), r.fetchRes);
  const sandbox = await page.evaluate(() => document.querySelector('[data-orb-world] iframe').getAttribute('sandbox'));
  check('native iframe sandbox has no allow-same-origin', sandbox && !/allow-same-origin/.test(sandbox) && /allow-scripts/.test(sandbox), sandbox);

  await page.evaluate(() => window.__orbHarness.setExternal('https://example.org/'));
  await page.waitForSelector('[data-orb-world] iframe[src="https://example.org/"]');
  const ext = await page.evaluate(() => {
    const f = document.querySelector('[data-orb-world] iframe');
    return { n: document.querySelectorAll('[data-orb-world] iframe').length, sandbox: f.getAttribute('sandbox'), allow: f.getAttribute('allow') };
  });
  check('external world: single iframe, sandbox incl. allow-same-origin, same allow list', ext.n === 1 && /allow-same-origin/.test(ext.sandbox) && /xr-spatial-tracking/.test(ext.allow), ext);
  check('external world capture() → null', (await page.evaluate(() => window.__orbHarness.capture())) === null);
  await page.close();
}

async function testRoom(context) {
  // Draft → solo room, never touches the network.
  const page = await openHarness(context, { world: 'draft-room' });
  let frame = await load(page, doc('<p>room</p>'));
  const solo = await frame.evaluate(
    () =>
      new Promise((resolve) => {
        const room = window.orb.room.join((e) => {
          if (e.type === 'joined') {
            room.setState({ x: 1 });
            room.send({ hi: 1 });
            resolve({ type: e.type, peers: e.peers.length, self: e.self && typeof e.self.id === 'string', size: room.peers.size, live: e.live });
          }
        });
      }),
  );
  check('draft world: room.join → solo `joined` with no peers', solo.type === 'joined' && solo.peers === 0 && solo.self && solo.size === 0, solo);
  check('…and `joined.live` is false (nobody can reach you)', solo.live === false, solo);
  await page.close();

  // Saved world with realtime pointing nowhere → still joins (solo), never throws.
  const page2 = await openRealtime(context, 'http://127.0.0.1:9', { world: 'w-room' });
  frame = await load(page2, doc('<p>room</p>'));
  const t0 = Date.now();
  const net = await frame.evaluate(
    () =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ type: 'timeout' }), 9000);
        window.orb.room.join((e) => {
          if (e.type === 'joined') {
            clearTimeout(timer);
            resolve({ type: e.type, peers: e.peers.length, live: e.live });
          }
        });
      }),
  );
  check('unreachable realtime → room still reports `joined` (solo)', net.type === 'joined' && net.peers === 0, `${JSON.stringify(net)} after ${Date.now() - t0} ms`);
  check('…with `live: false`', net.live === false, net);
  await page2.close();
}

async function testMultiplayer(context) {
  const mock = await startMockRealtime();
  try {
    const WORLD = 'w-multiplayer';
    const open = (me) => openRealtime(context, mock.url, { world: WORLD, me });
    const world = (tag) => doc(`<script>
window.__ev = [];
window.__room = window.orb.room.join((e) => window.__ev.push(JSON.parse(JSON.stringify(e))));
document.title = ${JSON.stringify(tag)};
</script>`);
    const evs = (frame, type) => frame.evaluate((t) => window.__ev.filter((e) => !t || e.type === t), type);

    const pageA = await open('alice');
    let fa = await load(pageA, world('A1'));
    await wait(fa, () => window.__ev.some((e) => e.type === 'joined'));
    const selfA = (await evs(fa, 'joined'))[0].self;

    const pageB = await open('bob');
    const fb = await load(pageB, world('B1'));
    await wait(fb, () => window.__ev.some((e) => e.type === 'joined'));
    // B learns about A (in `joined` or a later `join`), A gets a `join` for B.
    await wait(fb, (id) => window.__room.peers.has(id), selfA.id);
    await wait(fa, () => window.__ev.some((e) => e.type === 'join'));
    const joinB = (await evs(fa, 'join'))[0].peer;
    check('two players see each other (presence)', joinB.id.startsWith('bob:') && selfA.id.startsWith('alice:') && joinB.name === 'Dev Player', { a: selfA.id, b: joinB.id });
    const liveAB = [(await evs(fa, 'joined'))[0].live, (await evs(fb, 'joined'))[0].live];
    check('a connected room reports `joined.live: true`', liveAB.every((l) => l === true), liveAB);

    await fb.evaluate(() => window.__room.setState({ x: 0.25 }));
    await wait(fa, () => window.__ev.some((e) => e.type === 'state' && e.peer.state && e.peer.state.x === 0.25));
    const peerInMap = await fa.evaluate((id) => window.__room.peers.get(id), joinB.id);
    check('setState reaches the other player (event + peers map)', peerInMap && peerInMap.state && peerInMap.state.x === 0.25, peerInMap);

    const nStates = (await evs(fa, 'state')).length;
    await fb.evaluate(() => {
      for (let i = 0; i < 60; i++) window.__room.setState({ i });
    });
    await wait(fa, () => window.__ev.some((e) => e.type === 'state' && e.peer.state && e.peer.state.i === 59));
    await pageA.waitForTimeout(300);
    const burstEvents = (await evs(fa, 'state')).slice(nStates);
    if (process.env.ORB_TEST_VERBOSE) console.log('    burst states', JSON.stringify(burstEvents.map((e) => e.peer.state)));
    const burst = burstEvents.length;
    check('setState is throttled (~10/s) and the latest state wins', burst >= 1 && burst <= 4, `${burst} state events for 60 calls`);

    await fa.evaluate(() => window.__room.send({ hello: 'bob', n: [1, 2] }));
    await wait(fb, () => window.__ev.some((e) => e.type === 'message'));
    const msg = (await evs(fb, 'message'))[0];
    check('room.send delivers a message with the sender peer', msg.peer.id === selfA.id && JSON.stringify(msg.data) === '{"hello":"bob","n":[1,2]}', msg);

    // Hot-swap A's world: the new frame adopts the connection — B sees no leave/join flicker.
    const bEventsBefore = (await evs(fb)).length;
    fa = await load(pageA, world('A2'));
    await wait(fa, () => window.__ev.some((e) => e.type === 'joined'));
    const joinedA2 = (await evs(fa, 'joined'))[0];
    await pageA.waitForTimeout(2500); // past the old frame's removal + the room's close grace period
    const bAfter = (await evs(fb)).slice(bEventsBefore);
    check('swapped-in frame keeps the peer identity and sees the other player', joinedA2.self.id === selfA.id && joinedA2.peers.some((p) => p.id === joinB.id), joinedA2);
    check("…and the adopted room's `joined` is live", joinedA2.live === true, joinedA2.live);
    check('other players see no leave/join when a world is hot-swapped', !bAfter.some((e) => e.type === 'leave' || e.type === 'join'), bAfter.map((e) => e.type));

    await pageB.close();
    await wait(fa, (id) => window.__ev.some((e) => e.type === 'leave' && e.peer.id === id), joinB.id);
    check('closing a tab → `leave` for the other player', true);
    check('mock server traffic', mock.stats.joins >= 2 && mock.stats.broadcasts >= 2, mock.stats);
    await pageA.close();
  } finally {
    await mock.close();
  }
}

async function testNamedRooms(context) {
  const mock = await startMockRealtime();
  try {
    const WORLD = 'w-named-rooms';
    const open = (me, params = {}) => openRealtime(context, mock.url, { world: WORLD, me, ...params });
    // Each player joins the rooms listed in `names` ('' = the world's room) and logs every event.
    const world = (names) => doc(`<script>
window.__ev = {}; window.__rooms = {};
for (const n of ${JSON.stringify(names)}) { window.__ev[n] = []; window.__rooms[n] = window.orb.room.join((e) => window.__ev[n].push(JSON.parse(JSON.stringify(e))), { name: n }); }
</script>`);
    const joined = (frame, n) => wait(frame, (n) => window.__ev[n].some((e) => e.type === 'joined'), n);

    const pa = await open('alice');
    const fa = await load(pa, world(['match-1', '']));
    const pb = await open('bob');
    const fb = await load(pb, world(['match-1']));
    const pc = await open('carol');
    const fc = await load(pc, world(['match-2']));
    for (const [f, ns] of [[fa, ['match-1', '']], [fb, ['match-1']], [fc, ['match-2']]]) for (const n of ns) await joined(f, n);
    await fa.waitForFunction(() => [...window.__rooms['match-1'].peers.keys()].some((id) => id.startsWith('bob:')), null, { timeout: 8000, polling: 50 });
    await fb.evaluate(() => window.__rooms['match-1'].send({ gg: 1 }));
    await fa.waitForFunction(() => window.__ev['match-1'].some((e) => e.type === 'message'), null, { timeout: 8000, polling: 50 });
    await pa.waitForTimeout(600);
    const seen = await fa.evaluate(() => ({ match: [...window.__rooms['match-1'].peers.keys()], world: [...window.__rooms[''].peers.keys()], worldMsgs: window.__ev[''].filter((e) => e.type === 'message').length }));
    const carol = await fc.evaluate(() => [...window.__rooms['match-2'].peers.keys()]);
    check('a named room has only the people who joined it', seen.match.length === 1 && seen.match[0].startsWith('bob:') && carol.length === 0, { seen, carol });
    check("…and its messages stay out of the world's own room", seen.world.length === 0 && seen.worldMsgs === 0, seen);
    check('rooms are their own channels', mock.stats.joins >= 4, mock.stats);

    const replay = await fa.evaluate(
      () =>
        new Promise((resolve) => {
          const h = window.orb.room.join((e) => {
            if (e.type !== 'joined') return;
            resolve({ live: e.live, peers: e.peers.length });
            setTimeout(() => h.leave());
          }, { name: 'match-1' });
        }),
    );
    check("a second handle on a joined room gets the replayed `joined`, live and with its peers", replay.live === true && replay.peers === 1, replay);

    const bad = await fa.evaluate(() => {
      try {
        window.orb.room.join(() => {}, { name: 'no spaces!' });
        return 'joined';
      } catch (e) {
        return e.name;
      }
    });
    check('a bad room name → TypeError', bad === 'TypeError', bad);
    const limits = await fa.evaluate(() => {
      const out = [];
      for (const f of [() => window.orb.room.join(() => {}, 'match-1'), () => { for (const n of ['r1', 'r2', 'r3']) window.orb.room.join(() => {}, { name: n }); }]) {
        try { f(); out.push('ok'); } catch (e) { out.push(e.name); }
      }
      return out;
    });
    check('options must be an object; a fifth room at once → RangeError', limits.join() === 'TypeError,RangeError', limits);
    const url = await fa.evaluate(() => window.orb.room.invite('match-1'));
    const asked = await pa.evaluate(() => window.__orbHarness.events.filter((e) => e.type === 'invite').map((e) => e.data));
    check('room.invite asks Orb for a link to that room → the URL', url === 'https://orb.test/harness?room=match-1' && asked.join() === 'match-1', { url, asked });
    check('opened without an invite: orb.room.invited is null', (await fa.evaluate(() => window.orb.room.invited)) === null);

    // While the builder plays the world (a probe), a room it joins is solo: no ghost peer turns up in a real game.
    const probe = await pb.evaluate(() =>
      window.__orbHarness.probe({
        actions: [
          {
            type: 'eval',
            js: `new Promise((resolve) => { let j = null; const r = window.orb.room.join((e) => { if (e.type === 'joined') j = { live: e.live, peers: e.peers.length }; }, { name: 'match-2' });
              setTimeout(() => { resolve({ ...j, later: r.peers.size }); r.leave(); }, 1500); })`,
          },
        ],
      }),
    );
    const probed = JSON.parse(probe?.evals?.[0]?.result || 'null');
    await pc.waitForTimeout(800);
    const carolSaw = await fc.evaluate(() => ({ peers: window.__rooms['match-2'].peers.size, joins: window.__ev['match-2'].filter((e) => e.type === 'join').length }));
    check("a room joined during a probe is solo (`live: false`, nobody else in it)", probed && probed.live === false && probed.peers === 0 && probed.later === 0, probed ?? probe);
    check('…and the people really in that room never see the probe', carolSaw.peers === 0 && carolSaw.joins === 0, carolSaw);

    for (const p of [pa, pb, pc]) await p.close();

    const pi = await open('dave', { room: 'match-1' });
    const fi = await load(pi, doc('<p>invited</p>'));
    check('opened from an invite: orb.room.invited is that room', (await fi.evaluate(() => window.orb.room.invited)) === 'match-1');
    await pi.close();
    const pj = await open('erin', { room: 'bad room' });
    const fj = await load(pj, doc('<p>invited</p>'));
    check('a malformed invite room is ignored', (await fj.evaluate(() => window.orb.room.invited)) === null);
    await pj.close();
  } finally {
    await mock.close();
  }
}

async function testVisitors(context) {
  const mock = await startMockRealtime();
  try {
    const WORLD = 'w-visitors';
    const open = (me, extra = {}) => openRealtime(context, mock.url, { world: WORLD, me, ...extra });

    // --- orb.visitors.join: 2D-style, the world draws everyone itself ---
    const flat = doc(`<script>
window.__pos = { x: 0, y: 0, look: 'happy' };
window.__v = window.orb.visitors.join(() => window.__pos);
window.__log = [];
window.__v.on('join', (v) => window.__log.push('join:' + v.id));
window.__v.on('leave', (v) => window.__log.push('leave:' + v.id));
window.__room = window.orb.room.join(() => {});
</script>`);
    const pa = await open('alice');
    const fa = await load(pa, flat);
    const pb = await open('bob');
    const fb = await load(pb, flat);
    await wait(fa, () => window.__v.list.length === 1);
    const first = await fa.evaluate(() => ({ ...window.__v.list[0], count: window.__v.count }));
    check('join: the other player shows up in visitors.list with name and color', first.id.startsWith('bob:') && first.name === 'Dev Player' && first.color === '#8b7bff' && first.count === 1 && first.look === 'happy', first);

    await fb.evaluate(() => { window.__pos = { x: 5, y: 2, look: 'wave' }; });
    await wait(fa, () => Math.abs(window.__v.list[0].x - 5) < 0.05 && Math.abs(window.__v.list[0].y - 2) < 0.05);
    const moved = await fa.evaluate(() => ({ x: window.__v.list[0].x, look: window.__v.list[0].look }));
    check('their moves arrive, smoothed to where they are; other fields as sent', moved.look === 'wave', moved);

    // Walking at a steady 4 units/s: between updates they're carried on at that speed.
    await fb.evaluate(() => { const t0 = performance.now(); window.__walk = setInterval(() => { window.__pos = { x: 5 + ((performance.now() - t0) / 1000) * 4, y: 2 }; }, 30); });
    await pa.waitForTimeout(1500);
    const walking = await fa.evaluate(() => { const v = window.__v.list[0]; return { x: v.x, vx: v.vx }; });
    const truth = await fb.evaluate(() => window.__pos.x);
    check('a walking visitor moves at their speed and stays close to where they really are', walking.vx > 3 && walking.vx < 5 && Math.abs(walking.x - truth) < 1.6, { walking, truth });
    await fb.evaluate(() => { clearInterval(window.__walk); window.__pos = { x: 20, y: 2 }; });
    await wait(fa, () => Math.abs(window.__v.list[0].x - 20) < 0.05);
    await pa.waitForTimeout(1200);
    const stopped = await fa.evaluate(() => window.__v.list[0].x);
    check('…and stop where they stopped (no drifting on)', Math.abs(stopped - 20) < 0.05, stopped);
    check('a field they stopped sending is gone, not stuck at its last value', await fa.evaluate(() => !('look' in window.__v.list[0])));

    // The world's own room state and the pose travel together.
    await fb.evaluate(() => window.__room.setState({ score: 3 }));
    await wait(fa, () => [...window.__room.peers.values()].some((p) => p.state && p.state.score === 3 && p.state._p && p.state._p.x === 20));
    await fb.evaluate(() => { window.__pos = { x: 21, y: 2 }; });
    await wait(fa, () => Math.abs(window.__v.list[0].x - 21) < 0.05);
    const both = await fa.evaluate(() => [...window.__room.peers.values()][0].state);
    check("the world's own room.setState and the pose don't overwrite each other", both.score === 3 && both._p.x === 21, both);

    await fb.evaluate(() => { window.__pos = null; });
    await wait(fa, () => window.__v.list.length === 0);
    check('a pose of null hides you (count still knows they are here)', (await fa.evaluate(() => window.__v.count)) === 1);
    await fb.evaluate(() => { window.__pos = { x: 1, y: 1 }; });
    await wait(fa, () => window.__v.list.length === 1);
    await pb.close();
    await wait(fa, () => window.__v.list.length === 0 && window.__v.count === 0);
    const log = await fa.evaluate(() => window.__log);
    check("on('join'/'leave') follow them appearing and going", log.filter((l) => l.startsWith('join:')).length === 2 && log.filter((l) => l.startsWith('leave:')).length === 2, log);
    const errs = await fa.evaluate(() => {
      const out = [];
      for (const f of [() => window.orb.visitors.join(), () => window.orb.visitors.join(() => ({}), 'x'), () => window.orb.visitors.show({}), () => window.__v.on('wave', () => {})]) {
        try { f(); out.push('ok'); } catch (e) { out.push(e.name); }
      }
      return out;
    });
    check('bad arguments → TypeError with a hint', errs.join() === 'TypeError,TypeError,TypeError,TypeError', errs);
    await pa.close();

    // --- orb.visitors.show: three.js, a character per visitor + a name tag ---
    const three = (extra = '') =>
      doc(
        `<script type="module">
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#bfe5f3');
scene.add(new THREE.HemisphereLight('#ffffff', '#446644', 2));
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, 3, 9); camera.lookAt(0, 1, 0);
const player = new THREE.Group();
const body = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial({ color: '#ff8a78' }));
body.position.y = 1; player.add(body); scene.add(player);
renderer.setAnimationLoop(() => renderer.render(scene, camera));
window.__scene = scene; window.__player = player; window.__camera = camera;
window.__show = window.orb.visitors.show({ THREE, scene, camera, player${extra} });
</script>`,
        THREE_HEAD,
      );
    const avatars = (frame) => frame.evaluate(() => window.__scene.children.filter((c) => c.isGroup && c !== window.__player).map((g) => ({ x: g.position.x, y: g.position.y, z: g.position.z, ry: g.rotation.y, meshes: (() => { let n = 0; g.traverse((o) => { if (o.isMesh) n++; }); return n; })() })));
    const tags = (frame) => frame.evaluate(() => [...document.querySelectorAll('[data-orb-visitors] > div')].map((el) => ({ text: el.textContent, shown: el.style.display === 'flex', transform: el.style.transform })));

    const qa = await open('alice');
    const ta = await load(qa, three());
    const qb = await open('bob');
    const tb = await load(qb, three());
    await wait(ta, () => window.__scene.children.some((c) => c.isGroup && c !== window.__player));
    const av = (await avatars(ta))[0];
    check('show: the other player appears as a character in the scene, standing where they are', av && av.meshes >= 5 && Math.abs(av.y) < 0.05 && Math.abs(av.x) < 0.05, av);
    await wait(ta, () => [...document.querySelectorAll('[data-orb-visitors] > div')].some((el) => el.style.display === 'flex'));
    const tag = (await tags(ta))[0];
    check('…with a name tag over its head', tag && tag.text.includes('Dev Player') && /translate\(\d+px, ?\d+px\)/.test(tag.transform), tag);

    await tb.evaluate(() => { window.__player.position.set(2, 0.5, -1); window.__player.rotation.y = 1.2; });
    await wait(ta, () => { const g = window.__scene.children.find((c) => c.isGroup && c !== window.__player); return g && Math.abs(g.position.x - 2) < 0.05 && Math.abs(g.position.z + 1) < 0.05 && Math.abs(g.rotation.y - 1.2) < 0.05; });
    const av2 = (await avatars(ta))[0];
    check('their character follows where they go and which way they face (feet on the ground)', Math.abs(av2.y - 0.5) < 0.05, av2);

    await tb.evaluate(() => { window.__player.visible = false; });
    await wait(ta, () => !window.__scene.children.some((c) => c.isGroup && c !== window.__player));
    check('a hidden character is hidden for others too', (await tags(ta)).length === 0);
    await tb.evaluate(() => { window.__player.visible = true; });
    await wait(ta, () => window.__scene.children.some((c) => c.isGroup && c !== window.__player));
    await tb.evaluate(() => window.__show.leave());
    await wait(ta, () => !window.__scene.children.some((c) => c.isGroup && c !== window.__player));
    check('leave() takes them out of the world, name tag and all', (await tags(ta)).length === 0);
    await qb.close();

    // Your own character model for visitors: avatar(v) → Object3D (placed like your player).
    const qc = await open('carol');
    const tc = await load(qc, three(`, avatar: (v) => { const m = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2), new THREE.MeshStandardMaterial({ color: v.color })); m.name = 'cone:' + v.name; return m; }`));
    const qd = await open('dave');
    await load(qd, three());
    await wait(tc, () => { let found = false; window.__scene.traverse((o) => { if (o.name === 'cone:Dev Player') found = true; }); return found; });
    check('avatar(v) gives visitors your own character model', true);
    // Two visitors standing in the same spot: their name tags step apart instead of covering each other.
    const qe = await open('erin');
    const te = await load(qe, three());
    await wait(te, () => [...document.querySelectorAll('[data-orb-visitors] > div')].filter((el) => el.style.display === 'flex').length >= 2);
    await qe.waitForTimeout(300);
    const ys = (await tags(te)).filter((t) => t.shown).map((t) => Number(/translate\(-?\d+px, ?(-?\d+)px\)/.exec(t.transform)?.[1])).sort((p, q) => p - q);
    check('visitors in one spot: their name tags don’t cover each other', ys.length >= 2 && ys.every((y, i) => !i || y - ys[i - 1] >= 22), ys);
    await qe.close();
    await qc.close();
    await qd.close();
    await qa.close();

    // Someone flying around (a free camera: pose() with fly: true) is a glowing orb where they are, not a character.
    const flyer = await open('fay');
    const tf = await load(flyer, three(', pose: () => window.__pose'));
    const viewer = await open('gus');
    const tg = await load(viewer, three());
    const look = () => tg.evaluate(() => {
      const g = window.__scene.children.find((c) => c.isGroup && c !== window.__player);
      if (!g) return null;
      const orb = g.getObjectByName('orb-flying'), rig = g.children.find((c) => c.isGroup && c.name !== 'orb-flying');
      const tag = [...document.querySelectorAll('[data-orb-visitors] > div')][0];
      return { x: g.position.x, y: g.position.y, z: g.position.z, orb: !!orb && orb.visible, character: !!rig && rig.visible, tag: !!tag && tag.style.display === 'flex' };
    });
    await tf.evaluate(() => { window.__pose = { x: 1.5, y: 3.5, z: -2, ry: 0.5, fly: true }; });
    await wait(tg, () => { const g = window.__scene.children.find((c) => c.isGroup && c !== window.__player); const o = g && g.getObjectByName('orb-flying'); return o && o.visible && Math.abs(g.position.y - 3.5) < 0.05; });
    await viewer.waitForTimeout(300);
    const flying = await look();
    check('flying (fly: true): an orb up where they are, no character, name tag on', flying && flying.orb && !flying.character && flying.tag && Math.abs(flying.x - 1.5) < 0.05 && Math.abs(flying.z + 2) < 0.05, flying);
    await viewer.screenshot({ path: path.join(root, '.data', 'visitors-flying-orb.png') });
    await tf.evaluate(() => { window.__pose = { x: 1.5, y: 0, z: -2, ry: 0.5 }; });
    await wait(tg, () => { const g = window.__scene.children.find((c) => c.isGroup && c !== window.__player); const o = g && g.getObjectByName('orb-flying'); return o && !o.visible && Math.abs(g.position.y) < 0.05; });
    const landed = await look();
    check('…landed: their character again, on the ground', landed && !landed.orb && landed.character && landed.tag, landed);
    const flyErrors = [...(await eventsOf(flyer, 'error')), ...(await eventsOf(viewer, 'error'))];
    check('…no errors either side', flyErrors.length === 0, flyErrors);
    await flyer.close();
    await viewer.close();

    // What someone's blob wears on Orb (their look) comes with them: the others see it on their blob.
    const dressed = await open('hal', { wears: 'crown,shades', color: '#5ec8ff' });
    const th = await load(dressed, three());
    const onlooker = await open('ivy');
    const ti = await load(onlooker, three());
    const mine = await th.evaluate(() => [...window.orb.me.wears]);
    check('orb.me.wears: what your blob wears', mine.join() === 'crown,shades', mine);
    await wait(ti, () => { let n = 0; window.__scene.traverse((o) => { if (o.name === 'orb-look:crown' || o.name === 'orb-look:shades') n++; }); return n === 2; });
    const seen = await ti.evaluate(() => {
      const v = window.__show.list[0];
      return { wears: v && [...v.wears], color: v && v.color };
    });
    check('…the others see it on your blob (a crown and shades, v.wears), in your color', seen.wears?.join() === 'crown,shades' && seen.color === '#5ec8ff', seen);
    await dressed.evaluate(() => window.__orbHarness.setWears(['halo']));
    await wait(ti, () => { const names = []; window.__scene.traverse((o) => { if (o.name.startsWith('orb-look:')) names.push(o.name); }); return names.join() === 'orb-look:halo'; }, undefined, 12_000);
    check('…changing it while there: the others see the new one (a halo, the crown and shades gone)', true);
    const lookErrors = [...(await eventsOf(dressed, 'error')), ...(await eventsOf(onlooker, 'error'))];
    check('…no errors either side', lookErrors.length === 0, lookErrors);
    await dressed.close();
    await onlooker.close();

    // A world showing everyone here with orb.visitors: the other explorer walks there as a buddy with a name tag.
    const island = `<!doctype html><html><body style="margin:0"><script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js"}}</script><script type="module">
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer(); renderer.setSize(innerWidth, innerHeight); document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100), player = new THREE.Object3D();
camera.position.set(0, 4, 8); camera.lookAt(0, 0, 0); scene.add(player);
orb.visitors.show({ THREE, scene, camera, player, avatar: () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshNormalMaterial()) });
renderer.setAnimationLoop(() => renderer.render(scene, camera));
</script></body></html>`;
    const ia = await open('alice');
    const fia = await load(ia, island, { timeout: 60_000 });
    const ib = await open('bob');
    await load(ib, island, { timeout: 60_000 });
    await wait(fia, () => [...document.querySelectorAll('[data-orb-visitors] > div')].some((el) => el.style.display === 'flex' && el.textContent.includes('Dev Player')), undefined, 20_000);
    const islandErrors = [...(await eventsOf(ia, 'error')), ...(await eventsOf(ib, 'error'))];
    check('orb.visitors: the other explorer shows up as a buddy with their name, no errors', islandErrors.length === 0, islandErrors);
    await ia.close();
    await ib.close();
  } finally {
    await mock.close();
  }
}

async function testFriendsInRooms(context) {
  const mock = await startMockRealtime();
  try {
    const WORLD = 'w-friends-here';
    const open = (me) => openRealtime(context, mock.url, { world: WORLD, me });
    const world = doc(`<script>
window.__v = window.orb.visitors.join(() => ({ x: 1, y: 2 }));
window.__room = window.orb.room.join(() => {});
</script>`);
    const people = async (page) => (await eventsOf(page, 'people')).at(-1);

    const pa = await open('alice');
    const fa = await load(pa, world);
    const beforeBob = Date.now() - 1;
    const pb = await open('bob');
    await load(pb, world);
    await wait(fa, () => window.__v.list.length === 1);
    const bob = await fa.evaluate(() => window.__v.list[0].id);
    check('a stranger is not a friend', (await fa.evaluate(() => window.__v.list[0].friend)) === false && (await people(pa))?.count === 1 && (await people(pa))?.friends === 0, await people(pa));

    await pa.evaluate((id) => window.__orbHarness.setFriendPeers([id]), bob);
    await wait(fa, () => window.__v.list[0]?.friend === true && window.__room.peers.get(window.__v.list[0].id)?.friend === true);
    await pa.waitForTimeout(100);
    check('a friend the sync vouches for is a friend in the world (visitors and room.peers)', (await people(pa))?.friends === 1, await people(pa));

    await pa.evaluate(([id, t]) => window.__orbHarness.setFriendPeers([id], t), [bob, beforeBob]);
    await wait(fa, () => window.__v.list[0]?.friend === false);
    check('…not by an answer asked before they came in', true);

    await pa.evaluate((id) => window.__orbHarness.setFriendPeers([id]), bob);
    await wait(fa, () => window.__v.list[0]?.friend === true);
    mock.fakePresence(`:${WORLD}`, bob);
    await wait(fa, () => window.__room.peers.get(window.__v.list[0].id)?.friend === false);
    check('two connections holding a friend’s peer id: neither counts as the friend', true);
    mock.dropFake(bob);
    await wait(fa, () => window.__v.list[0]?.friend === true);
    check('…and the friend is back once only they hold it', true);

    await pb.close();
    await wait(fa, () => window.__v.count === 0);
    mock.fakePresence(`:${WORLD}`, bob, { name: 'Bob', state: { _p: { x: 1, y: 2 } } });
    await wait(fa, () => window.__v.list.length === 1);
    check('someone reusing a friend’s peer id after they left is a stranger', (await fa.evaluate(() => window.__v.list[0].friend)) === false);
    mock.dropFake(bob);
    await wait(fa, () => window.__v.count === 0);
    check('the world bar hears everyone go', (await people(pa))?.count === 0, await people(pa));
    await pa.close();
  } finally {
    await mock.close();
  }
}

async function testShop(context) {
  const items = [{ id: 'star-hat', name: 'Star Hat', price: 40 }, { id: 'boots', name: 'Boots', price: 10 }];
  const world = doc('<p>shop</p>', `<script type="application/json" id="orb-shop">${JSON.stringify({ items })}</script>`);
  const draftPage = await openHarness(context);
  let f = await load(draftPage, world);
  const draft = await f.evaluate(async () => ({ buy: await window.orb.shop.buy('star-hat'), items: await window.orb.shop.items(), owned: await window.orb.shop.owned() }));
  check('a draft sells nothing: buy → not_saved, empty lists', draft.buy.ok === false && draft.buy.reason === 'not_saved' && draft.buy.item === 'star-hat' && draft.items.length === 0 && draft.owned.length === 0, draft);
  check('…and the player is never asked', (await count(draftPage, 'purchase')) === 0);
  const bad = await f.evaluate(() => window.orb.shop.buy('Not An Id').then(() => 'resolved', (e) => e.name));
  check('an id that can’t be an item → TypeError', bad === 'TypeError', bad);
  await draftPage.close();

  // A saved world: Orb has its copy, so the list comes from Orb.
  const made = await fetch(`${BASE}/api/worlds`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orb-device': `test-runtime-shop-${Date.now().toString(36)}` }, body: JSON.stringify({ code: world, name: 'Runtime shop' }) }).then((r) => r.json());
  const page = await openHarness(context, { world: made.world.id });
  f = await load(page, world);
  const listed = await f.evaluate(async () => ({ items: await window.orb.shop.items(), owned: await window.orb.shop.owned() }));
  check('a saved world: what it sells comes from Orb’s copy', listed.items.map((i) => `${i.id}:${i.price}`).join() === 'star-hat:40,boots:10' && listed.owned.length === 0, listed);
  const r = await f.evaluate(() => window.orb.shop.buy('star-hat'));
  check('buy: Orb asks the player, the world hears the answer', r.ok === true && r.item === 'star-hat' && !('reason' in r) && (await eventsOf(page, 'purchase')).join() === 'star-hat', r);
  await page.evaluate(() => Object.assign(window.__orbHarness, { shopAnswer: { ok: false, reason: 'cancelled' }, shopDelay: 400 }));
  const two = await f.evaluate(() => Promise.all([window.orb.shop.buy('boots'), window.orb.shop.buy('star-hat')]));
  check('one at a time: a second ask while one is open → busy; a no → its reason', two[0].ok === false && two[0].reason === 'cancelled' && two[1].ok === false && two[1].reason === 'busy' && (await count(page, 'purchase')) === 2, two);
  const look = await page.evaluate(() => window.__orbHarness.probe({ actions: [{ type: 'eval', js: 'return window.orb.shop.buy("boots")' }] }));
  check('while the builder plays the world nothing is bought → looking', /looking/.test(JSON.stringify(look?.evals ?? look)) && (await count(page, 'purchase')) === 2, look?.evals ?? look);
  await page.close();
}

async function testClips(context) {
  const page = await openHarness(context, { world: 'w-clips' });
  await load(page, threeWorld('#2a6fdb'));
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => window.__orbHarness.clip(1500, 'orb.test/clips'));
  check('a clip of a three.js world: a video', !r.error && /^video\/(webm|mp4)$/.test(r.type) && r.size > 2000, r.error ? r : { type: r.type, size: r.size });
  if (!r.error) {
    const v = await page.evaluate(async (url) => {
      const el = document.createElement('video');
      el.muted = true;
      el.src = url;
      document.body.appendChild(el);
      await new Promise((res, rej) => {
        el.onloadeddata = res;
        el.onerror = () => rej(new Error('video error'));
        setTimeout(() => rej(new Error('video timeout')), 8000);
      });
      return { w: el.videoWidth, h: el.videoHeight };
    }, r.url);
    check('…that plays, at the canvas’ aspect (at most 1280 px)', v.w > 0 && v.h > 0 && Math.abs(v.w / v.h - 480 / 300) < 0.05 && Math.max(v.w, v.h) <= 1280, v);
  }
  const busy = await page.evaluate(async () => {
    const a = window.__orbHarness.clip(1200);
    const b = await window.__orbHarness.clip(1200);
    await a;
    return b.error ?? 'ok';
  });
  check('one clip at a time (a second one meanwhile → busy)', busy === 'busy', busy);
  await load(page, doc('<h1>No canvas here</h1>'));
  const none = await page.evaluate(() => window.__orbHarness.clip(1000));
  check('a world without a canvas → no_canvas', none.error === 'no_canvas', none);
  await page.close();
}

// ------------------------------------------------------------------------------------------

const server = await ensureServer();
const browser = await launch();
try {
  const context = await newContext(browser);
  await section('Injection', () => testInjection(context));
  await section('(a) localStorage shim + persistence', () => testStorage(context));
  await section('world id changes', () => testWorldIdChange(context));
  await section('(b) error reporting', () => testErrors(context));
  await section('(c) capture', () => testCapture(context));
  await section('(c1) workers and history', () => testWorkers(context));
  await section('(c2) probe: play the world and look at it', () => testProbe(context));
  await section('(c3) probe on a phone-sized screen', () => testPhoneLook(browser));
  await section('(d) double-buffered swap', () => testSwap(context));
  await section('(e) orb.store', () => testStore(context));
  await section('(f) isolation', () => testIsolation(context));
  await section('room (solo)', () => testRoom(context));
  await section('room (multiplayer via mock realtime server)', () => testMultiplayer(context));
  await section('named rooms + invites (mock realtime server)', () => testNamedRooms(context));
  await section('visitors: everyone who is here, in the world (mock realtime server)', () => testVisitors(context));
  await section('friends in the room: vouched by the friends sync (mock realtime server)', () => testFriendsInRooms(context));
  await section('clips: a few seconds of the world as a video', () => testClips(context));
  await section('shop: orb.shop asks Orb, which asks the player', () => testShop(context));
} finally {
  await browser.close();
  await stopNext(server);
}

finish();
