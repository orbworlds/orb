// The agent's checks on its own work: problems found after each change (src/server/agent/check.ts),
// play-test actions and results (src/lib/probe.ts), and looks at the world in a watching page
// (src/server/agent/look.ts, against an in-memory PGlite with the app's schema).
import { register } from 'node:module';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DDL } from '../../../server/ddl.mjs';

// Only the module resolution of ./setup.mjs: its browser globals would confuse PGlite.
register('./resolve-hooks.mjs', import.meta.url);

const { problemsAfterChange } = await import('../../../server/agent/check.ts');
const { cleanProbeActions, cleanProbeResult, probeDuration, PROBE_LIMITS } = await import('../../probe.ts');
const look = await import('../../../server/agent/look.ts');

/** A world's files for the checks: path → text. */
function files(map) {
  return { files: Object.fromEntries(Object.keys(map).map((p) => [p, `sha-${p}`])), read: async (p) => (p in map ? map[p] : null) };
}

const PAGE = (body = '<script type="module" src="./src/main.js"></script>') =>
  `<!doctype html>\n<html>\n<head>\n<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/"}}</script>\n<link rel="stylesheet" href="./style.css">\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

describe('checks after a change', () => {
  test('a clean world has no problems', async () => {
    const w = files({
      'index.html': PAGE(),
      'style.css': 'body{}',
      'src/main.js': "import * as THREE from 'three';\nimport { OrbitControls } from 'three/addons/controls/OrbitControls.js';\nimport { makeWorld, CONFIG } from './world.js';\nimport hud from './hud.js';\nmakeWorld(THREE, OrbitControls, hud, CONFIG);\n",
      'src/world.js': 'export const CONFIG = { a: 1 };\nexport function makeWorld() {}\nexport const { x, y: [z] } = { x: 1, y: [2] };\n',
      'src/hud.js': 'export default function hud() {}\n',
    });
    assert.equal(await problemsAfterChange(w, ['src/main.js']), '');
  });

  test('syntax errors, with file, line and column', async () => {
    const w = files({ 'index.html': PAGE(), 'style.css': '', 'src/main.js': 'const a = 1;\nconst b = ;\n' });
    const p = await problemsAfterChange(w, ['src/main.js']);
    assert.match(p, /src\/main\.js:2:11 SyntaxError: Unexpected token/);
  });

  test('imports of missing files and names, missing extensions, root paths, unmapped bare names', async () => {
    const w = files({
      'index.html': PAGE(),
      'style.css': '',
      'src/main.js': [
        "import { makeWorld, nope } from './world.js';",
        "import hud from './hud.js';",
        "import { a } from './util';",
        "import { b } from '/src/abs.js';",
        "import { c } from './later.js';",
        "import { Sky } from 'three-sky';",
        "export { d } from './world.js';",
      ].join('\n'),
      'src/world.js': 'export function makeWorld() {}\nexport const CONFIG = {};\n',
      'src/hud.js': 'export const hud = 1;\n',
      'src/util.js': 'export const a = 1;\n',
    });
    const p = await problemsAfterChange(w, ['src/main.js']);
    assert.match(p, /src\/main\.js:1 imports nope from "\.\/world\.js", but src\/world\.js doesn't export it \(it exports: makeWorld, CONFIG\)/);
    assert.match(p, /src\/main\.js:2 imports a default export from "\.\/hud\.js"/);
    assert.match(p, /src\/main\.js:3 imports "\.\/util" — browsers don't add file extensions: write "\.\/util\.js"/);
    assert.match(p, /src\/main\.js:4 imports "\/src\/abs\.js" — a path from the site's root/);
    assert.match(p, /src\/main\.js:5 imports "\.\/later\.js", but there's no file src\/later\.js \(yet\)/);
    assert.match(p, /src\/main\.js:6 imports "three-sky", which is neither a relative path .* nor in index\.html's import map \(it maps: three, three\/addons\/\)/);
    assert.match(p, /src\/main\.js:7 imports d from "\.\/world\.js"/);
  });

  test('changing a module checks the files that import it', async () => {
    const w = files({ 'index.html': PAGE(), 'style.css': '', 'src/main.js': "import { spin } from './world.js';\nspin();\n", 'src/world.js': 'export function turn() {}\n' });
    assert.match(await problemsAfterChange(w, ['src/world.js']), /src\/main\.js:1 imports spin from "\.\/world\.js", but src\/world\.js doesn't export it \(it exports: turn\)/);
    // Deleted: its importers now point at nothing.
    const gone = files({ 'index.html': PAGE(), 'style.css': '', 'src/main.js': "import { spin } from './world.js';\n" });
    assert.match(await problemsAfterChange(gone, ['src/world.js']), /src\/main\.js:1 imports "\.\/world\.js", but there's no file src\/world\.js/);
  });

  test('pages: inline scripts (with page line numbers), the import map, missing files', async () => {
    const html = '<!doctype html>\n<html>\n<head>\n<script type="importmap">{"imports": {"three": }}</script>\n<link rel="stylesheet" href="./missing.css">\n<script src="/abs.js"></script>\n</head>\n<body>\n<img src="./assets/logo.png">\n<script>\nvar ok = 1;\nvar broken = ;\n</script>\n<script type="module">\nimport { x } from "./src/x.js";\n</script>\n</body>\n</html>\n';
    const w = files({ 'index.html': html, 'src/x.js': 'export const y = 1;' });
    const p = await problemsAfterChange(w, ['index.html']);
    assert.match(p, /index\.html:4 the import map is not valid JSON/);
    assert.match(p, /index\.html:5 loads stylesheet "\.\/missing\.css", but there's no file missing\.css/);
    assert.match(p, /index\.html:6 loads "\/abs\.js" — a path from the site's root/);
    assert.match(p, /index\.html:9 loads img "\.\/assets\/logo\.png", but there's no file assets\/logo\.png/);
    assert.match(p, /index\.html:12:\d+ SyntaxError/);
    assert.match(p, /index\.html:15 imports x from "\.\/src\/x\.js", but src\/x\.js doesn't export it/);
  });

  test('JSON files', async () => {
    const w = files({ 'index.html': PAGE(''), 'data/levels.json': '{"a": [1, 2,]}' });
    assert.match(await problemsAfterChange(w, ['data/levels.json']), /data\/levels\.json: not valid JSON/);
  });

  test('no false alarms: tags inside scripts, URLs built in code, classic scripts', async () => {
    const page = PAGE('<script src="./game.js"></script>\n<img src="{{ logo }}">\n<script>\nconst img = \'<img src="img/\' + n + \'.png">\';\n</script>\n<template><img src="./later.png"></template>');
    const w = files({ 'index.html': page, 'style.css': '', 'game.js': 'with (Math) { var r = sqrt(2); }\nvar arr = [1, 2];\n' });
    assert.equal(await problemsAfterChange(w, ['index.html']), '');
    assert.equal(await problemsAfterChange(w, ['game.js']), '');
  });

  test('commented-out scripts are ignored', async () => {
    const w = files({ 'index.html': PAGE('<!-- <script src="./old.js"></script> -->'), 'style.css': '' });
    assert.equal(await problemsAfterChange(w, ['index.html']), '');
  });
});

describe('probe actions', () => {
  test('well-formed actions pass, numbers are clamped, junk is skipped', () => {
    const { actions, skipped } = cleanProbeActions([
      { type: 'key', key: 'w', ms: 99999 },
      { type: 'key', key: 'a', times: 100 },
      { type: 'click', x: 2, y: -1, button: 'right', touch: 'yes' },
      { type: 'move', dx: '50', dy: 0 },
      { type: 'drag', x: 0.1, y: 0.2, to_x: 0.9, to_y: 0.2 },
      { type: 'eval', js: '   ' },
      { type: 'fly' },
      'nope',
      { type: 'screenshot', label: 'x'.repeat(100) },
    ]);
    assert.equal(skipped, 3);
    assert.deepEqual(actions[0], { type: 'key', key: 'w', ms: PROBE_LIMITS.ms });
    assert.deepEqual(actions[1], { type: 'key', key: 'a', ms: 120, times: 30 });
    assert.deepEqual(actions[2], { type: 'click', x: 1, y: 0, button: 'right' });
    assert.deepEqual(actions[3], { type: 'move', dx: 50, dy: 0, ms: 0 });
    assert.equal(actions[5].label.length, 60);
  });

  test('a screenshot can zoom into part of the screen, kept on screen and at least 5% wide', () => {
    const { actions } = cleanProbeActions([
      { type: 'screenshot', label: 'smoke', zoom: { x: 0.4, y: 0.1, w: 0.2, h: 0.25 } },
      { type: 'screenshot', zoom: { x: 0.95, y: -1, w: 0.01, h: 0.5 } },
      { type: 'screenshot', zoom: { w: 1, h: 1 } },
      { type: 'screenshot', zoom: 'big' },
    ]);
    assert.deepEqual(actions[0], { type: 'screenshot', label: 'smoke', zoom: { x: 0.4, y: 0.1, w: 0.2, h: 0.25 } });
    assert.deepEqual(actions[1].zoom, { x: 0.95, y: 0, w: 0.05, h: 0.5 });
    assert.equal('zoom' in actions[2], false, 'the whole screen is a plain screenshot');
    assert.equal('zoom' in actions[3], false);
  });

  test('a look stays within its time budget', () => {
    const { actions, skipped } = cleanProbeActions([...Array.from({ length: 10 }, () => ({ type: 'wait', ms: 7000 })), { type: 'screenshot' }]);
    assert.equal(actions.length, 6, 'five waits fit, and the screenshot after them');
    assert.equal(skipped, 5);
    assert.equal(actions[5].type, 'screenshot');
    assert.ok(probeDuration(actions) <= PROBE_LIMITS.totalMs + 2000);
  });

  test('results from a page are cleaned', () => {
    const r = cleanProbeResult({
      size: { w: 390.4, h: 844, dpr: 3 },
      fps: 1e9,
      errors: [{ message: 'x'.repeat(900), line: 'a', t: 5, during: 1 }],
      logs: [{ level: 'shout', text: 'hi' }],
      ui: Array.from({ length: 100 }, () => ({ text: 'a', x: 5 })),
      shots: [{ label: 'end', dataUrl: 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4' }, { dataUrl: 'javascript:alert(1)' }, { dataUrl: 'data:image/svg+xml;base64,AAAA' }, { dataUrl: 'data:image/png;base64,AAAAAAAAAAAAAAAAAAAA' }],
      evals: [{ js: 'a', result: 1 }],
      notes: ['n', 7],
      extra: 'dropped',
    });
    assert.deepEqual(r.size, { w: 390, h: 844, dpr: 3 });
    assert.equal(r.fps, 1000);
    assert.equal(r.errors[0].message.length, 500);
    assert.equal(r.errors[0].during, false);
    assert.equal(r.logs[0].level, 'log');
    assert.equal(r.ui.length, 60);
    assert.equal(r.ui[0].x, 2);
    assert.deepEqual(r.shots.map((s) => s.dataUrl), ['data:image/webp;base64,UklGRiQAAABXRUJQVlA4', null, null, null], 'only real images');
    assert.equal(r.evals[0].result, '');
    assert.deepEqual(r.notes, ['n']);
    assert.equal('extra' in r, false);
  });
});

const RESULT = cleanProbeResult({
  size: { w: 390, h: 844, dpr: 3 },
  title: 'Sky Hopper',
  uptime: 4200,
  fps: 18,
  errors: [
    { message: "TypeError: Cannot read properties of undefined (reading 'x')", line: 42, source: 'https://orb.test/api/tree/' + 'a'.repeat(64) + '/src/player.js', t: 3000, during: true },
    { message: 'Failed to load module', line: 7, t: 100, during: false },
  ],
  logs: [{ level: 'warn', text: 'careful', t: 10 }],
  dropped: 4,
  ui: [
    { text: 'Score: 0', x: 0.02, y: 0.02, w: 0.2, h: 0.04, tag: 'div', click: false },
    { text: 'Play', x: 0.4, y: 0.55, w: 0.2, h: 0.06, tag: 'button', click: true },
  ],
  canvas: { w: 1170, h: 2532, type: 'webgl2', cover: 1 },
  focus: 'page',
  locked: true,
  shots: [
    { label: 'start', t: 3000, dataUrl: 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4' },
    { label: 'score', t: 3500, dataUrl: 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4', zoom: { x: 0, y: 0, w: 0.3, h: 0.1 } },
    { label: 'end', t: 4100, dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ', flat: true },
  ],
  evals: [{ js: 'player.y', result: '1.5' }],
  notes: ['Skipped a screenshot.'],
});

describe('what the model reads', () => {
  test('the look as text, and its screenshots', () => {
    const { text, images } = look.formatLook('LOOK123', RESULT, 1);
    assert.match(text, /390×844 px \(phone-sized, 3× pixel density\), running for 4\.2 s, page title "Sky Hopper"/);
    assert.match(text, /1 action was skipped/);
    assert.match(text, /Frame rate: 18 fps — low/);
    assert.match(text, /webgl2, 1170×2532, covering 100% of the screen/);
    assert.match(text, /pointer lock/);
    assert.match(text, /1\. TypeError: Cannot read properties of undefined \(reading 'x'\) — src\/player\.js:42 \(at 3\.0 s, while playing\)/);
    assert.match(text, /2\. Failed to load module — index\.html:7 \(at 0\.1 s\)/);
    assert.match(text, /\[warn\] careful/);
    assert.match(text, /4 more were too many to keep/);
    assert.match(text, /- "Score: 0" top left \(x 0\.02–0\.22, y 0\.02–0\.06\)/);
    assert.match(text, /- \[button\] "Play" center/);
    assert.match(text, /eval "player\.y" → 1\.5/);
    assert.match(text, /"score" at 3\.5 s \(zoomed into x 0\.00–0\.30, y 0\.00–0\.10\)/);
    assert.match(text, /"end" at 4\.1 s \(one flat color — nothing visible!\)/);
    assert.deepEqual(images, [
      { ref: 'orb-look:LOOK123:0', mediaType: 'image/webp', label: 'start' },
      { ref: 'orb-look:LOOK123:1', mediaType: 'image/webp', label: 'score' },
      { ref: 'orb-look:LOOK123:2', mediaType: 'image/jpeg', label: 'end' },
    ]);
  });

  test('a world drawn in software: its low frame rate is no reason to take things out', () => {
    const { text } = look.formatLook('L', { ...RESULT, software: true }, 0);
    assert.match(text, /Frame rate: 18 fps — this browser draws the world in software \(it has no graphics chip to use\), so it runs far slower here than on a real phone or laptop: judge the speed by the code/);
    assert.doesNotMatch(text, /low: something is too heavy/);
    assert.match(look.formatLook('L', { ...RESULT, fps: 60, software: true }, 0).text, /Frame rate: 60 fps \(drawn in software, without a graphics chip\)\./);
    assert.match(look.formatLook('L', RESULT, 0).text, /Frame rate: 18 fps — low: something is too heavy/);
    assert.equal(cleanProbeResult({ ...RESULT, software: true }).software, true);
    assert.equal('software' in cleanProbeResult({ ...RESULT, software: 'yes' }), false, 'only a real true');
  });

  test('a Cursor agent gets the same look as files: the report, and the screenshots named by order and label', () => {
    const r = { ...RESULT, shots: [...RESULT.shots, { label: 'lost', t: 4200, dataUrl: null }] };
    const out = look.seenFiles('LOOK123', r, 1, 120);
    assert.deepEqual(out.map((f) => f.name), ['report.txt', '1-start.webp', '2-score.webp', '3-end.jpg']);
    const report = out[0].data.toString();
    assert.ok(report.startsWith(look.formatLook('LOOK123', r, 1).text), 'the text the look tool gives');
    assert.match(report, /\nOpen each screenshot to see it: \.orb\/seen\/1-start\.webp, \.orb\/seen\/2-score\.webp, \.orb\/seen\/3-end\.jpg\n$/);
    assert.deepEqual(out[3].data, Buffer.from('/9j/4AAQSkZJRgABAQ', 'base64'), 'the image itself');
    assert.match(look.seenFiles('L', RESULT, 0, 1)[0].data.toString(), /\(1 look left in this build: keep one for a last check and one on a phone\.\)/);
    assert.match(look.seenFiles('L', RESULT, 0, 0)[0].data.toString(), /\(That was your last look in this build\.\)/);
    assert.equal(look.seenFiles('L', { ...RESULT, shots: [{ label: 'Hello, World!', t: 1, dataUrl: RESULT.shots[0].dataUrl }] }, 0, 9)[1].name, '1-hello-world.webp');
  });

  const stepMessages = () => [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'look', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'look', output: { type: 'text', value: 'saw it' } }] },
  ];
  const imgs = new Map([['c1', [{ ref: 'orb-look:LOOK123:0', mediaType: 'image/webp', label: 'start' }]]]);

  test('screenshots go into the tool result…', () => {
    const out = look.attachLookImages(stepMessages(), imgs, 'tool');
    assert.equal(out.length, 2);
    assert.deepEqual(out[1].content[0].output, {
      type: 'content',
      value: [
        { type: 'text', text: 'saw it' },
        { type: 'text', text: 'Screenshot "start":' },
        { type: 'file', mediaType: 'image/webp', data: { type: 'data', data: 'orb-look:LOOK123:0' } },
      ],
    });
  });

  test('…or into a user message right after it', () => {
    const out = look.attachLookImages(stepMessages(), imgs, 'user');
    assert.equal(out.length, 3);
    assert.match(out[1].content[0].output.value, /The screenshots follow in the next message/);
    assert.equal(out[2].role, 'user');
    assert.deepEqual(out[2].content[2], { type: 'file', mediaType: 'image/webp', data: { type: 'data', data: 'orb-look:LOOK123:0' } });
  });

  test('only the newest screenshots stay', () => {
    let msgs = [{ role: 'user', content: 'go' }];
    for (let i = 0; i < 6; i++) {
      const m = new Map([[`c${i}`, [{ ref: `orb-look:LOOK00${i}:0`, mediaType: 'image/webp', label: 'end' }]]]);
      msgs = [...msgs, ...look.attachLookImages([{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'look', input: {} }] }, { role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${i}`, toolName: 'look', output: { type: 'text', value: `look ${i}` } }] }], m, 'tool')];
    }
    const before = JSON.stringify(msgs);
    const pruned = look.pruneLookImages(msgs, 4);
    assert.equal(JSON.stringify(msgs), before, 'the original is left alone');
    const refs = JSON.stringify(pruned).match(/orb-look:LOOK00\d/g);
    assert.deepEqual(refs, ['orb-look:LOOK002', 'orb-look:LOOK003', 'orb-look:LOOK004', 'orb-look:LOOK005']);
    assert.equal((JSON.stringify(pruned).match(/an older screenshot/g) ?? []).length, 2);
    assert.equal(look.pruneLookImages(pruned, 4), pruned, 'nothing to do');
  });
});

