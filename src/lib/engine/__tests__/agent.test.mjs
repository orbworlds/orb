// BuildEngine following a build's agent job: the server works on the world's files and saves
// versions itself; the page follows the job (steps, live trees, versions) and answers its looks.
import './setup.mjs';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { BuildEngine } = await import('../useBuild.ts');
const { BuildError } = await import('../client.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 2000, what = 'condition') {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const T1 = 'a'.repeat(64);
const T2 = 'b'.repeat(64);
const PAGES = { [T1]: '<!DOCTYPE html><html><head><title>One</title></head><body>one</body></html>', [T2]: '<!DOCTYPE html><html><head><title>Two</title></head><body>two</body></html>' };

/** A fake agent job: hooks + protocol text, like client.runBuild would deliver them. */
function agentRun(script) {
  const requests = [];
  async function* run(req, settings, signal, hooks = {}) {
    requests.push(req);
    for (const s of script) {
      if (signal.aborted) throw new BuildError('aborted', 'Stopped.');
      await sleep(s.wait ?? 2);
      if (s.text) yield s.text;
      if (s.handle) hooks.onHandle?.(s.handle);
      if (s.step) hooks.onStep?.(s.step);
      if (s.tree) hooks.onTree?.(s.tree);
      if (s.version) hooks.onVersion?.(s.version);
      if (s.look) hooks.onLook?.(s.look);
      if (s.looked) hooks.onLooked?.(s.looked);
    }
  }
  run.requests = requests;
  return run;
}

const SCRIPT = [
  { handle: { kind: 'agent', id: 'job1' } },
  { text: '<orb:say>Building it now!</orb:say>' },
  { step: { id: 's1', kind: 'write', label: 'Writing…', status: 'pending' } },
  { step: { id: 's1', kind: 'write', label: 'Laying out the garden', status: 'pending' } },
  { step: { id: 's1', kind: 'write', label: 'Laying out the garden', status: 'done' } },
  { tree: T1, wait: 200 },
  { step: { id: 's2', kind: 'edit', label: 'Shifting the colors', status: 'done' } },
  { tree: T2, wait: 200 },
  { version: { worldId: 'w1', version: 4, tree: T2, name: 'Mock Garden' } },
  { text: '<orb:title>Mock Garden</orb:title><orb:say>Ready!</orb:say><orb:suggest>a|b|c</orb:suggest>' },
];

function makeHost(over = {}) {
  const calls = { previews: [], adopted: [] };
  const state = { code: '<!DOCTYPE html><html><body>old</body></html>', version: 3 };
  const host = {
    chatKey: 'w1',
    mode: 'build',
    worldName: 'Untitled world',
    worldId: 'w1',
    getCode: () => state.code,
    getVersion: () => state.version,
    preview: (c) => calls.previews.push(c),
    adoptVersion: (v) => {
      calls.adopted.push(v);
      state.code = v.code;
      state.version = v.version;
    },
    restore: async () => {},
    ...over,
  };
  return { host, calls, state };
}

function engineWith(run, opts = {}) {
  return new BuildEngine({
    runBuild: run,
    resumeBuild: opts.resumeBuild,
    getSettings: () => ({ provider: 'free' }),
    loadTree: async (t) => PAGES[t],
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

describe('BuildEngine — agent builds', () => {
  test('follows the job: steps, live previews of its files, the saved version', async () => {
    const run = agentRun(SCRIPT);
    const e = engineWith(run);
    const { host, calls, state } = makeHost();
    e.setHost(host);
    await e.send('a garden');
    const a = lastAssistant(e);
    assert.equal(a.build.status, 'done');
    assert.equal(a.text, 'Building it now!\n\nReady!');
    assert.deepEqual(a.build.steps.map((s) => [s.id, s.label, s.status]), [
      ['s1', 'Laying out the garden', 'done'],
      ['s2', 'Shifting the colors', 'done'],
    ]);
    assert.deepEqual(a.build.suggestions, ['a', 'b', 'c']);
    assert.equal(a.build.fromVersion, 3);
    assert.equal(a.build.toVersion, 4);
    assert.equal(calls.adopted.length, 1, 'the server saved it; the page takes the version over');
    assert.equal(calls.adopted[0].code, PAGES[T2]);
    assert.equal(calls.adopted[0].tree, T2);
    assert.equal(state.version, 4);
    // previews carry a <base> into the tree's files
    assert.ok(calls.previews.some((p) => p.includes(`<base data-orb-base href="`) && p.includes(`/api/tree/${T1}/">`)));
    // (the final state reaches the screen through adoptVersion)
    // the request names the world (the agent reads its files itself)
    const req = run.requests[0];
    assert.equal(req.worldId, 'w1');
    assert.equal('code' in req, false);
  });

  test('Stop ends the job and keeps what was saved', async () => {
    const run = agentRun([...SCRIPT.slice(0, 6), { text: '', wait: 5000 }]);
    const e = engineWith(run);
    const { host } = makeHost();
    e.setHost(host);
    const p = e.send('a garden');
    await waitFor(() => lastAssistant(e)?.build?.steps.length === 1, 2000, 'first step');
    e.stop();
    await p;
    assert.equal(lastAssistant(e).build.status, 'stopped');
  });

  test('after a reload, an agent build is picked up again even though the world moved on', async () => {
    const run = agentRun(SCRIPT.slice(0, 5).concat([{ text: '', wait: 5000 }]));
    const e1 = engineWith(run);
    const { host } = makeHost();
    e1.setHost(host);
    void e1.send('a garden');
    await waitFor(() => lastAssistant(e1)?.build?.handles?.[0]?.kind === 'agent', 2000, 'handle');
    const threadId = e1.getSnapshot().threadId;
    e1.dispose();
    await sleep(30);

    // A new page: the world is at a newer version (the job saved a checkpoint meanwhile).
    const replays = [];
    const resume = async function* (handle, settings, signal, hooks = {}) {
      replays.push(handle);
      hooks.onHandle?.(handle);
      yield '<orb:say>Building it now!</orb:say>';
      hooks.onVersion?.({ worldId: 'w1', version: 6, tree: T2 });
      yield '<orb:say>Ready!</orb:say>';
    };
    const e2 = engineWith(agentRun([]), { resumeBuild: resume });
    const { host: host2, calls: calls2 } = makeHost({ getVersion: () => 5 });
    e2.setHost(host2);
    e2.switchThread(threadId);
    await waitFor(() => lastAssistant(e2)?.build?.status === 'done', 3000, 'resumed build to finish');
    assert.deepEqual(replays, [{ kind: 'agent', id: 'job1' }]);
    assert.equal(lastAssistant(e2).text, 'Building it now!\n\nReady!');
    assert.equal(lastAssistant(e2).build.toVersion, 6);
    assert.equal(calls2.adopted.length, 1);
  });
});

describe('BuildEngine — the agent looks at the world', () => {
  const LOOK = { job: 'job1', id: 'look1', tree: T1, actions: [{ type: 'click', x: 0.5, y: 0.5 }], size: 768, shots: 4 };
  const SEEN = { size: { w: 800, h: 600, dpr: 1 }, fps: 60, errors: [], shots: [] };

  function lookEngine(script, host) {
    const sent = [];
    const e = engineWith(agentRun(script), { sendLook: async (job, id, answer) => void sent.push({ job, id, answer }) });
    e.setHost(host);
    return { e, sent };
  }

  test('the page showing the world plays it with those files and sends back what it saw', async () => {
    const looks = [];
    const { host, calls } = makeHost({ look: async (req, signal) => (looks.push({ ...req, stoppable: signal instanceof AbortSignal }), SEEN) });
    const { e, sent } = lookEngine([{ handle: { kind: 'agent', id: 'job1' } }, { look: LOOK }, { text: '<orb:say>Checked!</orb:say>', wait: 900 }], host);
    await e.send('a garden');
    await waitFor(() => sent.length === 1, 3000, 'the answer');
    assert.deepEqual(looks, [{ tree: T1, actions: LOOK.actions, size: 768, shots: 4, stoppable: true }]);
    assert.deepEqual(sent, [{ job: 'job1', id: 'look1', answer: { result: SEEN } }]);
    assert.ok(calls.previews.some((p) => p.includes(`/api/tree/${T1}/`) && p.includes('<title>One</title>')), 'the files it looks at are shown first');
  });

  test('a look that is over by the time it arrives (a replay) is not answered', async () => {
    const looks = [];
    const { host } = makeHost({ look: async (req) => (looks.push(req), SEEN) });
    const { e, sent } = lookEngine([{ handle: { kind: 'agent', id: 'job1' } }, { look: LOOK }, { looked: 'look1', wait: 0 }, { text: '<orb:say>Done</orb:say>', wait: 700 }], host);
    await e.send('a garden');
    await sleep(100);
    assert.equal(looks.length, 0);
    assert.equal(sent.length, 0);
  });

  test("a page that can't look says why: another world on screen, or no way to look", async () => {
    const { host } = makeHost({ look: async () => SEEN });
    const { e, sent } = lookEngine([{ handle: { kind: 'agent', id: 'job1' } }, { wait: 150 }, { look: LOOK }, { text: '<orb:say>Done</orb:say>', wait: 800 }], host);
    const done = e.send('a garden');
    await sleep(40);
    e.setHost(makeHost({ chatKey: 'w2', worldId: 'w2' }).host); // the person moved on to another world
    await done;
    await waitFor(() => sent.length === 1, 3000, 'the answer');
    assert.match(sent[0].answer.unavailable, /not on screen/);

    const { host: blind } = makeHost();
    const { e: e2, sent: sent2 } = lookEngine([{ handle: { kind: 'agent', id: 'job1' } }, { look: { ...LOOK, id: 'look2' } }, { text: '<orb:say>Done</orb:say>', wait: 800 }], blind);
    await e2.send('a garden');
    await waitFor(() => sent2.length === 1, 3000, 'the answer');
    assert.equal(sent2[0].id, 'look2');
    assert.match(sent2[0].answer.unavailable, /not on screen/);
  });

  test('after a reload, replayed looks that are over are skipped quickly; the live one is answered at once', async () => {
    const { host } = makeHost({ look: async () => SEEN });
    const replay = Array.from({ length: 12 }, (_, i) => [{ look: { ...LOOK, id: `old${i}` }, wait: 0 }, { looked: `old${i}`, wait: 0 }]).flat();
    const t0 = Date.now();
    const { e, sent } = lookEngine([{ handle: { kind: 'agent', id: 'job1' } }, ...replay, { look: { ...LOOK, id: 'live' }, wait: 0 }, { text: '<orb:say>Done</orb:say>', wait: 1500 }], host);
    const done = e.send('a garden');
    await waitFor(() => sent.length === 1, 3000, 'the live answer');
    const took = Date.now() - t0;
    assert.deepEqual(sent.map((s) => s.id), ['live']);
    assert.ok(took < 1200, `took ${took} ms`);
    await done;
  });

  test('looks are answered one at a time', async () => {
    let busy = 0;
    let overlap = false;
    const { host } = makeHost({
      look: async () => {
        if (busy++) overlap = true;
        await sleep(120);
        busy--;
        return SEEN;
      },
    });
    const { e, sent } = lookEngine([{ handle: { kind: 'agent', id: 'job1' } }, { look: LOOK }, { look: { ...LOOK, id: 'look2' }, wait: 0 }, { text: '<orb:say>Done</orb:say>', wait: 1400 }], host);
    await e.send('a garden');
    await waitFor(() => sent.length === 2, 3000, 'both answers');
    assert.equal(overlap, false);
    assert.deepEqual(sent.map((s) => s.id), ['look1', 'look2']);
  });
});
