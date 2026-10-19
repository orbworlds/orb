// What POST /api/events keeps (src/server/events.ts) and what the analytics page reads from it
// (src/server/analytics.ts): malformed events are dropped one by one, paths lose their query, the
// server's clock dates events; per UTC day the page tells new from returning visitors, follows new
// people step by step, splits world opens by where they came from, names people after their
// account or device, and finds each person by their public id.
import { register } from 'node:module';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DDL } from '../../../server/ddl.mjs';

register('./resolve-hooks.mjs', import.meta.url);

const { isBot, isMobile, parseBatch, recordEvents } = await import('../../../server/events.ts');
const { analytics, person } = await import('../../../server/analytics.ts');

const pg = new PGlite();
await pg.exec(DDL);
const db = { kind: 'pglite', query: async (sql, params = []) => (await pg.query(sql, params)).rows };
after(() => pg.close());

const ev = (extra = {}) => ({ name: 'like', t: 1000, session: 'visit1', path: '/', ...extra });

test('a batch keeps its good events and drops the rest one by one', () => {
  const b = parseBatch({
    sent: 61_000,
    mobile: true,
    device: 'k'.repeat(20),
    events: [
      ev({ path: '/explore?q=a+secret#top', world: 'w_1', props: { liked: true, n: 2, note: null }, ref: 'https://www.example.com/post?id=7#c' }),
      ev({ t: 70_000 }),
      ev({ t: -5_000_000, world: 'not a world id!' }),
      ev({ name: 'Bad-Name' }),
      ev({ name: 'x' }),
      ev({ session: 'short' }),
      ev({ props: { nested: { a: 1 } } }),
      ev({ props: { long: 'x'.repeat(2100) } }),
      ev({ props: { 'Bad-Key': 1 } }),
      ev({ path: '/lab/key/analytics' }),
      ev({ path: 'https://elsewhere.example/' }),
      'nope',
    ],
  });
  assert.equal(b.device, 'k'.repeat(20));
  assert.equal(b.mobile, true);
  assert.equal(b.rejected, 9);
  assert.deepEqual(b.rows, [
    { name: 'like', ago: 60_000, session: 'visit1', path: '/explore', world_id: 'w_1', props: { liked: true, n: 2, note: null }, referrer: 'https://www.example.com/post' },
    { name: 'like', ago: 0, session: 'visit1', path: '/', world_id: null, props: null, referrer: null },
    { name: 'like', ago: 600_000, session: 'visit1', path: '/', world_id: null, props: null, referrer: null },
  ]);
  assert.equal(parseBatch({ events: Array.from({ length: 51 }, () => ev()) }), null, 'more than 50');
  assert.equal(parseBatch({ events: 'x' }), null);
  assert.equal(parseBatch(null), null);
});

