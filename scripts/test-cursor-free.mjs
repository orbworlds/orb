#!/usr/bin/env node
// End-to-end tests for the free builder on Orb's own Cursor key (src/server/ai.ts): free agent
// builds run as Cursor agents without GitHub, getting, saving and looking at the world through the
// job's files link (src/server/agent/sync.ts), with the Cursor-sized free-tier limits.
//
//   node scripts/test-cursor-free.mjs
//
// Starts the fake Cursor API (scripts/fake-cursor-github.mjs) and `next dev` on :3104
// (ORB_TEST_PORT) with a fresh database (.data/pglite-cursor-free), ORB_CURSOR_KEY set and no other
// AI configured (no ORB_MOCK_AI), and 3 free builds per device a day. Then it starts the server
// again with every request taken for a bot's (ORB_BOTID_TEST=bot, src/server/botid.ts), and once
// more with a free builder budget of $0.20 a day (src/server/budget.ts).
// Exit code 0 = all checks passed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { startFake } from './fake-cursor-github.mjs';
import { check, client, device, finish, newest, root, startNext, stopNext } from './harness.mjs';

const PORT = process.env.ORB_TEST_PORT || '3104';
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = '.data/pglite-cursor-free';
const KEY = 'crsr_test_free';
const { request, build, newWorld } = client(BASE);

const OWNER = device('owner');
const VISITOR = device('visitor');

