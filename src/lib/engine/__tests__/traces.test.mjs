// Traces of AI builds (src/server/traces.ts): what goes into blobs, the numbers kept for SQL, and
// recording, reading, exporting and pruning against an in-memory PGlite with the app's schema.
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DDL } from '../../../server/ddl.mjs';

// Only the module resolution of ./setup.mjs: its browser globals would confuse PGlite.
register('./resolve-hooks.mjs', import.meta.url);

const traces = await import('../../../server/traces.ts');

const WEBP = 'UklGRqgAAABXRUJQVlA4IJwAAABQBQCdASogABIAPm0skUWkIqGYBABABsS0AF2ZmiFf1NW3zfbUCyoGZvMHWVF2Yf+IoUAA/c7n4+XIvBZ3u3RqF5R7ML/Qf+c5DBAt+X/85Fm00pZ9p+yanuNOcxQc+Ogsw5yPH4yKOqtCbhrcyBkDZkXcJ63baOZzQhfHvXNY9/oDBn3R1H/abAHrojUv/qpVjDxiLT/sn4tAAAA=';
const SHOT = `data:image/webp;base64,${WEBP}`;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const sha = (b64) => sha256(Buffer.from(b64, 'base64'));

describe('blobs in payloads', () => {
  test('data URLs, base64 image parts and bytes become blob references', () => {
    const blobs = [];
    const out = traces.stash(
      {
        shot: SHOT,
        part: { type: 'file', mediaType: 'image/webp', data: WEBP },
        tagged: { type: 'file', mediaType: 'image/webp', data: { type: 'data', data: WEBP } },
        bytes: new Uint8Array([1, 2, 3]),
        text: 'just words',
        short: 'data:image/png;base64,AAAA',
        when: new Date('2026-01-02T03:04:05Z'),
      },
      blobs,
    );
    const ref = `orb-blob:${sha(WEBP)}`;
    assert.equal(out.shot, ref);
    assert.equal(out.part.data, ref);
    assert.deepEqual(out.tagged.data, { type: 'data', data: ref });
    assert.match(out.bytes, /^orb-blob:[a-f0-9]{64}$/);
    assert.equal(out.text, 'just words');
    assert.equal(out.short, 'data:image/png;base64,AAAA', 'tiny data URLs stay');
    assert.equal(out.when, '2026-01-02T03:04:05.000Z');
    assert.equal(blobs.length, 4);
    assert.deepEqual([...new Set(blobs.map((b) => b.type))], ['image/webp', null]);
  });

  test('screenshot references point at their blobs', () => {
    const refs = new Map([['orb-look:LOOK1:0', 'orb-blob:' + 'a'.repeat(64)]]);
    const out = traces.stash([{ type: 'file', mediaType: 'image/webp', data: { type: 'data', data: 'orb-look:LOOK1:0' } }, 'orb-look:LOOK1:1'], [], refs);
    assert.deepEqual(out[0].data, { type: 'data', data: 'orb-blob:' + 'a'.repeat(64) });
    assert.equal(out[1], 'orb-look:LOOK1:1', 'unknown references stay as they are');
  });
});

describe('the numbers kept for SQL', () => {
  test('a step in numbers', () => {
    const p = traces.stepParts([
      { role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'Building!' }, { type: 'tool-call', toolCallId: 'a', toolName: 'write_file', input: {} }, { type: 'tool-call', toolCallId: 'b', toolName: 'look', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'write_file', output: { type: 'error-text', value: 'nope' } }, { type: 'tool-result', toolCallId: 'b', toolName: 'look', output: { type: 'text', value: 'ok' } }] },
      { role: 'user', content: [{ type: 'text', text: '(Screenshots from your look.)' }] },
    ]);
    assert.deepEqual(p, { tools: ['write_file', 'look'], toolErrors: 1, text: 9, thinking: 3 });
  });

  test('tokens as the AI SDK reports them', () => {
    assert.deepEqual(traces.tokensOf({ inputTokens: 1200, outputTokens: 300.4, inputTokenDetails: { cacheReadTokens: 1000, cacheWriteTokens: undefined }, outputTokenDetails: { reasoningTokens: 50 } }), { in: 1200, out: 300, cacheRead: 1000, cacheWrite: 0, reasoning: 50 });
    assert.equal(traces.tokensOf(undefined), undefined);
  });

  test('the chat turn a build belongs to', () => {
    const req = (g) => new Request('http://x/', { headers: g ? { 'x-orb-trace-group': g } : {} });
    assert.equal(traces.traceGroup(req('0b0e8f6e-6c43-4a8e-9a43-0c2d2b1c9f10')), '0b0e8f6e-6c43-4a8e-9a43-0c2d2b1c9f10');
    assert.equal(traces.traceGroup(req('no spaces please')), null);
    assert.equal(traces.traceGroup(req('')), null);
  });
});