test('bots and headless browsers are told apart; phones by their word, else their user agent', () => {
  assert.equal(isBot('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36'), true);
  assert.equal(isBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
  assert.equal(isBot('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), false);
  assert.equal(isMobile(null, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), true);
  assert.equal(isMobile(false, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), false);
  assert.equal(isMobile(null, null), null);
});

const A = 'a1b2c3d4e5f6'.padEnd(64, '0');
const B = 'ffeeddccbbaa'.padEnd(64, '9');
const C = '0123456789ab'.padEnd(64, 'c');

test('events are dated by the server, with who sent them', async () => {
  await db.query(`insert into orb_users (id, name) values ('u1', 'Ada')`);
  await db.query(`insert into orb_devices (hash, user_id, name) values ($1, 'u1', 'Ada’s laptop'), ($2, null, 'Bob')`, [A, B]);
  await db.query(`insert into orb_worlds (id, name, owner_device, author_name, handle, slug) values ('w1', 'Castle', $1, 'Ada', 'ada', 'castle'), ('w2', 'Maze', $2, 'Bob', null, null)`, [A, B]);
  const rows = parseBatch({
    sent: 10_000,
    events: [
      ev({ name: 'page_view', t: 0, props: { landing: true, utm_source: 'hn' } }),
      ev({ name: 'world_open', t: 1000, world: 'w1', path: '/ada/castle', props: { source: 'explore' } }),
      ev({ name: 'prompt_send', t: 2000, world: 'w1', props: { where: 'chat', text: 'add a moat' } }),
      ev({ name: 'build_done', t: 3000, world: 'w1', props: { status: 'done', seconds: 12, saved: true } }),
      ev({ name: 'world_leave', t: 4000, world: 'w1', props: { seconds: 75, why: 'left' } }),
      ev({ name: 'like', t: 5000, world: 'w2', props: { liked: true } }),
    ],
  }).rows;
  await recordEvents(db, { deviceHash: A, userId: 'u1', country: 'DE', mobile: false }, rows);
  const [first] = await db.query(`select extract(epoch from now() - at)::float8 as age, device, user_id, country, mobile, props from orb_events order by id limit 1`);
  assert.ok(first.age >= 9.9 && first.age < 60, `dated ${first.age} s ago`);
  assert.deepEqual({ ...first, age: undefined }, { age: undefined, device: A, user_id: 'u1', country: 'DE', mobile: false, props: { landing: true, utm_source: 'hn' } });
  await recordEvents(db, { deviceHash: B, userId: null, country: null, mobile: true }, [
    { name: 'page_view', ago: 0, session: 'visit2', path: '/w/w1', world_id: null, props: { landing: true }, referrer: 'https://www.google.com/' },
    { name: 'world_open', ago: 0, session: 'visit2', path: '/w/w1', world_id: 'w1', props: { source: 'link' }, referrer: null },
    { name: 'world_leave', ago: 0, session: 'visit2', path: '/w/w1', world_id: 'w1', props: { seconds: 'lots' }, referrer: null },
    { name: 'world_open', ago: 0, session: 'visit2', path: '/w/gone', world_id: 'gone', props: { source: 'explore' }, referrer: null },
    { name: 'explore_open', ago: 0, session: 'visit2', path: '/', world_id: null, props: null, referrer: null },
  ]);
  const [bare] = await db.query(`select props is null as sql_null from orb_events where device = $1 and name = 'explore_open'`, [B]);
  assert.equal(bare.sql_null, true, 'no props: SQL null, not JSON null');
});

test('the analytics page: new and returning visitors, new people step by step, worlds and people', async () => {
  // B first came 3 days ago (a returning visitor today); C came 40 days ago only (out of range).
  await db.query(`update orb_events set at = at - interval '3 days', session = 'visit0' where device = $1 and name = 'page_view'`, [B]);
  await recordEvents(db, { deviceHash: C, userId: null, country: 'FR', mobile: false }, [{ name: 'page_view', ago: 0, session: 'visit3', path: '/', world_id: null, props: null, referrer: null }]);
  await db.query(`update orb_events set at = at - interval '40 days' where device = $1`, [C]);

  const a = await analytics(db, 7);
  assert.equal(a.days.length, 7);
  const today = a.days[0];
  assert.equal(today.day, new Date().toISOString().slice(0, 10));
  assert.deepEqual(
    { visitors: today.visitors, newVisitors: today.newVisitors, opens: today.opens, prompts: today.prompts, builds: today.builds, playSeconds: today.playSeconds },
    { visitors: 2, newVisitors: 1, opens: 3, prompts: 1, builds: 1, playSeconds: 75 },
  );
  assert.equal(a.days[3].visitors, 1);
  assert.equal(a.days[3].newVisitors, 1);
  assert.deepEqual(
    { visitors: a.totals.visitors, newVisitors: a.totals.newVisitors, visits: a.totals.visits, pageViews: a.totals.pageViews },
    { visitors: 2, newVisitors: 2, visits: 3, pageViews: 2 },
  );
  assert.deepEqual(a.funnel, { came: 2, opened: 2, prompted: 1, built: 1, cameBack: 0 });
  assert.deepEqual(
    a.worlds.map((w) => [w.id, w.name, w.href, w.opens, w.people, w.playSeconds, w.likes, w.sources]),
    [
      ['w1', 'Castle', '/ada/castle', 2, 2, 75, 0, [['explore', 1], ['link', 1]]],
      ['gone', null, '/w/gone', 1, 1, 0, 0, [['explore', 1]]],
      ['w2', 'Maze', '/w/w2', 0, 1, 0, 1, []],
    ],
  );
  assert.deepEqual(a.sources, [
    { source: 'google.com', visits: 1, people: 1 },
    { source: 'hn', visits: 1, people: 1 },
  ]);
  assert.deepEqual(a.devices, { phone: 1, computer: 1, unknown: 0 });
  assert.deepEqual(
    a.people.map((p) => [p.id, p.name, p.signedIn, p.mobile, p.country, p.visits, p.prompts, p.builds, p.worlds]),
    [
      ['ffeeddccbbaa', 'Bob', false, true, null, 2, 0, 0, 1],
      ['a1b2c3d4e5f6', 'Ada', true, false, 'DE', 1, 1, 1, 1],
    ],
  );
  assert.equal((await analytics(db, 30)).totals.visitors, 2, 'C came 40 days ago');
});

test('a person page: found by public id, with their worlds and latest events', async () => {
  const p = await person(db, 'a1b2c3d4e5f6');
  assert.equal(p.name, 'Ada');
  assert.equal(p.signedIn, true);
  assert.equal(p.country, 'DE');
  assert.equal(p.events, 6);
  assert.deepEqual(
    p.worlds.map((w) => [w.id, w.href, w.remix]),
    [['w1', '/ada/castle', false]],
  );
  assert.deepEqual(
    p.timeline.map((e) => e.name),
    ['like', 'world_leave', 'build_done', 'prompt_send', 'world_open', 'page_view'],
  );
  assert.deepEqual(p.timeline[0].world, { id: 'w2', name: 'Maze', href: '/w/w2' });
  assert.equal((await person(db, 'ffeeddccbbaa')).name, 'Bob');
  assert.equal(await person(db, '000000000000'), null);
  assert.equal(await person(db, 'A1B2C3D4E5F6'), null);
  assert.equal(await person(db, "a1b2c3d4e5f6' or 1=1"), null);
});
