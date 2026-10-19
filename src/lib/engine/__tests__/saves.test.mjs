// Game progress that follows an account (src/server/saves.ts): what a save may hold, the newer copy
// winning, the account's limits and worlds that don't exist — against an in-memory PGlite with the
// app's own schema.
import { register } from 'node:module';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DDL } from '../../../server/ddl.mjs';

register('./resolve-hooks.mjs', import.meta.url);

const S = await import('../../../server/saves.ts');
/** A save with its data as a plain object (saves have no prototype, so "__proto__" is a plain key). */
const plain = (save) => save && { ...save, data: { ...save.data } };

describe('what a save may hold', () => {
  test('keys with string values, within the world storage cap', () => {
    assert.deepEqual({ ...S.cleanSave({ level: '3', 'oc:inv': '[1,2]' }) }, { level: '3', 'oc:inv': '[1,2]' });
    assert.deepEqual({ ...S.cleanSave({}) }, {}, 'a cleared storage is a save too');
    for (const bad of [null, 'x', [], { n: 3 }, { o: {} }]) assert.equal(S.cleanSave(bad), null, JSON.stringify(bad));
    assert.equal(S.cleanSave({ big: 'x'.repeat(3 * 1024 * 1024) }), null, 'more than a world may keep');
  });

  test('a key like __proto__ is a plain key', () => {
    const s = S.cleanSave(JSON.parse('{"__proto__":"x","a":"b"}'));
    assert.equal(s.__proto__, 'x');
    assert.equal(Object.getPrototypeOf(s), null);
  });
});

describe('saves (PGlite)', () => {
  let pg;
  let db;
  before(async () => {
    pg = new PGlite();
    await pg.waitReady;
    await pg.exec(DDL);
    db = { kind: 'pglite', query: async (text, params = []) => (await pg.query(text, params)).rows };
    await db.query(`insert into orb_users (id, name) values ('u1', 'One'), ('u2', 'Two')`);
    await db.query(`insert into orb_worlds (id, name) select 'w' || g, 'World ' || g from generate_series(1, 410) g`);
  });
  after(async () => {
    await pg?.close();
  });

  test('kept, read back, and listed newest first', async () => {
    assert.deepEqual(await S.putSave(db, 'u1', 'w1', { level: '2' }, 1000), { saved: true, at: 1000 });
    assert.deepEqual(await S.putSave(db, 'u1', 'w2', { coins: '5' }, 2000), { saved: true, at: 2000 });
    assert.deepEqual(plain(await S.getSave(db, 'u1', 'w1')), { data: { level: '2' }, at: 1000 });
    assert.equal(await S.getSave(db, 'u2', 'w1'), null, 'each account has its own');
    assert.deepEqual((await S.listSaves(db, 'u1')).map((s) => s.worldId), ['w2', 'w1']);
  });

  test('the newer copy wins: an older or same-time one changes nothing', async () => {
    assert.deepEqual(await S.putSave(db, 'u1', 'w1', { level: '1' }, 900), { saved: false, reason: 'older', at: 1000 });
    assert.deepEqual(await S.putSave(db, 'u1', 'w1', { level: '9' }, 1000), { saved: false, reason: 'older', at: 1000 });
    assert.deepEqual(await S.putSave(db, 'u1', 'w1', { level: '3' }, 1500), { saved: true, at: 1500 });
    assert.deepEqual(plain(await S.getSave(db, 'u1', 'w1')).data, { level: '3' });
  });

  test('a world that doesn’t exist has no saves', async () => {
    assert.deepEqual(await S.putSave(db, 'u1', 'nope', { a: 'b' }, 1), { saved: false, reason: 'no_world' });
  });

  test('an account keeps saves for so many worlds, and so much in all', async () => {
    for (let i = 2; i <= S.MAX_ACCOUNT_SAVES; i++) await db.query(`insert into orb_saves (user_id, world_id, data, size, at) values ('u2', $1, '{}', 2, 1)`, [`w${i}`]);
    assert.deepEqual(await S.putSave(db, 'u2', 'w1', { a: 'b' }, 5), { saved: true, at: 5 }, 'the last one fits');
    assert.deepEqual(await S.putSave(db, 'u2', 'w402', { a: 'b' }, 5), { saved: false, reason: 'full' }, 'one more world does not');
    assert.deepEqual(await S.putSave(db, 'u2', 'w1', { a: 'c' }, 6), { saved: true, at: 6 }, 'a world it has keeps saving');
    await db.query(`update orb_saves set size = $1 where user_id = 'u2' and world_id = 'w3'`, [S.MAX_ACCOUNT_CHARS - 100]);
    assert.deepEqual(await S.putSave(db, 'u2', 'w1', { a: 'x'.repeat(200) }, 7), { saved: false, reason: 'full' }, 'nor past what an account may keep in all');
  });
});
