// Deadlines on streams (src/server/signals.ts): a free build's Cursor stream must stop at its time
// limit even when the garbage collector runs meanwhile. (An AbortSignal.timeout() combined with
// AbortSignal.any() can be collected before it fires, and then the stream just runs on.)
import { register } from 'node:module';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import v8 from 'node:v8';
import vm from 'node:vm';

register('./resolve-hooks.mjs', import.meta.url);

const { withDeadline } = await import('../../../server/signals.ts');

v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc');

// One byte every 100 ms for 3 s.
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  let n = 0;
  const t = setInterval(() => {
    res.write('x');
    if (++n >= 30) {
      clearInterval(t);
      res.end();
    }
  }, 100);
  req.on('close', () => clearInterval(t));
});
await new Promise((r) => server.listen(0, r));
after(() => server.close());
const url = `http://localhost:${server.address().port}/`;

/** Read the stream with the collector running between chunks → [seconds, how it ended]. */
async function read(signal) {
  const started = Date.now();
  try {
    const reader = (await fetch(url, { signal })).body.getReader();
    for (let i = 0; ; i++) {
      if ((await reader.read()).done) return [(Date.now() - started) / 1000, 'done'];
      if (i % 2) gc();
    }
  } catch (e) {
    return [(Date.now() - started) / 1000, e.name];
  }
}

test('a stream stops at its deadline, collector or not', async () => {
  const [s, how] = await read(withDeadline(new AbortController().signal, 600));
  assert.equal(how, 'TimeoutError');
  assert.ok(s < 1.5, `stopped after ${s} s`);
});

test('…and still when the other signal fires first', async () => {
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 300);
  const [s, how] = await read(withDeadline(stop.signal, 10_000));
  assert.equal(how, 'AbortError');
  assert.ok(s < 1.2, `stopped after ${s} s`);
});