describe('looks in the database', () => {
  let db;
  let pg;
  const JOB = 'JOBlook000000000000001';
  before(async () => {
    pg = new PGlite();
    await pg.exec(DDL);
    db = { query: async (sql, params = []) => (await pg.query(sql, params)).rows };
    await db.query(`insert into orb_worlds (id) values ('w1')`);
    await db.query(`insert into orb_build_jobs (id) values ($1)`, [JOB]);
    await db.query(`insert into orb_agent_jobs (id, world_id) values ($1, 'w1')`, [JOB]);
  });
  after(() => pg.close());

  test('a job is watched while a page follows it', async () => {
    assert.equal(await look.isWatched(db, JOB), false);
    await look.markWatched(db, JOB);
    assert.equal(await look.isWatched(db, JOB), true);
    await db.query(`update orb_agent_jobs set watched_at = now() - interval '1 minute' where id = $1`, [JOB]);
    assert.equal(await look.isWatched(db, JOB), false);
  });

  test('an answer arrives; a second one is too late', async () => {
    const id = await look.openLook(db, JOB);
    assert.ok(look.isLookId(id));
    setTimeout(() => void look.answerLook(db, JOB, id, { result: { ...RESULT } }), 300);
    const a = await look.waitForLook(db, JOB, id, { timeoutMs: 5000 });
    assert.equal(a.result.title, 'Sky Hopper');
    assert.equal(await look.answerLook(db, JOB, id, { result: RESULT }), false);
    assert.equal(await look.lookCount(db, JOB), 1);
  });

  test('a page that can\'t look says so; then the look is over', async () => {
    const id = await look.openLook(db, JOB);
    await look.answerLook(db, JOB, id, { unavailable: 'The page with the world is in the background right now.' });
    const t0 = Date.now();
    const a = await look.waitForLook(db, JOB, id, { timeoutMs: 20_000 });
    assert.deepEqual(a, { unavailable: 'The page with the world is in the background right now.' });
    assert.ok(Date.now() - t0 >= 2000 && Date.now() - t0 < 6000);
    assert.equal(await look.answerLook(db, JOB, id, { result: RESULT }), false);
  });

  test('only the latest looks keep their screenshots; a finished job drops its looks', async () => {
    const JOB2 = 'JOBlook000000000000002';
    await db.query(`insert into orb_build_jobs (id) values ($1)`, [JOB2]);
    await db.query(`insert into orb_agent_jobs (id, world_id) values ($1, 'w1')`, [JOB2]);
    const ids = [];
    for (let i = 0; i < 8; i++) {
      const id = await look.openLook(db, JOB2);
      await look.answerLook(db, JOB2, id, { result: RESULT });
      ids.push(id);
    }
    await look.trimLooks(db, JOB2);
    const rows = await db.query(`select id, jsonb_array_length(result->'shots') as shots from orb_agent_looks where job_id = $1`, [JOB2]);
    const shots = Object.fromEntries(rows.map((r) => [r.id, Number(r.shots)]));
    const n = RESULT.shots.length;
    assert.deepEqual(ids.map((id) => shots[id]), [0, 0, n, n, n, n, n, n]);
    await look.dropLooks(db, JOB2);
    assert.equal(await look.lookCount(db, JOB2), 0);
  });

  test('nobody answers: a timeout', async () => {
    const id = await look.openLook(db, JOB);
    assert.deepEqual(await look.waitForLook(db, JOB, id, { timeoutMs: 600 }), { timeout: true });
  });

  test('a Cursor agent’s looks are passed on to the pages once, oldest first, and closed once they are over', async () => {
    const JOB3 = 'JOBlook000000000000003';
    await db.query(`insert into orb_build_jobs (id) values ($1)`, [JOB3]);
    await db.query(`insert into orb_agent_jobs (id, world_id) values ($1, 'w1')`, [JOB3]);
    const req = (n) => ({ tree: String(n).repeat(64), actions: [{ type: 'key', key: 'w', ms: 800 }], skipped: n, ...(n === 2 ? { viewport: 'phone' } : {}) });
    const own = await look.openLook(db, JOB3); // the look tool's: never handed out or closed here
    const first = await look.requestLook(db, JOB3, req(1));
    const second = await look.requestLook(db, JOB3, req(2));
    assert.ok(look.isLookId(first));
    assert.deepEqual(await look.closeLooks(db, JOB3), [], 'nothing was asked yet');
    const asked = await look.takeLookRequests(db, JOB3);
    assert.deepEqual(asked, [{ id: first, request: req(1) }, { id: second, request: req(2) }]);
    assert.deepEqual(await look.takeLookRequests(db, JOB3), [], 'each is handed out once');

    assert.equal(await look.answerLook(db, JOB3, first, { result: RESULT }), true);
    const [done, ...more] = await look.closeLooks(db, JOB3);
    assert.equal(more.length, 0, 'the second is still going');
    assert.equal(done.id, first);
    assert.deepEqual(done.request, req(1));
    assert.equal(done.answer.result.title, 'Sky Hopper');
    assert.ok(done.ms >= 0 && done.ms < 60_000, String(done.ms));
    assert.deepEqual(await look.closeLooks(db, JOB3), [], 'closed once');

    await look.answerLook(db, JOB3, second, { unavailable: 'The world is not on screen in the page that watches the build.' });
    assert.deepEqual(await look.waitForLook(db, JOB3, second, { timeoutMs: 20_000 }), { unavailable: 'The world is not on screen in the page that watches the build.' });
    assert.deepEqual((await look.closeLooks(db, JOB3)).map((l) => [l.id, l.answer]), [[second, { unavailable: 'The world is not on screen in the page that watches the build.' }]]);

    const third = await look.requestLook(db, JOB3, req(3));
    await look.takeLookRequests(db, JOB3);
    assert.deepEqual(await look.waitForLook(db, JOB3, third, { timeoutMs: 600 }), { timeout: true });
    assert.deepEqual((await look.closeLooks(db, JOB3)).map((l) => [l.id, l.answer]), [[third, { timeout: true }]]);

    const stuck = await look.requestLook(db, JOB3, req(4));
    await look.takeLookRequests(db, JOB3);
    assert.deepEqual(await look.closeLooks(db, JOB3), [], 'still waited for');
    await db.query(`update orb_agent_looks set asked_at = now() - interval '6 minutes' where id = $1`, [stuck]);
    assert.deepEqual((await look.closeLooks(db, JOB3)).map((l) => l.id), [stuck], 'quiet for long: whoever waited is gone');

    const cut = await look.requestLook(db, JOB3, req(5));
    const unasked = await look.requestLook(db, JOB3, req(6));
    await look.takeLookRequests(db, JOB3);
    await db.query(`update orb_agent_looks set asked_at = null where id = $1`, [unasked]);
    assert.deepEqual(await look.closeOpenLooks(db, JOB3), [cut], 'a finished job closes what the pages were told about');
    assert.deepEqual(await look.closeOpenLooks(db, JOB3), []);
    assert.equal((await db.query(`select closed_at from orb_agent_looks where id = $1`, [own]))[0].closed_at, null);
  });

  test('screenshot references resolve to the image data before a model call', async () => {
    const id = await look.openLook(db, JOB);
    await look.answerLook(db, JOB, id, { result: RESULT });
    const msgs = look.attachLookImages(
      [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c9', toolName: 'look', output: { type: 'text', value: 'saw' } }] }],
      new Map([['c9', [{ ref: `orb-look:${id}:0`, mediaType: 'image/webp', label: 'start' }, { ref: `orb-look:${id}:5`, mediaType: 'image/webp', label: 'gone' }]]]),
      'tool',
    );
    const cache = new Map();
    const resolved = await look.resolveLookImages(db, JOB, msgs, cache);
    const value = resolved[0].content[0].output.value;
    assert.deepEqual(value[2], { type: 'file', mediaType: 'image/webp', data: { type: 'data', data: 'UklGRiQAAABXRUJQVlA4' } });
    assert.deepEqual(value[4], { type: 'text', text: '(a screenshot that is no longer available)' });
    assert.match(JSON.stringify(msgs), /orb-look:/, 'the saved conversation keeps the reference');
    assert.ok(cache.has(id));
  });
});

describe('file tools', () => {
  let pg;
  let db;
  before(async () => {
    pg = new PGlite();
    await pg.exec(DDL);
    db = { query: async (sql, params = []) => (await pg.query(sql, params)).rows };
  });
  after(() => pg.close());

  test('edits of one file in the same reply all land, in order', async () => {
    const { Workspace, agentTools } = await import('../../../server/agent/workspace.ts');
    const ws = new Workspace(db, {});
    const tools = agentTools(ws, 'build', {}, () => {});
    const call = (name, input, id) => tools[name].execute(input, { toolCallId: id, messages: [] });
    await call('write_file', { label: 'Start', path: 'src/a.js', content: 'const one = 1;\nconst two = 2;\nconst three = 3;\n' }, 'c1');
    // A reply's tool calls start side by side.
    const results = await Promise.all([
      call('edit_file', { label: 'One', path: 'src/a.js', old_string: 'const one = 1;', new_string: 'const one = 10;' }, 'c2'),
      call('edit_file', { label: 'Three', path: 'src/a.js', old_string: 'const three = 3;', new_string: 'const three = 30;' }, 'c3'),
      call('edit_file', { label: 'Again', path: 'src/a.js', old_string: 'const one = 10;', new_string: 'const one = 100;' }, 'c4'),
    ]);
    assert.ok(results.every((r) => /^Edited src\/a\.js/.test(r)), results.join(' | '));
    assert.equal(await ws.read('src/a.js'), 'const one = 100;\nconst two = 2;\nconst three = 30;\n');
  });
});

describe('a reply cut off at the output limit', () => {
  test('its tool calls all get results, so the conversation can go on', async () => {
    const { closeToolCalls } = await import('../../../server/agent/workspace.ts');
    const call = (id, toolName) => ({ type: 'tool-call', toolCallId: id, toolName, input: {} });
    const added = [{ role: 'assistant', content: [{ type: 'text', text: 'Building it.' }, call('a', 'name_world'), call('b', 'write_file'), call('c', 'write_file')] }];
    const out = closeToolCalls(added, new Map([['a', 'Named.'], ['b', 'Wrote index.html']]));
    assert.equal(out.length, 2);
    assert.deepEqual(
      out[1].content.map((p) => [p.toolCallId, p.toolName, p.output.value]),
      [['a', 'name_world', 'Named.'], ['b', 'write_file', 'Wrote index.html'], ['c', 'write_file', 'Not run: your reply was cut off at the output limit.']],
    );
    const whole = [...added, { role: 'tool', content: ['a', 'b', 'c'].map((id) => ({ type: 'tool-result', toolCallId: id, toolName: 'x', output: { type: 'text', value: 'ok' } })) }];
    assert.equal(closeToolCalls(whole, new Map()), whole, 'a complete reply stays as it is');
  });
});
