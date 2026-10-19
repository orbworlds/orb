// Problems worth a look (src/server/errors.ts): repeats count up in one row, each problem alerts at
// most once an hour, alerts speak Slack's or Discord's webhook format, and what browsers report can
// neither inject markup into the chat nor use up the alerts the server's own problems need.
import { register } from 'node:module';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DDL } from '../../../server/ddl.mjs';

register('./resolve-hooks.mjs', import.meta.url);

const { recordError } = await import('../../../server/errors.ts');

const pg = new PGlite();
await pg.exec(DDL);
const db = { query: async (sql, params = []) => (await pg.query(sql, params)).rows };

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response(null, { status: 204 });
};
after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.ORB_ALERT_WEBHOOK;
  await pg.close();
});

test('repeats of a problem count up in one row, across deploys', async () => {
  delete process.env.ORB_ALERT_WEBHOOK;
  const message = 'TypeError: Cannot read properties of undefined (reading 0)';
  await recordError(db, { kind: 'page', message, stack: `${message}\n    at a (/_next/static/chunks/12ab.js:1:200)`, path: '/explore' });
  await recordError(db, { kind: 'page', message: message.replace('0', '3'), stack: `${message}\n    at b (/_next/static/chunks/99ff.js:1:342)`, path: '/' });
  const rows = await db.query(`select count, path, detail from orb_errors where kind = 'page'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].path, '/');
  assert.match(rows[0].detail, /99ff\.js/);
  assert.equal(sent.length, 0, 'no webhook, no alert');
});

test('each problem alerts at most once an hour, in Slack’s format', async () => {
  process.env.ORB_ALERT_WEBHOOK = 'https://hooks.slack.com/services/T0/B0/x';
  sent.length = 0;
  const boom = { kind: 'server', message: 'Error: boom', path: '/api/worlds' };
  await recordError(db, boom);
  await recordError(db, boom);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, process.env.ORB_ALERT_WEBHOOK);
  assert.match(sent[0].body.text, /^Orb: server error in `\/api\/worlds` — `Error: boom`\n.+\/lab\/.+\/pulse$/);
  await db.query(`update orb_errors set alerted_at = now() - interval '2 hours' where message = 'Error: boom'`);
  await recordError(db, boom);
  assert.equal(sent.length, 2, 'an hour later it alerts again');
  assert.match(sent[1].body.text, /\(3 times so far\)/);
});

test('reported text cannot ping or link anyone', async () => {
  process.env.ORB_ALERT_WEBHOOK = 'https://hooks.slack.com/services/T0/B0/x';
  sent.length = 0;
  await recordError(db, { kind: 'page', message: 'x <!channel> <https://evil.example|Fix it here>\nOrb: the free builder is down `now`', path: '/' });
  assert.equal(sent.length, 1);
  const text = sent[0].body.text;
  assert.ok(!text.includes('<!channel>') && !text.includes('<https://evil'), text);
  assert.equal(text.split('\n').length, 2, 'one line for the problem, one for the link');
  process.env.ORB_ALERT_WEBHOOK = 'https://discord.com/api/webhooks/1/abc';
  sent.length = 0;
  await recordError(db, { kind: 'page', message: '@everyone look', path: '/' });
  assert.deepEqual(sent[0].body.allowed_mentions, { parse: [] });
});

test('page reports have their own alert budget', async () => {
  process.env.ORB_ALERT_WEBHOOK = 'https://hooks.slack.com/services/T0/B0/x';
  sent.length = 0;
  for (let i = 0; i < 12; i++) await recordError(db, { kind: 'page', message: `junk ${'abcdefghijkl'[i]}`, path: '/' });
  assert.equal(sent.length, 3, 'five page alerts an hour (two were sent above)');
  const unsent = await db.query(`select count(*)::int as n from orb_errors where message like 'junk %' and alerted_at is null`);
  assert.equal(unsent[0].n, 9, 'what was not sent can alert later');
  await recordError(db, { kind: 'builder', message: 'Out of budget (anthropic): credit balance is too low' });
  assert.equal(sent.length, 4, 'the builder going down still alerts');
});

test('Discord webhooks get `content`; the builder going down says so', async () => {
  process.env.ORB_ALERT_WEBHOOK = 'https://discord.com/api/webhooks/1/abc';
  sent.length = 0;
  await recordError(db, { kind: 'builder', message: 'Not set up (gateway): customer_verification_required' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.text, undefined);
  assert.match(sent[0].body.content, /^Orb: the free builder is down — `Not set up/);
});
