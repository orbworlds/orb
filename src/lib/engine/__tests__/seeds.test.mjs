// The curated Explore catalog (src/server/seed.ts): worlds dropped from src/data/seeds.json leave
// Explore, whether embedded or hosted on Orb, but worlds people own and Orb's Originals stay.
import { register } from 'node:module';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DDL } from '../../../server/ddl.mjs';

register('./resolve-hooks.mjs', import.meta.url);

const { applySeeds, SEEDS } = await import('../../../server/seed.ts');

const pg = new PGlite();
await pg.exec(DDL);
const db = { query: async (sql, params = []) => (await pg.query(sql, params)).rows };
after(() => pg.close());

test('dropped curated worlds leave; owned worlds and Originals stay', async () => {
  await db.query(`insert into orb_worlds (id, name, kind, external_url) values ('ext-gone', 'Gone', 'external', 'https://gone.example')`);
  await db.query(`insert into orb_worlds (id, name, kind, source_url, tree) values ('aw-gone-hosted', 'Hosted, gone', 'native', 'https://github.com/a/b', 'abc')`);
  await db.query(`insert into orb_worlds (id, name, kind, source_url, owner_device) values ('aw-handed', 'Handed to someone', 'native', 'https://github.com/a/c', 'dev1')`);
  await db.query(`insert into orb_worlds (id, name, kind, source_url) values ('orb-island', 'Seashell Island', 'native', 'https://github.com/orb/island')`);
  await db.query(`insert into orb_worlds (id, name, kind, owner_device) values ('Zx81abcdEf', 'Someone''s world', 'native', 'dev2')`);
  await applySeeds(db);
  const ids = (await db.query(`select id from orb_worlds`)).map((r) => r.id);
  assert.ok(!ids.includes('ext-gone'), 'a dropped embed leaves');
  assert.ok(!ids.includes('aw-gone-hosted'), 'a dropped hosted seed leaves');
  for (const id of ['aw-handed', 'orb-island', 'Zx81abcdEf']) assert.ok(ids.includes(id), `${id} stays`);
  for (const s of SEEDS) assert.ok(ids.includes(s.id), `seed ${s.id} is there`);
});

test('hidden seeds are kept, marked hidden; the others are not', async () => {
  const rows = await db.query(`select id, hidden from orb_worlds where id = any($1::text[])`, [SEEDS.map((s) => s.id)]);
  const hidden = new Map(rows.map((r) => [r.id, r.hidden]));
  assert.ok(SEEDS.some((s) => s.hidden) && SEEDS.some((s) => !s.hidden));
  for (const s of SEEDS) assert.equal(hidden.get(s.id), !!s.hidden, s.id);
});

test('every curated world and Original is in exactly one of Explore’s categories', async () => {
  const CATEGORY_TAGS = ['game', 'world', 'art', 'toy']; // src/server/worlds.ts
  const originals = (await import('../../../data/originals.json', { with: { type: 'json' } })).default.worlds;
  for (const w of [...SEEDS, ...originals]) {
    const named = new Set(w.tags.filter((t) => CATEGORY_TAGS.includes(t)).map((t) => (t === 'toy' ? 'art' : t)));
    assert.equal(named.size, 1, `${w.id}: ${JSON.stringify(w.tags)} should name one of game, world, art/toy`);
  }
});