/** A build followed like a watching page does: `answer(look, n)` answers the agent's n-th look. */
async function watchBuild(dev, worldId, content, answer) {
  const res = await fetch(`${BASE}/api/agent/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orb-device': dev },
    body: JSON.stringify({ worldId, messages: [{ role: 'user', content }], mode: 'build', code: '' }),
    signal: AbortSignal.timeout(180_000),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  const looks = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    for (const m of text.matchAll(/\u001e(\{"t":"look"[^\n]*)\n/g)) {
      const look = JSON.parse(m[1]);
      if (looks.some((l) => l.look.id === look.id)) continue;
      const n = looks.length;
      looks.push({ look, reply: null });
      looks[n].reply = (await answer(look, n)).status;
    }
  }
  return { status: res.status, text, looks };
}
/** A 1×1 PNG, as a page's screenshot. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const ADMIN_TOKEN = 'orb-test-admin-token';
const LAB_KEY = 'test-lab-key';
/** "Today (UTC): $x of the $y budget · without an account $a of $b" on the Pulse page, as numbers. */
async function spentToday() {
  const html = (await (await fetch(`${BASE}/lab/${LAB_KEY}/pulse`)).text()).replace(/<!-- -->/g, '');
  const m = /Today \(UTC\): \$([\d.]+) of the \$([\d.]+) budget · without an account \$([\d.]+) of \$([\d.]+)/.exec(html);
  return m ? { all: Number(m[1]), budget: Number(m[2]), anon: Number(m[3]), anonBudget: Number(m[4]) } : null;
}

function startServer(fakeUrl, extraEnv = {}) {
  fs.rmSync(path.join(root, DATA_DIR), { recursive: true, force: true });
  const about = [extraEnv.ORB_BOTID_TEST && 'everyone a bot', extraEnv.ORB_FREE_DAILY_USD && `$${extraEnv.ORB_FREE_DAILY_USD} a day`].filter(Boolean).join(', ');
  console.log(`Starting next dev on :${PORT} (PGlite: ${DATA_DIR}${about ? `, ${about}` : ''}) …`);
  return startNext({
    port: PORT,
    unset: ['ORB_MOCK_AI', 'ANTHROPIC_API_KEY', 'AI_GATEWAY_API_KEY', 'CURSOR_API_KEY', 'ORB_BOTID_TEST', 'ORB_FREE_DAILY_USD', 'ORB_FREE_DAILY_USD_ANON'],
    env: { ORB_CURSOR_KEY: KEY, ORB_CURSOR_API: fakeUrl, ORB_PGLITE_DIR: DATA_DIR, ORB_SECRET: 'orb-test-secret', ORB_ADMIN_TOKEN: ADMIN_TOKEN, ORB_LAB_KEY: LAB_KEY, ORB_FREE_DAILY_PER_DEVICE: '3', ...extraEnv },
  });
}

const fake = await startFake();
let server = await startServer(`http://localhost:${fake.port}`);
try {
  console.log('\nConfig');
  const cfg = await request('GET', '/api/config');
  check('the free builder is set up, on Cursor’s Opus 5.5', cfg.json?.ai === true && cfg.json?.model === 'claude-opus-5-5', cfg.json);

  console.log('\nA free build');
  const w = await newWorld(OWNER);
  const r = await build(OWNER, w.id, 'a glowing garden mocknoop');
  const job = /"kind":"agent","id":"([^"]+)"/.exec(r.text)?.[1];
  const agent = newest(fake);
  check('the build streams as an agent job', r.status === 200 && !!job, r.text.slice(0, 300));
  check('a Cursor agent on Orb’s own key', agent && agent.auth === `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`, agent && { auth: agent.auth });
  check('Opus 5.5 at low effort with the smaller context', JSON.stringify(agent?.model) === JSON.stringify({ id: 'claude-opus-5-5', params: [{ id: 'context', value: '300k' }, { id: 'reasoning_effort', value: 'low' }] }), agent?.model);
  const prompt = agent?.runs[0].prompt ?? '';
  check('its prompt has this job’s files link and how to save', new RegExp(`/api/agent/jobs/${job}/files\\?t=[\\w-]+`).test(prompt) && prompt.includes('sh .orb/save') && !prompt.includes('{{ORB_FILES_URL}}'));
  check('…and asks it to name the untitled world in its page’s title', /It has no name yet: in your first edit, set the <title> in index\.html/.test(prompt));
  check('a save before any change says there is nothing to save yet', /^Nothing to save yet/.test(agent?.saves?.[0] ?? ''), agent?.saves);
  check('the agent got the world and saved through the link', agent?.downloads === 1 && /Saved to Orb \(3 files, 3 changed\)/.test(agent?.saves?.[1] ?? ''), { downloads: agent?.downloads, saves: agent?.saves, log: fake.log.filter((l) => l.startsWith('agent action')) });
  check('agent edits show up as steps', /"t":"step","id":"r0:e1","kind":"edit","label":"Changing config.js","status":"done"/.test(r.text));
  check('…and in the world as soon as they are made, before the save', r.text.indexOf('"t":"tree"') !== -1 && r.text.indexOf('"t":"tree"') < r.text.indexOf('Saving to the world'), r.text.slice(0, 600));
  check('saving shows as such', /Saving to the world/.test(r.text));
  check('a save becomes a version', /"t":"version"/.test(r.text));
  check('the ideas line becomes next ideas (not narration)', /<orb:suggest>Make it sunset\|Add fireflies\|Add soft music<\/orb:suggest>/.test(r.text) && !/Next ideas:/.test(r.text));
  check('the agent’s messages don’t run into each other', /building it now!(<\/orb:say>)?\n/.test(r.text) && /Your garden glows/.test(r.text) && !/now!Your/.test(r.text), r.text.slice(-500));
  check('…and each shows when the agent moves on, before its edits', r.text.indexOf('building it now!') !== -1 && r.text.indexOf('building it now!') < r.text.indexOf('"t":"step"'), r.text.slice(0, 600));
  check('what the agent couldn’t check stays out of the chat', /tap around!/.test(r.text) && !/browser/.test(r.text), r.text.slice(-500));
  check('no GitHub repository involved', !/"t":"repo"/.test(r.text));
  const after = (await request('GET', `/api/worlds/${w.id}`, { dev: OWNER })).json.world;
  check('the world has the agent’s files', after.code.includes('src/main.js') && !!after.tree);
  check('an untitled world takes the page’s title', after.name === 'Cursor Garden', after.name);
  const STARTER = '<!doctype html><html><head><title>A quiet little island</title></head><body><script type="module" src="./src/main.js"></script></body></html>';
  const KEEPER = device('keeper');
  const ws0 = (await request('POST', '/api/worlds', { dev: KEEPER, body: { name: 'Untitled world', code: STARTER } })).json.world;
  const kept = await build(KEEPER, ws0.id, 'some glowing flowers on the island');
  const keptWorld = (await request('GET', `/api/worlds/${ws0.id}`, { dev: KEEPER })).json.world;
  check('a starter’s own page title is not a name the agent gave', /"t":"version"/.test(kept.text) && keptWorld.name === 'Untitled world', keptWorld.name);
  check('the files link closes with the build', (await fetch(agent.link)).status === 410);
  check('a wrong token finds nothing', (await fetch(agent.link.replace(/t=[\w-]+/, 't=nope'))).status === 404);
  const spent = await spentToday();
  check('what the build cost is charged to the day’s budget ($20 by default, half without an account)', spent && spent.all > 0.01 && spent.all < 0.5 && spent.anon === spent.all && spent.budget === 20 && spent.anonBudget === 10, spent);

  console.log('\nThe free builder looks at the world');
  const LOOKER = device('looker');
  const wl = await newWorld(LOOKER);
  const shot = `data:image/png;base64,${PNG.toString('base64')}`;
  const SEEN = {
    size: { w: 390, h: 844, dpr: 3 },
    title: 'Cursor Garden',
    uptime: 2400,
    fps: 57,
    errors: [],
    logs: [{ level: 'log', text: 'garden ready', t: 300 }],
    dropped: 0,
    ui: [{ text: 'Tap to plant', x: 0.1, y: 0.85, w: 0.4, h: 0.05, tag: 'button', click: true }],
    canvas: { w: 1170, h: 2532, type: 'webgl2', cover: 1 },
    focus: 'page',
    locked: false,
    shots: [
      { label: 'Walking up', t: 900, dataUrl: shot },
      { label: 'end', t: 2300, dataUrl: shot },
    ],
    evals: [],
    notes: [],
  };
  const BUSY = 'The page with the world is in the background right now, so the world is paused.';
  const looked = await watchBuild(LOOKER, wl.id, 'a glowing garden mocklook', (look, n) =>
    request('POST', `/api/agent/jobs/${look.job}/look`, { dev: LOOKER, body: { id: look.id, ...(n === 0 ? { result: SEEN } : { unavailable: BUSY }) } }),
  );
  const la = newest(fake);
  const [look1, look2] = looked.looks;
  check('the build with looks runs', looked.status === 200 && /"t":"version"/.test(looked.text) && !/<orb:error>/.test(looked.text), looked.text.slice(-300));
  check('the agent’s download has a look script, and its prompt says how to look', fs.existsSync(path.join(la.dir, '.orb/look')) && /sh \.orb\/look plays the files here in the person's browser/.test(la.runs[0].prompt) && /"type":"screenshot","label":"after the jump"/.test(la.runs[0].prompt));
  check(
    'each of its looks reaches the watching page once, played as asked',
    looked.looks.length === 2 && isDeepStrictEqual(look1.look.actions, [{ type: 'key', key: 'w', ms: 300 }, { type: 'screenshot', label: 'Walking up' }]) && look1.look.viewport === 'phone' && !look2.look.viewport && look1.look.size === 1024 && look1.look.shots === 4 && look1.reply === 200 && look2.reply === 200,
    looked.looks,
  );
  const lookAt = looked.text.indexOf(`"t":"look","job":"${look1?.look.job}","id":"${look1?.look.id}"`);
  const main = look1 ? await (await fetch(`${BASE}/api/tree/${look1.look.tree}/src/main.js`)).text() : '';
  check('…running the files as they are in the agent’s folder, unsaved changes too, shown first', /tuned while looking/.test(main) && looked.text.lastIndexOf(`"t":"tree","tree":"${look1?.look.tree}"`, lookAt) !== -1, main);
  check('the chat says it is trying the world out on a phone', looked.text.lastIndexOf('"t":"status","phase":"thinking","text":"Trying it on a phone…"', lookAt) !== -1);
  check('…and that it looks closely when it opens a screenshot (no file names)', /"t":"status","phase":"thinking","text":"Looking closely…"/.test(looked.text) && !/Reading 1-walking-up/.test(looked.text));
  const said = la.looks?.[0]?.said ?? '';
  check(
    'the agent reads what the page saw: screen, frame rate, console, text on screen, screenshots to open',
    /^The world in the person's browser: 390×844 px \(phone-sized, 3× pixel density\)/.test(said) && /Frame rate: 57 fps\./.test(said) && /\[log\] garden ready/.test(said) && /- \[button\] "Tap to plant"/.test(said) && /Open each screenshot to see it: \.orb\/seen\/1-walking-up\.png, \.orb\/seen\/2-end\.png/.test(said),
    said,
  );
  check('…and the screenshots are in its folder, as the page took them', JSON.stringify(la.looks?.[0]?.seen) === JSON.stringify(['1-walking-up.png', '2-end.png', 'report.txt']) && PNG.equals(la.looks[0].files['2-end.png']), la.looks?.[0]?.seen);
  check('a look the page can’t take tells the agent why, and leaves nothing behind', (la.looks?.[1]?.said ?? '') === `Couldn't look: ${BUSY} Continue carefully, and look again later.\n` && la.looks[1].seen.length === 0, la.looks?.[1]);
  check('both looks are closed in the output (a replaying page skips them)', [look1, look2].every((l) => l && looked.text.includes(`"t":"looked","id":"${l.look.id}"`)));
  const lookedAt = looked.text.indexOf(`"t":"looked","id":"${look2?.look.id}"`);
  check('looking saves no version', lookAt !== -1 && lookedAt > lookAt && !looked.text.slice(lookAt, lookedAt).includes('"t":"version"'));
  const lookJob = /"kind":"agent","id":"([^"]+)"/.exec(looked.text)?.[1];
  let traced = null;
  for (let i = 0; i < 40 && !traced; i++) {
    const t = JSON.parse((await (await fetch(`${BASE}/lab/${LAB_KEY}/traces/export?id=${lookJob}`)).text()).trim().split('\n').pop() || 'null');
    if (t && t.status !== 'running') traced = t;
    else await new Promise((r) => setTimeout(r, 500));
  }
  const traceLooks = traced?.events.filter((e) => e.type === 'look') ?? [];
  check(
    'the build’s trace has both looks, with what the page saw',
    traceLooks.length === 2 && traceLooks[0].summary.outcome === 'seen' && traceLooks[0].summary.shots === 2 && traceLooks[0].summary.fps === 57 && traceLooks[1].summary.outcome === 'unavailable' && traced.meta.looks === 2,
    traceLooks.map((e) => e.summary),
  );

  console.log('\nA build goes on past Cursor’s 30 minutes a run');
  const limited = await build(OWNER, w.id, 'more colors mocklimit');
  const second = newest(fake);
  check('a run that hits Cursor’s time limit goes on in a follow-up run', second !== agent && second.runs.length === 2 && /stopped by a time limit/.test(second.runs[1].prompt), second.runs.map((r) => r.prompt.slice(0, 60)));
  check('…and the build finishes, no pause', /"t":"version"/.test(limited.text) && /Next ideas|<orb:suggest>/.test(limited.text) && !/pause here/.test(limited.text) && !/<orb:error>/.test(limited.text), limited.text.slice(-400));
  check('…saying what it used as it goes', (limited.text.match(/"t":"credits"/g) ?? []).length >= 2, limited.text.match(/"t":"credits","used":[\d.]+/g));

  console.log('\nA visitor’s question');
  const before = (await request('GET', `/api/worlds/${w.id}`, { dev: OWNER })).json.world;
  const asked = await build(VISITOR, w.id, 'how do I play?');
  const guide = newest(fake);
  check('a guide gets the files but no way to save', guide.runs[0].prompt.includes('# Mode: guide') && !guide.runs[0].prompt.includes('sh .orb/save') && guide.downloads === 1);
  check('…and saving anyway is refused', guide.guideSave?.status === 403, guide.guideSave);
  check('…nor a way to look (looking anyway is refused)', guide.guideLook?.status === 403 && guide.guideLook.script === false, guide.guideLook);
  check('…its answer reaches the visitor, even when only the run’s result carries it', (asked.text.match(/Press space to jump/g) ?? []).length === 1, asked.text.slice(-300));
  check('…and the world is unchanged', (await request('GET', `/api/worlds/${w.id}`, { dev: OWNER })).json.world.version === before.version);
  check('…a question offers no copy', !/<orb:remix\/>/.test(asked.text), asked.text.slice(-200));
  const askedFor = Number(/"t":"credits","used":([\d.]+)/.exec(asked.text)?.[1] ?? 0);
  check('…and is charged like any build on Orb’s AI', askedFor > 0, askedFor);
  const change = await build(VISITOR, w.id, 'make it nighttime mockchange');
  check('a visitor’s change request: the guide offers their own copy (<orb:remix/>), still unchanged', /<orb:remix\/>/.test(change.text) && /make your own copy/.test(change.text) && (await request('GET', `/api/worlds/${w.id}`, { dev: OWNER })).json.world.version === before.version, change.text.slice(-300));
  check('…without its "Own copy" line in the chat', !/own copy:/i.test(change.text), change.text.slice(-300));

  console.log('\nAn automatic fix for a WebGL shader error');
  // Chrome's shader logs end in a NUL, which Postgres can't store: the fix used to stop with "Something went wrong".
  const FIXER = device('fixer');
  const wf = await newWorld(FIXER);
  const shaderError = "THREE.WebGLProgram: Shader Error 0 - VALIDATE_STATUS false\n\nFragment shader is not compiled.\nERROR: 0:4: 'glow' : undeclared identifier\n\u0000";
  const fix = await request('POST', '/api/agent/jobs', {
    dev: FIXER,
    body: {
      worldId: wf.id,
      messages: [
        { role: 'user', content: 'glowing flowers' },
        { role: 'assistant', content: 'Here are your flowers 🌷' },
        { role: 'user', content: 'Automatic check: some of those changes did not work (see <errors>). Fix exactly these problems.' },
      ],
      errors: [shaderError],
      mode: 'build',
      code: '',
    },
  });
  const fixer = newest(fake);
  check('an automatic fix whose errors end in a NUL (as WebGL shader logs do) runs', fix.status === 200 && /"t":"handle"/.test(fix.text) && !/server_error/.test(fix.text) && fixer.runs[0].prompt.includes("'glow' : undeclared identifier"), { status: fix.status, tail: fix.text.slice(-200) });

  console.log('\nOrb’s key refused');
  const denied = await build(OWNER, w.id, 'mockdenied');
  check('the person hears that the free builder is resting', /<orb:error>The free builder is resting right now/.test(denied.text), denied.text.slice(-300));

  console.log('\nFree builds a day');
  const over = await build(OWNER, w.id, 'one more');
  check('the fourth build of the day without an account is turned away, asking to sign in', over.status === 429 && over.json?.error === 'rate_limited' && /free building without an account for today — sign in/.test(over.json?.message ?? ''), over.json);

  console.log('\nSigned in');
  const up = await request('POST', '/api/auth/signup', { dev: OWNER, body: { username: `maker-${crypto.randomBytes(3).toString('hex')}`, password: 'correct horse battery' } });
  check('signing up works', up.status === 200 && !!up.cookie, up.json);
  const mine = await build(OWNER, w.id, 'a moon too', { cookie: up.cookie });
  check('the same device builds again, on the account’s own quota', mine.status === 200 && /"kind":"agent"/.test(mine.text) && /"t":"version"/.test(mine.text), mine.json ?? mine.text.slice(-300));

  console.log('\nBots');
  await stopNext(server);
  server = await startServer(`http://localhost:${fake.port}`, { ORB_BOTID_TEST: 'bot' });
  const BOT = device('bot');
  const wb = await newWorld(BOT);
  const agentsBefore = fake.agents.size;
  const turned = await build(BOT, wb.id, 'a castle');
  check('a free build from a bot is turned away → 403 bot_detected', turned.status === 403 && turned.json?.error === 'bot_detected' && /Try again in a moment/.test(turned.json?.message ?? ''), turned.json);
  check('…before a Cursor agent starts', fake.agents.size === agentsBefore);
  for (const [what, urlPath, body] of [
    ['signing up', '/api/auth/signup', { username: 'bot-maker', password: 'correct horse battery' }],
    ['signing in', '/api/auth/signin', { username: 'bot-maker', password: 'correct horse battery' }],
    ['making an account with a passkey', '/api/auth/passkey/register/options', { name: 'Bot' }],
  ]) {
    const r = await request('POST', urlPath, { dev: BOT, body });
    check(`${what} as a bot → 403 bot_detected`, r.status === 403 && r.json?.error === 'bot_detected', r.json);
  }
  const admin = await build(BOT, wb.id, 'a castle', { headers: { 'x-admin-token': ADMIN_TOKEN } });
  check('admins still build (to check production)', admin.status === 200 && /"kind":"agent"/.test(admin.text), admin.json ?? admin.text.slice(0, 300));
  const own = await build(BOT, wb.id, 'a castle', { headers: { 'x-orb-agent-provider': 'cursor', 'x-orb-agent-key': 'crsr_own_key' } });
  check('builds on the person’s own key are not checked', own.status === 200 && /"kind":"agent"/.test(own.text) && newest(fake).auth === `Basic ${Buffer.from('crsr_own_key:').toString('base64')}`, own.json ?? own.text.slice(0, 300));

  // A build here is estimated at ~$0.13 (Cursor's instructions + Orb's prompt + 260 tokens written, at Opus 5.5's price).
  console.log('\nThe day’s budget ($0.40 here, half of it for builds without an account)');
  await stopNext(server);
  server = await startServer(`http://localhost:${fake.port}`, { ORB_FREE_DAILY_USD: '0.4' });
  const [P1, P2, P3, P4] = ['budget1', 'budget2', 'budget3', 'budget4'].map(device);
  const pond = await build(P1, (await newWorld(P1)).id, 'a little pond');
  check('a build without an account runs, charged to both parts of the budget', pond.status === 200 && /"t":"version"/.test(pond.text) && !/pause here/.test(pond.text) && (await spentToday())?.anon > 0.03, pond.text.slice(-300));
  const hill = await build(P2, (await newWorld(P2)).id, 'a little hill');
  check('the build that spends the part without an account pauses at its next step, keeping what it saved', /"t":"version"/.test(hill.text) && /without an account right now, so I'll pause here — sign in/.test(hill.text) && !/<orb:error>/.test(hill.text), hill.text.slice(-400));
  check('…and its agent is stopped at Cursor', fake.log.includes(`POST /v1/agents/${newest(fake).id}/runs/${newest(fake).runs[0].id}/cancel`));
  const w3 = await newWorld(P3);
  const tree = await build(P3, w3.id, 'a little tree');
  check('then builds without an account are turned away, asking to sign in', tree.status === 429 && tree.json?.error === 'rate_limited' && /sign in/.test(tree.json?.message ?? '') && Number(tree.json?.retryAfter) > 0, tree.json);
  const joined = await request('POST', '/api/auth/signup', { dev: P3, body: { username: `budget-${crypto.randomBytes(3).toString('hex')}`, password: 'correct horse battery' } });
  const big = await build(P3, w3.id, 'a big castle mockspend', { cookie: joined.cookie });
  check('signed in, building goes on until the whole budget is spent, then pauses', joined.status === 200 && /"t":"version"/.test(big.text) && /used up today's budget, so I'll pause here/.test(big.text), big.json ?? big.text.slice(-400));
  const late = await build(P3, w3.id, 'one more', { cookie: joined.cookie });
  check('then the free builder rests for everyone until tomorrow (UTC)', late.status === 503 && late.json?.error === 'ai_unavailable' && /back tomorrow/.test(late.json?.message ?? '') && Number(late.json?.retryAfter) > 0, late.json);
  const ownKey = await build(P4, (await newWorld(P4)).id, 'my own key', { headers: { 'x-orb-agent-provider': 'cursor', 'x-orb-agent-key': 'crsr_own_key' } });
  check('builds on people’s own keys go on', ownKey.status === 200 && /"t":"version"/.test(ownKey.text), ownKey.json ?? ownKey.text.slice(-200));
  const day = await spentToday();
  check('the Pulse page shows what today cost against the budget', day && day.all >= 0.4 && day.budget === 0.4 && day.anon >= 0.2 && day.anonBudget === 0.2, day);
} catch (e) {
  check('unexpected exception', false, e?.stack?.split('\n').slice(0, 4).join(' | ') ?? String(e));
} finally {
  await stopNext(server);
  fake.close();
}

finish({ onFail: () => console.log(server.log().slice(-3000)) });
