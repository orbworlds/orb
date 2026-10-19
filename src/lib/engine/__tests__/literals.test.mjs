// Parameters written into the query text (src/server/literals.ts): every value comes back from
// Postgres unchanged, typed as the context says, and placeholders inside strings, identifiers,
// comments and dollar quotes are left alone. Values Postgres can't store (NUL characters, halves of
// surrogate pairs) are made storable instead of failing the query.
import { register } from 'node:module';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

register('./resolve-hooks.mjs', import.meta.url);

const { inlineParams, literal, storableParams } = await import('../../../server/literals.ts');

const pg = new PGlite();
after(() => pg.close());
const one = async (sql, params) => (await pg.query(inlineParams(sql, params))).rows[0];

const tricky = ["it's", 'back\\slash', '\\\'', "''", 'line\nbreak\ttab', 'emoji 🌍 ünïcödé', '$1 and $2', '-- not a comment', '/* nor this */', '$$dollar$$', 'E\'x\'', '{"a": [1, "b"]}', ''];

test('strings come back unchanged', async () => {
  for (const s of tricky) assert.equal((await one('select $1::text as v', [s])).v, s, JSON.stringify(s));
  assert.equal((await one('select $1 as v', ['untyped'])).v, 'untyped');
});

test('numbers, booleans and null take the type the context gives them', async () => {
  const r = await one('select $1::int as i, $2::float8 as f, $3 + 1 as sum, $4::bool as b, $5::text as n, $6::numeric as big', [-42, 0.1, 41, false, null, '12345678901234567890']);
  assert.deepEqual(r, { i: -42, f: 0.1, sum: 42, b: false, n: null, big: '12345678901234567890' });
  assert.equal((await one('select 5 - $1 as v', [-3])).v, 8);
  assert.equal((await one('select $1 as b', [true])).b, true);
  assert.equal((await one('select 1 as x limit $1', [1])).x, 1);
});

test('dates, bytes and JSON', async () => {
  const at = new Date('2026-10-09T12:34:56.789Z');
  assert.equal((await one('select $1 as d', [at])).d.toISOString(), at.toISOString());
  const bytes = Buffer.from([0, 1, 2, 250, 255, 39, 92]);
  assert.deepEqual(Buffer.from((await one('select $1 as b', [bytes])).b), bytes);
  assert.deepEqual((await one('select $1::jsonb as j', [{ a: "it's", b: ['\\', null] }])).j, { a: "it's", b: ['\\', null] });
  assert.deepEqual((await one('select $1::jsonb as j', ['[1,"two"]'])).j, [1, 'two']);
  assert.deepEqual((await one(`select x.a from jsonb_to_recordset($1::jsonb) as x(a text)`, [JSON.stringify([{ a: "o'k" }])])).a, "o'k");
});

test('arrays', async () => {
  const xs = ['a', 'b c', 'quote"d', 'back\\slash', "it's", '{brace}', 'comma,', 'NULL', ''];
  assert.deepEqual((await one('select $1::text[] as v', [xs])).v, xs);
  assert.deepEqual((await one('select $1::text[] as v', [['x', null]])).v, ['x', null]);
  assert.deepEqual((await one('select $1::text[] as v', [[]])).v, []);
  assert.deepEqual((await one('select $1::int[] as v', [[1, -2, 3]])).v, [1, -2, 3]);
  assert.equal((await one(`select 'b' = any($1::text[]) as v`, [['a', 'b']])).v, true);
  assert.deepEqual((await one('select $1::int[] as v', [[[1, 2], [3, 4]]])).v, [[1, 2], [3, 4]]);
});

test('placeholders only outside strings, identifiers, comments and dollar quotes', () => {
  const sql = `select '$1', "$1", $1, E'\\'$1', 'it''s $1' -- $1\n, /* $1 */ $$ $1 $$, $q$ $1 $q$, $2, a$1`;
  assert.equal(inlineParams(sql, ['x', 'y']), `select '$1', "$1", E'x', E'\\'$1', 'it''s $1' -- $1\n, /* $1 */ $$ $1 $$, $q$ $1 $q$, E'y', a$1`);
  assert.equal(inlineParams('select $10, $1', Array.from({ length: 10 }, (_, i) => i + 1)), `select E'10', E'1'`);
  assert.throws(() => inlineParams('select $2', [1]), /\$2/);
  assert.throws(() => literal(undefined), /Undefined/);
});

test('a value cannot end its literal early', async () => {
  for (const s of ["'); drop table x; --", "\\'); select 1; --", "E'\\'"]) {
    const sql = inlineParams('select $1::text as v', [s]);
    assert.equal((await pg.query(sql)).rows[0].v, s);
  }
});

test('a NUL or half an emoji no longer fails the query, as text or as jsonb', async () => {
  // WebGL shader logs end in a NUL; a world's errors carry it into an automatic fix's request.
  const shaderLog = "THREE.WebGLProgram: Shader Error 0 - ERROR: 0:4: 'glow' : undeclared identifier\n\u0000";
  const halfEmoji = 'Zombie pals 🧟'.slice(0, -1);
  const messages = JSON.stringify([{ role: 'user', content: [{ type: 'text', text: `<errors>\n1. ${shaderLog}\n</errors>` }] }]);
  const sql = 'select $1::jsonb as m, $2::text as t, $3::jsonb as e';
  const params = [messages, `log ${shaderLog}`, JSON.stringify({ label: halfEmoji })];
  await assert.rejects(pg.query(inlineParams(sql, params)));
  await assert.rejects(pg.query(sql, params));
  for (const run of [(p) => pg.query(inlineParams(sql, p)), (p) => pg.query(sql, p)]) {
    const r = (await run(storableParams(sql, params))).rows[0];
    assert.equal(r.m[0].content[0].text, `<errors>\n1. ${shaderLog.replace('\u0000', '')}\n</errors>`);
    assert.equal(r.t, `log ${shaderLog.replace('\u0000', '')}`);
    assert.equal(r.e.label, 'Zombie pals \ufffd');
  }
});

test('storable values stay as they were', async () => {
  // A backslash-u typed as text (world code) is not an escape, so it stays.
  const code = JSON.stringify({ code: 'const nul = "\\u0000"; const ok = "🌍";' });
  const params = [code, 'plain', 42, null, [1, 2]];
  assert.deepEqual(storableParams('select $1::jsonb, $2, $3, $4, $5::int[]', params), params);
  const back = (await pg.query(inlineParams('select $1::jsonb as v', storableParams('select $1::jsonb as v', [code])))).rows[0].v;
  assert.equal(back.code, 'const nul = "\\u0000"; const ok = "🌍";');
});
