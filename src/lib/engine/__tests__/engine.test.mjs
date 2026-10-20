// Run all engine tests: node --test --experimental-strip-types src/lib/engine/__tests__/*.test.mjs
// Plain JS on purpose: node strips the types of the imported .ts sources (explicit .ts paths,
// which the app tsconfig does not allow, so these files stay outside tsc).
// Exercises BuildEngine (the logic behind useBuild) with a fake host and scripted agent jobs: every
// build is an agent job on Orb's server, which the page follows.
import './setup.mjs';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { BuildEngine, MAX_PARALLEL_BUILDS } = await import('../useBuild.ts');
const { BuildError } = await import('../client.ts');
const local = await import('../../local.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 2000, what = 'condition') {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const tree = (c) => c.repeat(64);
const T1 = tree('a');
const T2 = tree('b');
const page = (title) => `<!DOCTYPE html><html><head><title>${title}</title></head><body>${title}</body></html>`;
const PAGES = { [T1]: page('One'), [T2]: page('Two') };

/** Like the stream of a real job, a wait ends when the page stops listening. */
const pause = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Fake agent jobs, one script per build request (or an Error to fail it): each entry waits a
 * little, then yields protocol text or hands the engine a frame (handle, step, tree, version, credits).
 */
function jobs(scripts) {
  const requests = [];
  async function* run(req, settings, signal, hooks = {}) {
    requests.push(req);
    const script = scripts[requests.length - 1];
    if (script instanceof Error) throw script;
    if (script === undefined) throw new Error('no scripted job for call ' + requests.length);
    for (const s of script) {
      if (signal.aborted) throw new BuildError('aborted', 'Stopped.');
      await pause(s.wait ?? 2, signal);
      if (signal.aborted) throw new BuildError('aborted', 'Stopped.');
      if (s.error) throw s.error;
      if (s.text) yield s.text;
      if (s.handle) hooks.onHandle?.(s.handle);
      if (s.step) hooks.onStep?.(s.step);
      if (s.tree) hooks.onTree?.(s.tree);
      if (s.version) hooks.onVersion?.(s.version);
      if (s.credits != null) hooks.onCredits?.(s.credits);
    }
  }
  run.requests = requests;
  return run;
}

/** A build on world `w`: narration, two file steps with their trees, the saved version, the credits. */
const island = (w = 'w1', version = 4) => [
  { handle: { kind: 'agent', id: `job-${w}` } },
  { text: '<orb:say>Ooh, a floating' },
  { text: ' island — let’s' },
  { text: ' make it!</orb:say>\n' },
  { step: { id: 's1', kind: 'write', label: 'Writing…', status: 'pending' } },
  { step: { id: 's1', kind: 'write', label: 'Raising the island', status: 'done' } },
  { tree: T1, wait: 2 },
  { step: { id: 's2', kind: 'edit', label: 'Adding drifting clouds', status: 'done' }, wait: 200 },
  { tree: T2 },
  { version: { worldId: w, version, tree: T2, name: 'Sky Island' }, wait: 200 },
  { credits: 12.5 },
  { text: '<orb:title>Sky Island</orb:title>\n<orb:say>Drag to look around — the clouds drift by slowly.</orb:say>\n<orb:suggest>Make it night|Add a little waterfall|Add soft music</orb:suggest>\n' },
];

/** A small build that saves version `version` of world `w` with the files `t`. */
const saves = (say, version, { w = 'w1', t = T1, label = 'Lighting lanterns' } = {}) => [
  { text: `<orb:say>${say}</orb:say>\n` },
  { step: { id: `e${version}`, kind: 'edit', label, status: 'done' } },
  { version: { worldId: w, version, tree: t } },
  { text: '<orb:suggest>a|b|c</orb:suggest>\n' },
];

function makeHost(over = {}) {
  const calls = { previews: [], adopted: [], restores: [] };
  const state = { code: over.code ?? page('Start'), version: over.version === undefined ? 3 : over.version };
  const host = {
    chatKey: 'w1',
    mode: 'build',
    worldName: 'Sky Island',
    worldId: 'w1',
    getCode: () => state.code,
    getVersion: () => state.version,
    preview: (c) => calls.previews.push(c),
    adoptVersion: (v) => {
      calls.adopted.push(v);
      state.code = v.code;
      state.version = v.version;
    },
    restore: async (v) => {
      calls.restores.push(v);
    },
    ...over.host,
  };
  return { host, calls, state };
}

function engineWith(run, opts = {}) {
  return new BuildEngine({
    runBuild: run,
    getSettings: () => ({ provider: 'free' }),
    loadTree: async (t) => PAGES[t] ?? page(t.slice(0, 6)),
    previewDebounceMs: 20,
    imageTimeoutMs: 50,
    runtimeWindowMs: 60,
    readyTimeoutMs: 300,
    persistThrottleMs: 10,
    ...opts,
  });
}

const lastAssistant = (e) => e.getSnapshot().messages.filter((m) => m.role === 'assistant').at(-1);

beforeEach(() => localStorage.clear());

describe('BuildEngine — building', () => {
  test('follows the job: narration as it streams, steps, live previews of the files, the saved version and its credits', async () => {
    const run = jobs([island()]);
    const e = engineWith(run);
    const { host, calls, state } = makeHost();
    e.setHost(host);
    const snapshots = [];
    e.subscribe(() => snapshots.push(e.getSnapshot()));
    await e.send('  a floating island  ');

    const snap = e.getSnapshot();
    assert.equal(snap.isBuilding, false);
    assert.equal(snap.messages.length, 2);
    assert.equal(snap.messages[0].text, 'a floating island');
    const a = snap.messages[1];
    assert.equal(a.text, 'Ooh, a floating island — let’s make it!\n\nDrag to look around — the clouds drift by slowly.');
    assert.equal(a.build.status, 'done');
    assert.equal(a.build.title, 'Sky Island');
    assert.deepEqual(a.build.steps.map((s) => [s.label, s.status]), [
      ['Raising the island', 'done'],
      ['Adding drifting clouds', 'done'],
    ]);
    assert.deepEqual(a.build.suggestions, ['Make it night', 'Add a little waterfall', 'Add soft music']);
    assert.equal(a.build.fromVersion, 3);
    assert.equal(a.build.toVersion, 4);
    assert.equal(a.build.credits, 12.5);
    assert.equal(a.build.handles, undefined, 'finished: nothing to reconnect to');
    // the job saved the world; the page took that version over
    assert.deepEqual(calls.adopted.map((v) => [v.version, v.tree, v.code]), [[4, T2, PAGES[T2]]]);
    assert.equal(state.version, 4);
    // the files showed up live, with a <base> into their tree
    assert.ok(calls.previews.some((p) => p.includes(`/api/tree/${T1}/`) && p.includes('<title>One</title>')));
    // the narration streamed (several intermediate snapshots with growing text)
    const texts = snapshots.map((s) => s.messages[1]?.text ?? '').filter(Boolean);
    assert.ok(new Set(texts).size >= 3);
    // the request: this world, the chat, the mode (the agent reads the files itself)
    const req = run.requests[0];
    assert.equal(req.worldId, 'w1');
    assert.deepEqual(req.messages, [{ role: 'user', content: 'a floating island' }]);
    assert.equal(req.mode, 'build');
    assert.equal(req.image, null);
    assert.equal('code' in req, false);
    // thread persisted with a title
    assert.equal(snap.threads[0].title, 'a floating island');
    assert.equal(local.loadChatMessages(snap.threadId).length, 2);
  });

  test('a burst of file changes shows as a few previews, ending on the newest files', async () => {
    const trees = Array.from({ length: 12 }, (_, i) => tree(i.toString(16)));
    const run = jobs([[...trees.map((t) => ({ tree: t, wait: 10 })), { text: '<orb:say>Done</orb:say>', wait: 300 }]]);
    const e = engineWith(run, { previewDebounceMs: 60 });
    const { host, calls } = makeHost();
    e.setHost(host);
    await e.send('lots of changes');
    assert.ok(calls.previews.length >= 1, 'previewed');
    assert.ok(calls.previews.length < 12, `expected the burst to collapse, got ${calls.previews.length} previews`);
    assert.ok(calls.previews.at(-1).includes(`/api/tree/${trees.at(-1)}/`));
  });

  test('history: prior turns are summarized as narration + built labels', async () => {
    const run = jobs([saves('Planting!', 4, { label: 'Planting trees' }), [{ text: '<orb:say>Sure.</orb:say>' }]]);
    const e = engineWith(run);
    e.setHost(makeHost().host);
    await e.send('more trees');
    await e.send('what did you do?');
    assert.deepEqual(run.requests[1].messages, [
      { role: 'user', content: 'more trees' },
      { role: 'assistant', content: 'Planting!\n(built: Planting trees)' },
      { role: 'user', content: 'what did you do?' },
    ]);
  });

  test('ask mode: a change request offers their own copy on the answer', async () => {
    const run = jobs([[{ text: '<orb:say>You could make your own copy!</orb:say>\n<orb:remix/>\n<orb:suggest>a|b|c</orb:suggest>\n' }, { credits: 2 }]]);
    const e = engineWith(run);
    const { host, calls } = makeHost({ host: { mode: 'ask' } });
    e.setHost(host);
    await e.send('add more trees');
    const a = lastAssistant(e);
    assert.equal(a.build.remix, true);
    assert.deepEqual(a.build.steps, []);
    assert.equal(a.build.credits, 2, 'an answer costs what it used too');
    assert.equal(calls.previews.length, 0);
    assert.equal(calls.adopted.length, 0);
    assert.equal(run.requests[0].mode, 'ask');
  });

  test('ask mode: a question is answered in place, with no copy offered', async () => {
    const run = jobs([[{ text: '<orb:say>Press space to jump!</orb:say>\n<orb:suggest>a|b|c</orb:suggest>\n' }]]);
    const e = engineWith(run);
    e.setHost(makeHost({ host: { mode: 'ask' } }).host);
    await e.send('how do I jump?');
    assert.equal(lastAssistant(e).build.remix, undefined);
    assert.equal(lastAssistant(e).text.trim(), 'Press space to jump!');
  });

  test('a slow screenshot is skipped after the timeout', async () => {
    const run = jobs([[{ text: '<orb:say>Hi</orb:say>' }]]);
    const e = engineWith(run);
    e.setHost(makeHost({ host: { getImage: () => new Promise(() => {}) } }).host);
    const t0 = Date.now();
    await e.send('hello');
    assert.equal(run.requests[0].image, null);
    assert.ok(Date.now() - t0 < 1000);
    const run2 = jobs([[{ text: '<orb:say>Hi</orb:say>' }]]);
    const e2 = engineWith(run2);
    const img = 'data:image/jpeg;base64,AAAA';
    e2.setHost(makeHost({ host: { getImage: async () => img } }).host);
    await e2.send('hello');
    assert.equal(run2.requests[0].image, img);
  });
});

describe('BuildEngine — the repair round', () => {
  test('runtime errors right after the build saved the world start one automatic round in the same message', async () => {
    const run = jobs([saves('Lanterns!', 4), saves('Fixed!', 5, { t: T2, label: 'Steadying the lanterns' })]);
    const e = engineWith(run);
    const { host, calls } = makeHost();
    e.setHost(host);
    await e.send('add lanterns');
    assert.equal(calls.adopted.length, 1);
    // the world loads the new version and reports an error
    e.reportRuntimeError({ message: 'TypeError: lantern is undefined', line: 120, col: 4, stack: 'at loop (src/main.js:120:4)' });
    e.reportReady();
    await waitFor(() => run.requests.length === 2, 2000, 'repair request');
    await waitFor(() => !e.getSnapshot().isBuilding && calls.adopted.length === 2, 2000, 'repaired version');
    const req = run.requests[1];
    assert.match(req.errors[0], /Runtime error in the browser: TypeError: lantern is undefined \(line 120:4\)/);
    assert.equal(req.worldId, 'w1');
    assert.equal(req.mode, 'build');
    assert.deepEqual(req.messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.match(req.messages[1].content, /built: Lighting lanterns/);
    const a = lastAssistant(e);
    assert.equal(a.build.repair, true);
    assert.equal(a.build.status, 'done');
    assert.equal(a.build.toVersion, 5);
    assert.equal(a.text, 'Lanterns!\n\nFixed!');
  });

  test('the repair round happens only once', async () => {
    const run = jobs([saves('Lanterns!', 4), saves('Fixed!', 5, { t: T2 })]);
    const e = engineWith(run);
    e.setHost(makeHost().host);
    await e.send('add lanterns');
    e.reportRuntimeError({ message: 'TypeError: a' });
    e.reportReady();
    await waitFor(() => run.requests.length === 2 && !e.getSnapshot().isBuilding, 2000, 'repair done');
    e.reportRuntimeError({ message: 'TypeError: b' });
    e.reportReady();
    await sleep(500);
    assert.equal(run.requests.length, 2);
  });

  test('a failed automatic fix leaves the saved build standing', async () => {
    const run = jobs([saves('Lanterns!', 4), new BuildError('unknown', 'Something went wrong. Please try again.', undefined, 500)]);
    const e = engineWith(run);
    e.setHost(makeHost().host);
    await e.send('add lanterns');
    e.reportRuntimeError({ message: 'TypeError: lantern is undefined', line: 120 });
    e.reportReady();
    await waitFor(() => run.requests.length === 2, 2000, 'repair request');
    await waitFor(() => !e.getSnapshot().isBuilding, 2000, 'repair done');
    const a = lastAssistant(e);
    assert.equal(a.build.status, 'done', 'not an error: the world was saved');
    assert.equal(a.build.error, undefined);
    assert.equal(a.build.toVersion, 4);
    assert.equal(a.build.repairFailed, 'unknown 500: Something went wrong. Please try again.');
    assert.equal(a.text, 'Lanterns!');
  });

  test('no runtime errors → no repair round', async () => {
    const run = jobs([saves('More!', 4)]);
    const e = engineWith(run);
    e.setHost(makeHost().host);
    await e.send('more');
    e.reportReady();
    await sleep(150);
    assert.equal(run.requests.length, 1);
  });

  test('runtime errors are still checked when the world never reports ready', async () => {
    const run = jobs([saves('More!', 4), [{ text: '<orb:say>ok</orb:say>' }]]);
    const e = engineWith(run);
    e.setHost(makeHost().host);
    await e.send('more');
    e.reportRuntimeError({ message: 'SyntaxError: Unexpected token' });
    await waitFor(() => run.requests.length === 2, 2000, 'repair after ready timeout');
  });
});

describe('BuildEngine — stop, errors, undo', () => {
  test('Stop ends the build at once: what it saved stays, open steps fail, and it shows the credits it used', async () => {
    const run = jobs([[...saves('Lanterns!', 4).slice(0, 3), { credits: 5 }, { step: { id: 's9', kind: 'edit', label: 'Hanging the moon', status: 'pending' } }, { text: '', wait: 10_000 }]]);
    const e = engineWith(run);
    e.setHost(makeHost().host);
    const p = e.send('lanterns and a moon');
    await waitFor(() => lastAssistant(e)?.build.steps.some((s) => s.id === 's9'), 3000, 'the open step');
    e.stop();
    await p;
    const a = lastAssistant(e);
    assert.equal(a.build.status, 'stopped');
    assert.equal(a.build.toVersion, 4);
    assert.equal(a.build.credits, 5);
    assert.deepEqual(a.build.steps.map((s) => [s.label, s.status]), [
      ['Lighting lanterns', 'done'],
      ['Hanging the moon', 'failed'],
    ]);
    assert.equal(e.getSnapshot().isBuilding, false);
  });

  test('rate limit: friendly error, countdown, user text kept', async () => {
    const run = jobs([new BuildError('rate_limited', 'Whoa, speedy! Give Orb a few seconds between builds.', 7)]);
    const e = engineWith(run);
    e.setHost(makeHost().host);
    await e.send('build a castle');
    const snap = e.getSnapshot();
    assert.equal(snap.messages[0].text, 'build a castle');
    assert.equal(snap.messages[1].build.status, 'error');
    assert.match(snap.messages[1].build.error, /speedy/);
    assert.equal(snap.retryAfter, 7);
    assert.equal(local.loadChatMessages(snap.threadId)[0].text, 'build a castle');
  });

  test('retry: a failed request is asked again in its place', async () => {
    const run = jobs([new BuildError('bot_detected', "Orb couldn't tell that a person sent this."), saves('A castle!', 2)]);
    const e = engineWith(run);
    e.setHost(makeHost().host);
    await e.send('build a castle');
    const failed = lastAssistant(e);
    assert.equal(failed.build.status, 'error');
    await e.retry(failed.id);
    const msgs = e.getSnapshot().messages;
    assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant']);
    assert.equal(msgs[0].text, 'build a castle');
    assert.notEqual(msgs[1].build.status, 'error');
    assert.equal(run.requests.length, 2);
    assert.equal(run.requests[1].messages.length, 1); // the failed exchange isn't history
  });

  test('ai_unavailable suggests adding a key', async () => {
    const run = jobs([new BuildError('ai_unavailable', 'customer_verification_required')]);
    const e = engineWith(run);
    e.setHost(makeHost().host);
    await e.send('castle');
    assert.match(lastAssistant(e).build.error, /You → Model/);
  });

  test('a dropped connection keeps what the job saved', async () => {
    const run = jobs([[...saves('Lanterns!', 4).slice(0, 3), { step: { id: 's9', kind: 'edit', label: 'Hanging the moon', status: 'pending' } }, { error: new BuildError('network', 'The connection dropped while building — try again.') }]]);
    const e = engineWith(run);
    e.setHost(makeHost().host);
    await e.send('lanterns');
    const a = lastAssistant(e);
    assert.equal(a.build.status, 'error');
    assert.match(a.build.error, /connection dropped/);
    assert.equal(a.build.toVersion, 4);
    assert.deepEqual(a.build.steps.map((s) => s.status), ['done', 'failed']);
  });

  test('an in-band <orb:error> becomes a build error', async () => {
    const run = jobs([[{ text: '<orb:say>Starting</orb:say>\n<orb:error>Overloaded</orb:error>\n' }]]);
    const e = engineWith(run);
    e.setHost(makeHost().host);
    await e.send('x');
    assert.match(lastAssistant(e).build.error, /Overloaded/);
  });

  test('undo restores the version before the build and marks it undone', async () => {
    const run = jobs([saves('More trees!', 8)]);
    const e = engineWith(run);
    const { host, calls } = makeHost({ version: 7 });
    e.setHost(host);
    await e.send('more trees');
    const a = lastAssistant(e);
    assert.equal(a.build.fromVersion, 7);
    assert.equal(a.build.toVersion, 8);
    await e.undo(a.id);
    assert.deepEqual(calls.restores, [7]);
    assert.equal(lastAssistant(e).build.undone, true);
    await e.undo(a.id); // idempotent
    assert.deepEqual(calls.restores, [7]);
  });
});

describe('BuildEngine — the start canvas', () => {
  test('the first build makes the world at once, works on it, and its chat moves along', async () => {
    const run = jobs([[{ wait: 30 }, ...saves('A meadow!', 2, { w: 'w-made' })]]);
    const e = engineWith(run);
    const { host } = makeHost({ code: page('Canvas'), version: null, host: { chatKey: 'new', worldId: null } });
    const made = { ...host, chatKey: 'w-made', worldId: 'w-made', worldName: 'Untitled world' };
    host.createWorld = async (threadId) => {
      // like the world store: the canvas chat belongs to the new world, which the app then shows
      const t = local.listChats().find((x) => x.id === threadId);
      local.saveChatThread({ ...t, worldId: 'w-made' });
      setTimeout(() => e.setHost(made), 0);
      return { worldId: 'w-made', version: 1 };
    };
    e.setHost(host);
    await e.send('a meadow');
    const snap = e.getSnapshot();
    assert.equal(run.requests[0].worldId, 'w-made');
    assert.equal(snap.messages.length, 2);
    assert.deepEqual(snap.threads.map((t) => t.worldId), ['w-made']);
    assert.equal(local.listChats().find((t) => t.id === snap.threadId).worldId, 'w-made');
    assert.equal(lastAssistant(e).build.fromVersion, 1);
    assert.equal(lastAssistant(e).build.toVersion, 2);
  });

  test("when its world can't be made, the build says so and nothing runs", async () => {
    const run = jobs([]);
    const e = engineWith(run);
    const { host } = makeHost({ version: null, host: { chatKey: 'new', worldId: null, createWorld: async () => null } });
    e.setHost(host);
    await e.send('a meadow');
    const a = lastAssistant(e);
    assert.equal(a.build.status, 'error');
    assert.match(a.build.error, /Couldn't make your new world/);
    assert.equal(run.requests.length, 0);
    assert.equal(e.getSnapshot().isBuilding, false);
  });
});

describe('BuildEngine — threads', () => {
  test('opening a world resumes its latest chat; new/switch threads', async () => {
    const run = jobs([[{ text: '<orb:say>one</orb:say>' }], [{ text: '<orb:say>two</orb:say>' }]]);
    const e = engineWith(run);
    e.setHost(makeHost().host);
    await e.send('first chat');
    const first = e.getSnapshot().threadId;
    e.newThread();
    assert.notEqual(e.getSnapshot().threadId, first);
    assert.equal(e.getSnapshot().messages.length, 0);
    assert.equal(e.getSnapshot().threads.length, 2); // draft + saved
    e.newThread(); // no-op while on an empty draft
    assert.equal(e.getSnapshot().threads.length, 2);
    await sleep(3); // distinct updatedAt timestamps
    await e.send('second chat');
    const second = e.getSnapshot().threadId;
    e.switchThread(first);
    assert.equal(e.getSnapshot().messages[0].text, 'first chat');

    // a fresh engine (page reload) on the same world resumes the most recent chat
    const e2 = engineWith(jobs([]));
    e2.setHost(makeHost().host);
    assert.equal(e2.getSnapshot().threadId, second);
    assert.equal(e2.getSnapshot().messages[0].text, 'second chat');
    // the start canvas always starts fresh
    const e3 = engineWith(jobs([]));
    e3.setHost(makeHost({ host: { chatKey: 'new' } }).host);
    assert.equal(e3.getSnapshot().messages.length, 0);
  });

  test('a build keeps going when you switch worlds, and its versions go to its own world', async () => {
    const run = jobs([island()]);
    const e = engineWith(run);
    const { host, calls } = makeHost();
    const done = [];
    host.onBackgroundDone = (info) => done.push(info);
    e.setHost(host);
    const p = e.send('island');
    const threadId = e.getSnapshot().threadId;
    await waitFor(() => lastAssistant(e)?.build.steps.length > 0, 2000, 'a step');
    const previewsBefore = calls.previews.length;
    e.setHost({ ...host, chatKey: 'other', worldId: 'other' });
    // the other world is free to build, and shows the running build as a background one
    assert.equal(e.getSnapshot().isBuilding, false);
    assert.deepEqual(e.getSnapshot().background, [{ chatKey: 'w1', worldName: 'Sky Island' }]);
    await p;
    assert.deepEqual(calls.adopted.map((v) => [v.worldId, v.version]), [['w1', 4]]);
    assert.equal(calls.previews.length, previewsBefore, 'no previews into the other world');
    assert.equal(done.length, 1);
    assert.equal(done[0].chatKey, 'w1');
    assert.equal(done[0].status, 'done');
    assert.deepEqual(e.getSnapshot().background, []);
    // back on the first world: its chat shows the finished build
    e.setHost(host);
    assert.equal(e.getSnapshot().threadId, threadId);
    assert.equal(lastAssistant(e).build.status, 'done');
    assert.equal(lastAssistant(e).build.toVersion, 4);
  });

  test('coming back to a world that is still building shows its chat and live preview', async () => {
    const run = jobs([[{ handle: { kind: 'agent', id: 'job-1' } }, { tree: T1 }, { text: '<orb:say>Still going</orb:say>', wait: 400 }]]);
    const e = engineWith(run);
    const { host, calls } = makeHost();
    e.setHost(host);
    const p = e.send('island');
    const threadId = e.getSnapshot().threadId;
    await waitFor(() => calls.previews.length > 0, 3000, 'a preview');
    e.setHost({ ...host, chatKey: 'other', worldId: 'other' });
    const n = calls.previews.length;
    e.setHost(host);
    assert.equal(e.getSnapshot().threadId, threadId);
    assert.equal(e.getSnapshot().isBuilding, true);
    assert.ok(calls.previews.length > n, 'the build so far is shown again');
    await p;
    assert.equal(lastAssistant(e).build.status, 'done');
  });

  test('worlds can build at the same time; at most MAX_PARALLEL_BUILDS', async () => {
    const run = jobs(Array.from({ length: MAX_PARALLEL_BUILDS }, (_, i) => saves('Building!', 4, { w: `p${i}` }).map((s) => ({ ...s, wait: 40 }))));
    const e = engineWith(run);
    const hosts = Array.from({ length: MAX_PARALLEL_BUILDS + 1 }, (_, i) => makeHost({ host: { chatKey: `p${i}`, worldId: `p${i}`, worldName: `World ${i}` } }));
    const sends = [];
    for (const { host } of hosts.slice(0, MAX_PARALLEL_BUILDS)) {
      e.setHost(host);
      sends.push(e.send('island'));
      assert.equal(e.getSnapshot().isBuilding, true);
    }
    const last = hosts[MAX_PARALLEL_BUILDS];
    e.setHost(last.host);
    assert.equal(e.getSnapshot().background.length, MAX_PARALLEL_BUILDS);
    await e.send('one more');
    assert.equal(e.getSnapshot().isBuilding, false);
    assert.match(lastAssistant(e).text, /already building/);
    await Promise.all(sends);
    assert.equal(run.requests.length, MAX_PARALLEL_BUILDS);
    hosts.slice(0, MAX_PARALLEL_BUILDS).forEach(({ calls }, i) => assert.deepEqual(calls.adopted.map((v) => v.worldId), [`p${i}`]));
    assert.equal(last.calls.adopted.length, 0);
  });
});

describe('BuildEngine — surviving reloads', () => {
  test('a build cut off by a reload is picked up again from its job, without duplicates', async () => {
    const script = island();
    // first page: the job's handle arrives, then the page goes away mid-build
    const e = engineWith(jobs([[...script.slice(0, 4), { text: '', wait: 10_000 }]]));
    const { host } = makeHost();
    e.setHost(host);
    const p = e.send('island');
    const threadId = e.getSnapshot().threadId;
    await waitFor(() => lastAssistant(e)?.build.handles?.length === 1, 2000, 'a handle');
    e.dispose(); // the page unloads: nothing is marked stopped, nothing is cancelled
    await p;
    const saved = local.loadChatMessages(threadId).at(-1);
    assert.equal(saved.build.status, 'streaming');
    assert.deepEqual(saved.build.handles, [{ kind: 'agent', id: 'job-w1' }]);
    assert.equal(saved.build.base, 'w1@3');

    // the reloaded page reconnects and the job's output plays again from the start
    const resumed = [];
    const replay = jobs([script]);
    const e2 = engineWith(jobs([]), {
      resumeBuild: (handle, settings, signal, hooks) => {
        resumed.push(handle);
        return replay(null, settings, signal, hooks);
      },
    });
    const h2 = makeHost();
    e2.setHost(h2.host);
    await waitFor(() => lastAssistant(e2)?.build.status === 'done', 3000, 'the resumed build to finish');
    assert.deepEqual(resumed, [{ kind: 'agent', id: 'job-w1' }]);
    assert.equal(lastAssistant(e2).text, 'Ooh, a floating island — let’s make it!\n\nDrag to look around — the clouds drift by slowly.');
    assert.equal(lastAssistant(e2).build.toVersion, 4);
    assert.equal(lastAssistant(e2).build.handles, undefined);
    // the chat shows one question and one answer (no duplicates)
    assert.deepEqual(e2.getSnapshot().messages.map((m) => m.role), ['user', 'assistant']);
  });

  test('a build from before every build was an agent job is marked stopped, not picked up', async () => {
    const now = Date.now();
    local.saveChatThread({ id: 't-old', worldId: 'w1', title: 'island', createdAt: now - 60_000, updatedAt: now - 30_000 });
    local.saveChatMessages('t-old', [
      { id: 'u1', role: 'user', text: 'island', createdAt: now - 60_000 },
      { id: 'a1', role: 'assistant', text: 'Building!', createdAt: now - 50_000, build: { status: 'streaming', steps: [{ id: 'x', kind: 'edit', label: 'Raising', status: 'pending' }], handles: [{ kind: 'job', id: 'old-job' }], base: 'w1@3' } },
    ]);
    const e = engineWith(jobs([]), { resumeBuild: async function* () { throw new Error('must not resume'); } });
    e.setHost(makeHost().host);
    const a = lastAssistant(e);
    assert.equal(a.build.status, 'stopped');
    assert.equal(a.build.handles, undefined);
    assert.equal(a.build.steps[0].status, 'failed');
  });

  test('a build interrupted in another world than the one on screen is marked stopped after a while', async () => {
    const e = engineWith(jobs([[{ handle: { kind: 'agent', id: 'job-2' } }, { text: '<orb:say>hi</orb:say>' }, { text: '', wait: 10_000 }]]));
    const { host } = makeHost({ host: { chatKey: 'w2', worldId: 'w2' } });
    e.setHost(host);
    const p = e.send('hello');
    const threadId = e.getSnapshot().threadId;
    await waitFor(() => lastAssistant(e)?.build.handles?.length === 1, 2000, 'a handle');
    e.dispose();
    await p;
    // the chat now lives in another world (e.g. carried over), but its build ran in w2
    const t = local.listChats().find((x) => x.id === threadId);
    local.saveChatThread({ ...t, worldId: 'w3' });
    const e2 = engineWith(jobs([]), { resumeBuild: async function* () { throw new Error('must not resume'); } });
    e2.setHost(makeHost({ host: { chatKey: 'w3', worldId: 'w3' } }).host);
    // waits a while for the right world, then gives up (simulate the wait elapsing)
    const real = Date.now;
    Date.now = () => real() + 20_000;
    try {
      e2.setHost({ ...makeHost({ host: { chatKey: 'w3', worldId: 'w3' } }).host });
    } finally {
      Date.now = real;
    }
    assert.equal(lastAssistant(e2).build.status, 'stopped');
  });
});
