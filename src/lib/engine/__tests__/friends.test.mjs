// Friends are one orb_friends row per pair, the smaller id first as JavaScript compares strings
// (src/server/friends.ts pair()). The table's check must agree with that order whatever the
// database's collation: a byte order ("C"), where "B" sorts before "a".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DDL } from '../../../server/ddl.mjs';

const pg = new PGlite();
await pg.exec(DDL);
after(() => pg.close());

const ids = ['u_abc', 'u_ABC', 'u_Zed', 'u_zed', 'u_0x', 'u__x', 'u_-x', 'testuser1a2b'];
for (const id of ids) await pg.query(`insert into orb_users (id, name) values ($1, $1)`, [id]);

test('every pair in JavaScript order fits the table, and no pair the other way round', async () => {
  for (const x of ids) {
    for (const y of ids) {
      if (!(x < y)) continue;
      await pg.query(`insert into orb_friends (a, b, requested_by) values ($1, $2, $1)`, [x, y]);
      await assert.rejects(pg.query(`insert into orb_friends (a, b, requested_by) values ($1, $2, $1)`, [y, x]), /check/i, `${y} before ${x}`);
    }
  }
  const n = (await pg.query(`select count(*)::int as n from orb_friends`)).rows[0].n;
  assert.equal(n, (ids.length * (ids.length - 1)) / 2);
});

test('an account going away takes its friendships, presence and notifications with it', async () => {
  await pg.query(`insert into orb_presence (user_id, world_id) values ('u_abc', null)`);
  await pg.query(`insert into orb_notifications (user_id, kind, actor_id) values ('u_ABC', 'friend_request', 'u_abc')`);
  await pg.query(`delete from orb_users where id = 'u_abc'`);
  const left = async (sql) => (await pg.query(sql)).rows[0].n;
  assert.equal(await left(`select count(*)::int as n from orb_friends where a = 'u_abc' or b = 'u_abc'`), 0);
  assert.equal(await left(`select count(*)::int as n from orb_presence where user_id = 'u_abc'`), 0);
  assert.equal(await left(`select count(*)::int as n from orb_notifications where actor_id = 'u_abc'`), 0);
});
