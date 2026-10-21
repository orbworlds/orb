// Free builder cost guards (src/server/freetier.ts), the addresses they count (src/server/http.ts)
// and the Postgres rate limiter they run on (src/server/ratelimit.ts, against an in-memory PGlite
// with the app's own schema).
import { register } from 'node:module';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DDL } from '../../../server/ddl.mjs';

register('./resolve-hooks.mjs', import.meta.url);

const { FREE_TIER_DEFAULTS, CURSOR_FREE_TIER_DEFAULTS, freeTierConfig, freeTierChecks, longBuildChecks, secondsUntilUtcMidnight } = await import('../../../server/freetier.ts');
const { rateLimit, refundRate, underLimit } = await import('../../../server/ratelimit.ts');
const { clientIp, ipBlock } = await import('../../../server/http.ts');

describe('freeTierConfig', () => {
  test('defaults bound a day of free building', () => {
    assert.deepEqual(freeTierConfig({}), FREE_TIER_DEFAULTS);
    assert.deepEqual(FREE_TIER_DEFAULTS, { perDeviceDay: 12, perIpDay: 40, perAccountDay: 30, maxOutputTokens: 12_000 });
  });

  test('environment overrides, ignoring nonsense', () => {
    const cfg = freeTierConfig({ ORB_FREE_DAILY_PER_DEVICE: ' 5 ', ORB_FREE_DAILY_PER_IP: '20.7', ORB_FREE_DAILY_PER_ACCOUNT: '9', ORB_FREE_MAX_OUTPUT_TOKENS: '8000' });
    assert.deepEqual(cfg, { perDeviceDay: 5, perIpDay: 20, perAccountDay: 9, maxOutputTokens: 8000 });
    for (const bad of ['', 'abc', '0', '-5', 'Infinity']) {
      assert.equal(freeTierConfig({ ORB_FREE_DAILY_PER_DEVICE: bad }).perDeviceDay, FREE_TIER_DEFAULTS.perDeviceDay, `ORB_FREE_DAILY_PER_DEVICE=${bad}`);
    }
  });

  test('the output cap stays within sane bounds', () => {
    assert.equal(freeTierConfig({ ORB_FREE_MAX_OUTPUT_TOKENS: '100' }).maxOutputTokens, 2_000);
    assert.equal(freeTierConfig({ ORB_FREE_MAX_OUTPUT_TOKENS: '999999' }).maxOutputTokens, 32_000);
  });

  test('the mock AI has no daily caps unless they are set', () => {
    const mock = freeTierConfig({}, true);
    assert.ok(mock.perDeviceDay >= 1_000_000 && mock.perIpDay >= 1_000_000 && mock.perAccountDay >= 1_000_000);
    assert.equal(mock.maxOutputTokens, FREE_TIER_DEFAULTS.maxOutputTokens);
    assert.equal(freeTierConfig({ ORB_FREE_DAILY_PER_DEVICE: '3' }, true).perDeviceDay, 3);
  });

  test('builds on Orb’s own Cursor key get fewer a day, set by the same variables', () => {
    assert.deepEqual(freeTierConfig({}, false, true), CURSOR_FREE_TIER_DEFAULTS);
    assert.deepEqual(CURSOR_FREE_TIER_DEFAULTS, { perDeviceDay: 10, perIpDay: 25, perAccountDay: 25, maxOutputTokens: 12_000 });
    assert.deepEqual(freeTierConfig({ ORB_FREE_DAILY_PER_IP: '15', ORB_FREE_DAILY_PER_DEVICE: '3' }, false, true), { ...CURSOR_FREE_TIER_DEFAULTS, perIpDay: 15, perDeviceDay: 3 });
  });
});

