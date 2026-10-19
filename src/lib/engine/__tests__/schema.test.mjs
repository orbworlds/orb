// Starting up (src/server/schema.ts ready()): a new database gets the schema and the curated
// catalog; a later start finds both recorded in orb_meta and leaves the tables alone (no DDL, whose
// table locks would make every query wait).
import { register } from 'node:module';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { SCHEMA_VERSION } from '../../../server/ddl.mjs';

register('./resolve-hooks.mjs', import.meta.url);

const pg = new PGlite();
after(() => pg.close());
const sent = [];
const db = {
  kind: 'pglite',
  async query(sql, params = []) {
    sent.push(sql);
    if (!params.length && sql.split(';').filter((s) => s.trim()).length > 1) return (await pg.exec(sql)).at(-1)?.rows ?? [];
    return (await pg.query(sql, params)).rows;
  },
};
globalThis.__orbDb = Promise.resolve(db);
const { ready } = await import('../../../server/schema.ts');

/** A start of a new server process. */
async function start() {
  globalThis.__orbReady = null;
  sent.length = 0;
  await ready();
  return sent.slice();
}

const writes = (queries) => queries.filter((q) => /\b(create|alter)\s+(table|index)\b|insert\s+into\s+orb_worlds/i.test(q));

test('the first start applies the schema and the catalog, and records both', async () => {
  assert.ok(writes(await start()).length > 0);
  const meta = new Map((await db.query(`select key, value from orb_meta`)).map((r) => [r.key, r.value]));
  assert.equal(meta.get('schema'), SCHEMA_VERSION);
  assert.match(meta.get('seeds') ?? '', /^[0-9a-f]{16}$/);
  assert.ok((await db.query(`select count(*)::int as n from orb_worlds`))[0].n > 0);
});

test('the tables are closed to Supabase’s data API: row-level security on, its roles granted nothing', async () => {
  const off = await db.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'orb\\_%' and not c.relrowsecurity`);
  assert.deepEqual(off, [], 'row-level security on every table');
  // On Supabase the API roles start out with every right on the public schema, now and for new tables.
  await db.query(`create role anon; create role authenticated; grant all on all tables in schema public to anon, authenticated; alter default privileges in schema public grant all on tables to anon, authenticated`);
  await db.query(`update orb_meta set value = 'old' where key = 'schema'`);
  await start();
  await db.query(`create table orb_later (id int)`);
  const granted = await db.query(`select table_name, grantee from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated')`);
  await db.query(`drop table orb_later`);
  assert.deepEqual(granted, [], 'no rights for them on the tables, nor on tables made later');
});

test('a later start changes no tables', async () => {
  assert.deepEqual(writes(await start()), []);
});

test('a missing curated world brings the catalog back', async () => {
  await db.query(`delete from orb_worlds where id = 'orb-hangout'`);
  assert.ok((await start()).some((q) => /insert into orb_worlds/.test(q)));
  assert.equal((await db.query(`select count(*)::int as n from orb_worlds where id = 'orb-hangout'`))[0].n, 1);
  assert.deepEqual(writes(await start()), []);
});

test('a changed schema or catalog is applied again', async () => {
  await db.query(`update orb_meta set value = 'old' where key = 'schema'`);
  assert.ok((await start()).some((q) => /create table if not exists orb_worlds/.test(q)));
  await db.query(`update orb_meta set value = 'old' where key = 'seeds'`);
  assert.ok((await start()).some((q) => /insert into orb_worlds/.test(q)));
  assert.deepEqual(writes(await start()), []);
});