describe('traces in the database', () => {
  let db;
  let pg;
  before(async () => {
    pg = new PGlite();
    await pg.exec(DDL);
    db = { query: async (sql, params = []) => (await pg.query(sql, params)).rows, kind: 'pglite' };
    await db.query(`insert into orb_users (id, name) values ('u1', 'Ada')`);
    await db.query(`insert into orb_worlds (id, name) values ('w1', 'Glow Garden')`);
  });
  after(() => pg.close());

  const SYSTEM = 'You are Orb. '.repeat(200);
  const lookId = 'LOOKabc123';
  const stepMessages = [
    { role: 'assistant', content: [{ type: 'reasoning', text: 'Let me look.' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'look', input: { actions: [] } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'look', output: { type: 'content', value: [{ type: 'text', text: 'saw it' }, { type: 'file', mediaType: 'image/webp', data: { type: 'data', data: `orb-look:${lookId}:0` } }] } }] },
  ];

  test('an agent build, start to end', async () => {
    const html = Buffer.from('<!doctype html><title>Glow</title>');
    const index = { sha: sha256(html) };
    const tree = sha256(JSON.stringify({ 'index.html': index.sha }));
    await db.query(`insert into orb_blobs (sha, data, size) values ($1, $2, $3)`, [index.sha, html, html.length]);
    await db.query(`insert into orb_trees (sha, files, size, count) values ($1, $2::jsonb, $3, 1)`, [tree, JSON.stringify({ 'index.html': index.sha }), html.length]);
    const t = traces.startTrace(
      db,
      { id: 'TRACEagent0000000000001', group: 'chat-msg-1', kind: 'agent', worldId: 'w1', owner: { deviceHash: 'd'.repeat(64), userId: 'u1' }, provider: 'anthropic', model: 'claude-test', mode: 'build', prompt: 'a glowing garden', meta: { effort: 'high' } },
      { system: SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: '<request>a glowing garden</request>' }, { type: 'file', mediaType: 'image/webp', data: WEBP }] }], tree },
    );
    t.look({ lookId, callId: 'c1', actions: [{ type: 'click', x: 0.5, y: 0.5 }], skipped: 0, answer: { result: { fps: 58, errors: [], shots: [{ label: 'end', t: 2300, dataUrl: SHOT }] } }, ms: 2500 });
    t.step({ step: 1, messages: stepMessages, usage: { inputTokens: 1000, outputTokens: 200, inputTokenDetails: { cacheReadTokens: 800 }, outputTokenDetails: { reasoningTokens: 20 } }, finishReason: 'tool-calls', ms: 4100, modelId: 'claude-test' });
    t.error({ message: 'Overloaded', retry: true, status: 529, waitMs: 3000, failures: 1 });
    t.compact([{ role: 'user', content: 'x'.repeat(100) }], [{ role: 'user', content: 'x'.repeat(10) }]);
    const same = [{ role: 'user', content: 'same' }];
    t.compact(same, [...same]);
    t.note('nudge', { text: '(Your reply hit the output limit…)' });
    t.commit({ version: 2, tree, name: 'Glow Garden' });
    await t.handOver({ steps: 1 });
    const mid = await traces.getTrace(db, t.id);
    assert.equal(mid.status, 'running');
    assert.equal(mid.steps, 1, 'totals refreshed at a hand-over');
    t.step({ step: 2, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done!' }] }], usage: { inputTokens: 1500, outputTokens: 100 }, finishReason: 'stop', ms: 900 });
    await t.end('done', null, { tree, name: 'Glow Garden' });

    const row = await traces.getTrace(db, t.id);
    assert.equal(row.status, 'done');
    assert.equal(row.kind, 'agent');
    assert.equal(row.groupId, 'chat-msg-1');
    assert.equal(row.worldName, 'Glow Garden');
    assert.equal(row.who, 'Ada');
    assert.equal(row.device, 'dddddddddd');
    assert.equal(row.steps, 2);
    assert.deepEqual(row.tokens, { in: 2500, out: 300, cacheRead: 800, cacheWrite: 0, reasoning: 20 });
    assert.ok(row.endedAt && row.durationMs >= 0);
    assert.equal(row.meta.effort, 'high');
    assert.equal(row.meta.versions, 1);
    assert.equal(row.meta.looks, 1);
    assert.equal(row.meta.tree, tree);

    const events = await traces.traceEvents(db, t.id);
    assert.deepEqual(events.map((e) => e.type), ['input', 'look', 'step', 'retry', 'compact', 'note', 'commit', 'note', 'step', 'end']);
    assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i));
    const [input, lookEv, step] = events;
    assert.match(input.payload.system, /^orb-blob:[a-f0-9]{64}$/);
    assert.equal(input.payload.messages[0].content[1].data, `orb-blob:${sha(WEBP)}`, 'the request screenshot is a blob');
    assert.deepEqual(input.payload.files, { 'index.html': index.sha });
    assert.equal(input.summary.files, 1);
    assert.equal(lookEv.summary.outcome, 'seen');
    assert.equal(lookEv.summary.shots, 1);
    assert.equal(lookEv.payload.answer.result.shots[0].dataUrl, `orb-blob:${sha(WEBP)}`);
    assert.equal(step.payload.messages[1].content[0].output.value[1].data.data, `orb-blob:${sha(WEBP)}`, 'the step shows the look’s screenshot');
    assert.deepEqual(step.summary.tools, ['look']);
    assert.deepEqual(step.summary.usage, { in: 1000, out: 200, cacheRead: 800, cacheWrite: 0, reasoning: 20 });
    assert.equal(step.summary.thinking, 'Let me look.'.length);
    assert.equal(events[3].summary.status, 529);
    assert.deepEqual(events[4].summary, { chars: [JSON.stringify([{ role: 'user', content: 'x'.repeat(100) }]).length, JSON.stringify([{ role: 'user', content: 'x'.repeat(10) }]).length], messages: [1, 1] });
    assert.deepEqual(events[9].payload.files, { 'index.html': index.sha }, 'the files at the end');

    const shot = await traces.traceBlob(db, sha(WEBP));
    assert.equal(shot.type, 'image/webp');
    assert.equal(Buffer.from(shot.data).toString('base64'), WEBP);
    const page = await traces.traceBlob(db, index.sha);
    assert.equal(Buffer.from(page.data).toString('utf8'), '<!doctype html><title>Glow</title>');
    assert.match(page.type, /^text\/html/);
  });

  test('a second trace with the same system prompt stores it once; the rounds of a chat turn go together', async () => {
    const t = traces.startTrace(db, { id: 'TRACErepair000000000001', group: 'chat-msg-1', kind: 'cursor', provider: 'free', model: 'mock', prompt: 'fix the lanterns' }, { system: SYSTEM, messages: [{ role: 'user', content: 'fix the lanterns' }] });
    t.step({ step: 1, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Fixed!' }] }], usage: { inputTokens: 5000, outputTokens: 700 }, finishReason: 'stop', ms: 800 });
    await t.end('done', null);
    const row = await traces.getTrace(db, t.id);
    assert.equal(row.status, 'done');
    assert.equal(row.steps, 1);
    assert.equal(row.tokens.in, 5000);
    const events = await traces.traceEvents(db, t.id);
    assert.deepEqual(events.map((e) => e.type), ['input', 'step', 'end']);
    const systems = await db.query(`select count(*)::int as n from orb_trace_blobs where media_type like 'text/plain%'`);
    assert.equal(systems[0].n, 1);
    const rounds = await traces.traceRounds(db, 'chat-msg-1');
    assert.deepEqual(rounds.map((r) => r.id), ['TRACEagent0000000000001', 'TRACErepair000000000001']);
  });

  test('a build that failed, and one that was stopped', async () => {
    const failed = traces.startTrace(db, { id: 'TRACEfail00000000000001', kind: 'cursor', provider: 'free', prompt: 'x' });
    failed.error({ message: 'The AI is busy', retry: false });
    await failed.end('failed', 'The AI is busy');
    const f = await traces.getTrace(db, failed.id);
    assert.equal(f.status, 'failed');
    assert.equal(f.error, 'The AI is busy');

    const stopped = traces.startTrace(db, { id: 'TRACEstop00000000000001', kind: 'cursor', provider: 'free', prompt: 'y' });
    stopped.note('cut', { text: 'A step was cut short: charged an estimate of what it used.', usd: 0.03 });
    await stopped.end('cancelled');
    assert.equal((await traces.getTrace(db, stopped.id)).status, 'cancelled');
    assert.deepEqual((await traces.traceEvents(db, stopped.id)).map((e) => [e.type, e.summary.kind]), [['note', 'cut'], ['end', undefined]]);
  });

  test('a Cursor run’s stream becomes steps', async () => {
    const t = traces.startTrace(db, { id: 'TRACEcursorjob000001', kind: 'cursor', provider: 'cursor', prompt: 'c' });
    const seg = traces.cursorSegment(t, 0, 'run-1');
    seg.add('thinking', { text: 'Plan: ' });
    seg.add('assistant', { text: 'Building the garden.' });
    seg.add('tool_call', { callId: 'e1', name: 'edit_file', status: 'running', args: { path: 'src/config.js' } });
    seg.add('tool_call', { callId: 'e1', name: 'edit_file', status: 'completed' });
    seg.add('result', { status: 'FINISHED', text: 'done' });
    seg.end();
    traces.cursorSegment(t, 1, 'run-2').end();
    await t.end('done');
    const [step, end] = await traces.traceEvents(db, t.id);
    assert.equal(end.type, 'end');
    assert.deepEqual(step.summary.tools, ['edit_file']);
    assert.equal(step.payload.text, 'Building the garden.');
    assert.deepEqual(step.payload.tools[0].args, { path: 'src/config.js' });
    assert.equal(step.payload.tools[0].status, 'completed');
    assert.equal(step.summary.status, 'FINISHED');
  });

  test('lists, filters and totals', async () => {
    const all = await traces.listTraces(db);
    assert.ok(all.traces.length >= 5);
    assert.ok(all.traces.every((t, i, a) => i === 0 || a[i - 1].startedAt >= t.startedAt), 'newest first');
    assert.deepEqual((await traces.listTraces(db, { status: 'failed' })).traces.map((t) => t.id), ['TRACEfail00000000000001']);
    assert.deepEqual((await traces.listTraces(db, { q: 'LANTERNS' })).traces.map((t) => t.id), ['TRACErepair000000000001']);
    assert.deepEqual((await traces.listTraces(db, { kind: 'agent' })).traces.map((t) => t.id), ['TRACEagent0000000000001']);
    assert.equal((await traces.listTraces(db, { q: '100%' })).traces.length, 0, 'search is literal');
    const page = await traces.listTraces(db, {}, 0, 2);
    assert.equal(page.traces.length, 2);
    assert.equal(page.more, true);
    const totals = await traces.traceTotals(db, { kind: 'agent' });
    assert.equal(totals.traces, 1);
    assert.equal(totals.tokens.in, 2500);
    assert.ok(totals.bytes > 0);
  });

  test('JSONL export: decoded events, the system prompt inline, screenshots by reference or inline', async () => {
    const lines = [];
    for await (const l of traces.exportTraces(db, { id: 'TRACEagent0000000000001' })) lines.push(l);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].endsWith('\n'));
    const t = JSON.parse(lines[0]);
    assert.equal(t.id, 'TRACEagent0000000000001');
    assert.equal(t.events[0].payload.system, SYSTEM);
    assert.equal(t.events[1].payload.answer.result.shots[0].dataUrl, `orb-blob:${sha(WEBP)}`);
    assert.ok(!lines[0].includes('d'.repeat(64)), 'no device hash');
    const inlined = [];
    for await (const l of traces.exportTraces(db, { id: 'TRACEagent0000000000001', images: true })) inlined.push(JSON.parse(l));
    assert.equal(inlined[0].events[1].payload.answer.result.shots[0].dataUrl, SHOT);
    const since = [];
    for await (const l of traces.exportTraces(db, { since: new Date(Date.now() - 60_000), limit: 2 })) since.push(JSON.parse(l));
    assert.equal(since.length, 2);
    assert.ok(since[0].startedAt <= since[1].startedAt, 'oldest first');
    const failed = [];
    for await (const l of traces.exportTraces(db, { status: 'failed' })) failed.push(JSON.parse(l).id);
    assert.deepEqual(failed, ['TRACEfail00000000000001'], 'the list filters apply');
    assert.ok((await traces.traceProviders(db)).includes('anthropic'));
  });

  test('old traces are pruned only when ORB_TRACE_DAYS is set', async () => {
    assert.equal(await traces.pruneTraces(db, NaN), 0);
    await db.query(`update orb_traces set started_at = now() - interval '40 days', ended_at = now() - interval '40 days' where id = 'TRACEfail00000000000001'`);
    await db.query(`update orb_traces set started_at = now() - interval '20 days', ended_at = null where id = 'TRACEstop00000000000001'`);
    await db.query(`update orb_trace_blobs set used_at = now() - interval '40 days' where media_type = 'image/webp'`);
    assert.equal(await traces.pruneTraces(db, 30), 1);
    assert.equal(await traces.getTrace(db, 'TRACEfail00000000000001'), null);
    assert.equal((await traces.traceEvents(db, 'TRACEfail00000000000001')).length, 0);
    assert.ok(await traces.getTrace(db, 'TRACEstop00000000000001'), 'a trace that may still be running is kept');
    assert.equal(await traces.traceBlob(db, sha(WEBP)), null, 'blobs nobody used lately go too');
  });
});