describe('freeTierChecks', () => {
  const cfg = { perDeviceDay: 12, perIpDay: 40, perAccountDay: 30, maxOutputTokens: 12_000 };
  const now = new Date('2026-10-07T21:30:00Z');

  test('without an account: per device and per IP', () => {
    const checks = freeTierChecks({ deviceHash: 'abc', ip: '1.2.3.4' }, 2, cfg, now);
    assert.deepEqual(
      checks.map((c) => c.key),
      ['build:burst:abc', 'build:devday:abc:2026-10-07', 'build:ipday:1.2.3.4:2026-10-07', 'build:ip:1.2.3.4', 'build:dev:abc'],
    );
    assert.deepEqual(
      checks.map((c) => c.limit),
      [4, 12, 40, 40, 40],
    );
    assert.equal(checks[0].cost, undefined, 'the burst limit counts requests, not units');
    assert.ok(checks.slice(1).every((c) => c.cost === 2));
    assert.deepEqual(
      checks.filter((c) => c.daily).map((c) => c.key.split(':')[1]),
      ['devday', 'ipday'],
    );
    for (const c of checks) assert.ok(c.message.length > 10);
    assert.match(checks[1].message, /sign in/, 'the day without an account ends with a way to go on');
  });

  test('without a device key, the IP stands in', () => {
    const keys = freeTierChecks({ deviceHash: null, ip: '1.2.3.4' }, 1, cfg, now).map((c) => c.key);
    assert.deepEqual(keys, ['build:burst:ip:1.2.3.4', 'build:ipday:1.2.3.4:2026-10-07', 'build:ip:1.2.3.4']);
  });

  test('signed in: quotas of the account’s own and a larger share of the IP', () => {
    const checks = freeTierChecks({ deviceHash: 'abc', ip: '1.2.3.4', userId: 'u_1' }, 3, cfg, now);
    assert.deepEqual(
      checks.map((c) => c.key),
      ['build:burst:u:u_1', 'build:userday:u_1:2026-10-07', 'build:ipday:1.2.3.4:2026-10-07', 'build:ip:1.2.3.4', 'build:user:u_1'],
    );
    assert.deepEqual(
      checks.map((c) => c.limit),
      [4, 30, 120, 40, 40],
    );
    assert.ok(checks.slice(1).every((c) => c.cost === 3));
    assert.ok(!checks.some((c) => /devday|build:dev:/.test(c.key)), 'not the device');
  });

  test('a long build counts against its maker, like a new build', () => {
    assert.deepEqual(
      longBuildChecks({ deviceHash: 'abc', userId: 'u_1' }, cfg, now).map((c) => [c.key, c.limit]),
      [['build:userday:u_1:2026-10-07', 30]],
    );
    assert.deepEqual(
      longBuildChecks({ deviceHash: 'abc', userId: null }, cfg, now).map((c) => [c.key, c.limit]),
      [['build:devday:abc:2026-10-07', 12]],
    );
    assert.deepEqual(longBuildChecks({ deviceHash: null, userId: null }, cfg, now), []);
    for (const c of longBuildChecks({ deviceHash: 'abc', userId: null }, cfg, now)) assert.ok(c.daily && c.cost === undefined);
  });

  test('daily keys roll over at UTC midnight', () => {
    const late = freeTierChecks({ deviceHash: 'abc', ip: 'x' }, 1, cfg, new Date('2026-10-07T23:59:59Z'));
    const early = freeTierChecks({ deviceHash: 'abc', ip: 'x' }, 1, cfg, new Date('2026-10-08T00:00:00Z'));
    assert.notEqual(late[1].key, early[1].key);
    assert.equal(secondsUntilUtcMidnight(new Date('2026-10-07T23:59:30Z')), 30);
    assert.equal(secondsUntilUtcMidnight(new Date('2026-10-08T00:00:00Z')), 86400);
  });
});

