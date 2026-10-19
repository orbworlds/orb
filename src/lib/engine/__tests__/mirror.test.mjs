// A Cursor agent's edits shown as they happen (src/server/agent/mirror.ts): unified diffs applied
// to Orb's copy of a file — in Cursor's own format and in GNU diff's — and the edits found in the
// agent's stream events.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { applyUnifiedDiff, streamedEdit } = await import('../../../server/agent/mirror.ts');

describe('applyUnifiedDiff', () => {
  test('Cursor rewriting a page that had no last newline (what real edits look like)', () => {
    const before = '<!doctype html><html><head><title>Untitled world</title></head><body></body></html>';
    const diff = `--- a//agent/index.html\n+++ b//agent/index.html\n@@ -1 +1,3 @@\n-${before}\n+<!doctype html>\n+<title>Campfire</title>\n+<body></body>`;
    assert.equal(applyUnifiedDiff(before, diff), '<!doctype html>\n<title>Campfire</title>\n<body></body>\n');
  });

  test('changes in the middle keep the rest, and the file’s own ending', () => {
    const before = 'a\nb\nc\nd\ne\nf\n';
    assert.equal(applyUnifiedDiff(before, '@@ -2,2 +2,3 @@\n b\n+x\n c'), 'a\nb\nx\nc\nd\ne\nf\n');
    assert.equal(applyUnifiedDiff(before, '@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -5,2 +5,1 @@\n e\n-f'), 'A\nb\nc\nd\ne\n');
    assert.equal(applyUnifiedDiff('', '@@ -0,0 +1,2 @@\n+one\n+two'), 'one\ntwo\n', 'a new file');
  });

  test('a diff that doesn’t fit Orb’s copy is left alone', () => {
    assert.equal(applyUnifiedDiff('a\nb\nc\n', '@@ -2,1 +2,1 @@\n-z\n+y'), null);
    assert.equal(applyUnifiedDiff('a\n', 'no hunks here'), null);
    assert.equal(applyUnifiedDiff('already here\n', '@@ -0,0 +1 @@\n+new file'), null, 'making a file that Orb already has');
  });

  test('GNU diff -u output, missing newlines included', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-diff-'));
    const cases = [
      ['line 1\nline 2\nline 3\n', 'line 1\nline two\nline 3\nline 4\n'],
      ['no newline at the end', 'no newline at the end\nnow there is one\n'],
      ['x\ny\n', 'x\ny\nz'],
      ['', 'brand new\n'],
    ];
    for (const [a, b] of cases) {
      fs.writeFileSync(path.join(dir, 'a'), a);
      fs.writeFileSync(path.join(dir, 'b'), b);
      const diff = spawnSync('diff', ['-u', 'a', 'b'], { cwd: dir, encoding: 'utf8' }).stdout;
      assert.equal(applyUnifiedDiff(a, diff), b, JSON.stringify({ a, b }));
    }
  });
});

describe('streamedEdit', () => {
  test('a finished edit with the file’s new contents, from the agent’s workspace', () => {
    const done = { callId: 'c1', name: 'edit_file', status: 'completed', args: { path: '/agent/src/main.js' }, result: { success: { path: '/agent/src/main.js', afterFullFileContent: 'go();\n', diffString: '…' } } };
    assert.deepEqual(streamedEdit('tool_call', done), { path: 'src/main.js', after: 'go();\n' });
    assert.deepEqual(streamedEdit('tool_call', { ...done, result: { success: { path: '/workspace/a.js', diffString: '@@ -0,0 +1 @@\n+a' } } }), { path: 'a.js', diff: '@@ -0,0 +1 @@\n+a' });
    assert.equal(streamedEdit('tool_call', { ...done, status: 'running' }), null, 'not finished yet');
    assert.equal(streamedEdit('tool_call', { ...done, name: 'read_file' }), null);
    assert.equal(streamedEdit('tool_call', { ...done, result: { success: { path: '/etc/hosts', afterFullFileContent: 'x' } } }), null, 'outside the workspace');
  });

  test('…or its diff, from the newer interaction events', () => {
    const ev = { type: 'tool-call-completed', callId: 'c2', toolCall: { type: 'edit', args: { path: '/agent/index.html' }, result: { status: 'success', value: { diffString: '@@ -1 +1 @@\n-a\n+b' } } } };
    assert.deepEqual(streamedEdit('interaction_update', ev), { path: 'index.html', diff: '@@ -1 +1 @@\n-a\n+b' });
    assert.equal(streamedEdit('interaction_update', { ...ev, toolCall: { ...ev.toolCall, type: 'shell' } }), null);
    assert.equal(streamedEdit('interaction_update', { ...ev, type: 'tool-call-started' }), null);
  });
});