describe('rateLimit + refundRate (PGlite)', () => {
  let pg;
  let db;
  before(async () => {
    pg = new PGlite();
    await pg.waitReady;
    await pg.exec(DDL);
    db = { kind: 'pglite', query: async (text, params = []) => (await pg.query(text, params)).rows };
  });
  after(async () => {
    await pg?.close();
  });

  test('a fixed window allows exactly `limit` units', async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rateLimit(db, 'test:window', 3, 60));
    assert.deepEqual(
      results.map((r) => r.ok),
      [true, true, true, false],
    );
    assert.equal(results[2].remaining, 0);
    assert.ok(results[3].retryAfter > 0 && results[3].retryAfter <= 60);
  });

  test('a refund gives the units back', async () => {
    for (let i = 0; i < 3; i++) await rateLimit(db, 'test:refund', 3, 60);
    await refundRate(db, 'test:refund');
    assert.equal((await rateLimit(db, 'test:refund', 3, 60)).ok, true);
    assert.equal((await rateLimit(db, 'test:refund', 3, 60)).ok, false);
  });

  test('costs count as several units, and refunds never go below zero', async () => {
    const r = await rateLimit(db, 'test:cost', 10, 60, 4);
    assert.equal(r.remaining, 6);
    await refundRate(db, 'test:cost', 4);
    await refundRate(db, 'test:cost', 4);
    const [row] = await db.query(`select count from orb_rate where key = $1`, ['test:cost']);
    assert.equal(Number(row.count), 0);
    assert.equal((await rateLimit(db, 'test:cost', 10, 60, 10)).ok, true);
  });

  test('refunding a key that was never counted is harmless', async () => {
    await refundRate(db, 'test:never');
    assert.equal((await db.query(`select 1 from orb_rate where key = $1`, ['test:never'])).length, 0);
  });

  test('underLimit looks without counting, and forgets windows that ended', async () => {
    assert.equal(await underLimit(db, 'test:peek', 2, 60), true);
    await rateLimit(db, 'test:peek', 2, 60);
    assert.equal(await underLimit(db, 'test:peek', 2, 60), true);
    await rateLimit(db, 'test:peek', 2, 60);
    assert.equal(await underLimit(db, 'test:peek', 2, 60), false);
    assert.equal(await underLimit(db, 'test:peek', 3, 60), true);
    const [row] = await db.query(`select count from orb_rate where key = $1`, ['test:peek']);
    assert.equal(Number(row.count), 2);
    await db.query(`update orb_rate set window_start = now() - interval '2 minutes' where key = $1`, ['test:peek']);
    assert.equal(await underLimit(db, 'test:peek', 2, 60), true);
  });
});

describe('ipBlock', () => {
  test('IPv4 addresses stay as they are, IPv4-mapped ones too', () => {
    assert.equal(ipBlock('1.2.3.4'), '1.2.3.4');
    assert.equal(ipBlock('::ffff:1.2.3.4'), '1.2.3.4');
  });

  test('an IPv6 address counts as its /64 (one home or phone hops between all of them)', () => {
    assert.equal(ipBlock('2001:db8:a:b:1:2:3:4'), '2001:db8:a:b::/64');
    assert.equal(ipBlock('2001:0DB8:000a:000b:ffff:2:3:4'), '2001:db8:a:b::/64');
    assert.equal(ipBlock('2001:db8:a:b::'), '2001:db8:a:b::/64');
    assert.equal(ipBlock('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(ipBlock('::1'), '0:0:0:0::/64');
    assert.equal(ipBlock('2001:db8:a:b::1'), ipBlock('2001:db8:a:b:ffff:ffff:ffff:ffff'));
    assert.notEqual(ipBlock('2001:db8:a:b::1'), ipBlock('2001:db8:a:c::1'));
  });

  test('anything else stays as it is', () => {
    for (const odd of ['0.0.0.0', 'unknown', '1:2:3', '1::2::3', 'fe80::1%eth0', '2001:db8:a:b:1:2:3:4:5', '64:ff9b::1.2.3.4']) assert.equal(ipBlock(odd), odd);
  });

  test('clientIp reads the address Vercel saw', () => {
    const req = (headers) => new Request('http://orb.test/', { headers });
    assert.equal(clientIp(req({ 'x-real-ip': '2001:db8:a:b:1:2:3:4' })), '2001:db8:a:b::/64');
    assert.equal(clientIp(req({ 'x-forwarded-for': '5.6.7.8, 10.0.0.1' })), '5.6.7.8');
    assert.equal(clientIp(req({})), '0.0.0.0');
  });
});
