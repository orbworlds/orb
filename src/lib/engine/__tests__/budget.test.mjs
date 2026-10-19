// The free builder's daily budget in US dollars (src/server/budget.ts): prices, what builds cost
// (exactly from the AI SDK's usage, estimated for Cursor agents), its settings, and charging it,
// against an in-memory PGlite with the app's own schema.
import { register } from 'node:module';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DDL } from '../../../server/ddl.mjs';

// Only the module resolution of ./setup.mjs: its browser globals would confuse PGlite.
register('./resolve-hooks.mjs', import.meta.url);

const B = await import('../../../server/budget.ts');
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} ≈ ${b}`);

describe('prices', () => {
  test('a model by any of its names', () => {
    const sonnet = { input: 2, write: 2.5, read: 0.1, output: 10 };
    for (const id of ['claude-sonnet-5-5', 'anthropic/claude-sonnet-5.5', 'claude-sonnet-5-5-20260928', ' Claude-Sonnet-5-5 ']) assert.deepEqual(B.priceOf(id), sonnet, id);
    assert.deepEqual(B.priceOf('claude-sonnet-5'), { input: 2, write: 2.5, read: 0.2, output: 10 }, 'Sonnet 5 is not Sonnet 5.5');
    assert.deepEqual(B.priceOf('claude-opus-5-5'), { input: 4, write: 5, read: 0.2, output: 20 });
  });

  test('the mock is free; any other model costs like the dearest Claude', () => {
    assert.deepEqual(B.priceOf('mock'), { input: 0, write: 0, read: 0, output: 0 });
    for (const id of ['gpt-5.6-sol', 'composer-2.5', '', null, undefined]) assert.deepEqual(B.priceOf(id), B.UNKNOWN_PRICE, String(id));
    assert.ok(B.UNKNOWN_PRICE.output >= B.priceOf('claude-opus-5-5').output);
  });
});

describe('usageUsd', () => {
  test('uncached input, cache writes and reads, and output, each at its price', () => {
    const usage = { inputTokens: 100_000, outputTokens: 4_000, inputTokenDetails: { cacheReadTokens: 80_000, cacheWriteTokens: 15_000 } };
    close(B.usageUsd('anthropic/claude-sonnet-5.5', usage), (5_000 * 2 + 15_000 * 2.5 + 80_000 * 0.1 + 4_000 * 10) / 1e6);
    close(B.usageUsd('claude-opus-5-5', usage), 2 * B.usageUsd('claude-sonnet-5-5', usage), 'Opus 5.5 is twice Sonnet 5.5 per token');
  });

  test('the uncached count when the SDK gives it', () => {
    close(B.usageUsd('claude-sonnet-5-5', { inputTokens: 1_000, inputTokenDetails: { noCacheTokens: 400, cacheReadTokens: 600 } }), (400 * 2 + 600 * 0.1) / 1e6);
  });

  test('nothing for no usage, and for the mock', () => {
    assert.equal(B.usageUsd('claude-sonnet-5-5', undefined), 0);
    assert.equal(B.usageUsd('mock', { inputTokens: 5_000, outputTokens: 5_000 }), 0);
  });
});

describe('a model call cut short', () => {
  test('a prompt in tokens: its text, and each picture whatever its size', () => {
    const shot = { type: 'file', mediaType: 'image/webp', data: 'A'.repeat(300_000) };
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(7_000) }, shot], providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'look', output: { type: 'content', value: [{ type: 'file', mediaType: 'image/webp', data: { type: 'data', data: 'orb-look:L1:0' } }] } }] },
      { role: 'user', content: [{ type: 'image', image: new Uint8Array(50_000) }] },
    ];
    const n = B.promptTokens('y'.repeat(3_500), messages);
    // 10,500 characters of text and the keys around them, plus three pictures at 1,600 each
    assert.ok(n > 3_000 + 3 * 1_600 && n < 3_100 + 3 * 1_600, String(n));
    assert.equal(B.promptTokens('', []), 0);
  });

  test('what it read (the cached part at the cache price) and what it wrote so far', () => {
    close(B.cutCallUsd('claude-opus-5-5', { input: 50_000, cached: 40_000, written: 3_500 }), (10_000 * 5 + 40_000 * 0.2 + 1_000 * 20) / 1e6);
    close(B.cutCallUsd('claude-opus-5-5', { input: 1_000, cached: 9_000, written: 0 }), (1_000 * 0.2) / 1e6, 'never more cached than read');
    assert.equal(B.cutCallUsd('mock', { input: 50_000, cached: 0, written: 9_000 }), 0);
  });
});

describe('Cursor estimates', () => {
  test('each model call reads what is cached and caches the rest; what the model writes is read later', () => {
    const t = B.cursorTokens(7_000);
    assert.equal(t.context, B.CURSOR_HARNESS_TOKENS + 2_000);
    close(B.cursorUsd('claude-sonnet-5-5', t), (22_000 * 2.5) / 1e6, 'before any call: the call that reads the prompt');
    B.cursorCall(t);
    B.cursorOutput(t, 1_000);
    B.cursorInput(t, 3_500); // a tool's result: 1,000 tokens
    B.cursorCall(t);
    B.cursorOutput(t, 500);
    assert.deepEqual(t, { context: 24_500, cached: 24_000, read: 22_000, written: 24_000, output: 1_500 });
    close(B.cursorUsd('claude-sonnet-5-5', t), (22_000 * 0.1 + 24_000 * 2.5 + 1_500 * 10) / 1e6);
    close(B.cursorUsd('claude-opus-5-5', t), 2 * B.cursorUsd('claude-sonnet-5-5', t));
  });

  test('a build like the free builder’s comes out at cents, not dollars', () => {
    // Tonight's Sonnet builds: 4–13 model calls, 3k–9k tokens written.
    const t = B.cursorTokens(13_000);
    for (let i = 0; i < 6; i++) {
      B.cursorCall(t);
      B.cursorOutput(t, 1_300);
      B.cursorInput(t, 2_000);
    }
    const usd = B.cursorUsd('claude-sonnet-5-5', t);
    assert.ok(usd > 0.05 && usd < 0.3, `$${usd.toFixed(3)}`);
  });
});

describe('budgetConfig', () => {
  test('$20 a day, half of it for builds without an account', () => {
    assert.deepEqual(B.budgetConfig({}), { dailyUsd: 20, anonUsd: 10 });
    assert.deepEqual(B.budgetConfig({ ORB_FREE_DAILY_USD: '50' }), { dailyUsd: 50, anonUsd: 25 });
    assert.deepEqual(B.budgetConfig({ ORB_FREE_DAILY_USD: '50', ORB_FREE_DAILY_USD_ANON: '5.5' }), { dailyUsd: 50, anonUsd: 5.5 });
    assert.deepEqual(B.budgetConfig({ ORB_FREE_DAILY_USD: '50', ORB_FREE_DAILY_USD_ANON: '80' }), { dailyUsd: 50, anonUsd: 50 }, 'never more than the whole');
  });

  test('0 turns free building off; nonsense keeps the default', () => {
    assert.deepEqual(B.budgetConfig({ ORB_FREE_DAILY_USD: '0' }), { dailyUsd: 0, anonUsd: 0 });
    for (const bad of ['abc', '-1', 'Infinity', ' ']) assert.equal(B.budgetConfig({ ORB_FREE_DAILY_USD: bad }).dailyUsd, B.BUDGET_DEFAULT_USD, bad);
  });

  test('which part is spent', () => {
    const cfg = { dailyUsd: 20, anonUsd: 10 };
    assert.equal(B.overBudget({ all: 12, anon: 10 }, cfg, false), null, 'signed in: only the whole counts');
    assert.equal(B.overBudget({ all: 12, anon: 10 }, cfg, true), 'anon');
    assert.equal(B.overBudget({ all: 20, anon: 3 }, cfg, false), 'all');
    assert.equal(B.overBudget({ all: 20, anon: 3 }, cfg, true), 'all');
    assert.equal(B.overBudget({ all: 0, anon: 0 }, { dailyUsd: 0, anonUsd: 0 }, false), 'all', 'a $0 budget lets nothing through');
  });
});

describe('charging the day (PGlite)', () => {
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

  test('charges add up per UTC day, builds without an account in both totals', async () => {
    const day = new Date('2026-03-01T10:00:00Z');
    assert.deepEqual(await B.spentToday(db, day), { all: 0, anon: 0, paid: 0 });
    assert.deepEqual(await B.chargeFree(db, 1.25, true, day), { all: 1.25, anon: 1.25, paid: 0 });
    assert.deepEqual(await B.chargeFree(db, 2, false, day), { all: 3.25, anon: 1.25, paid: 0 });
    assert.deepEqual(await B.chargeFree(db, 0.0000004, true, day), { all: 3.25, anon: 1.25, paid: 0 }, 'less than a millionth of a dollar is nothing');
    assert.deepEqual(await B.chargeFree(db, 0.5, true, new Date('2026-03-01T23:59:59Z')), { all: 3.75, anon: 1.75, paid: 0 });
    assert.deepEqual(await B.spentToday(db, new Date('2026-03-02T00:00:00Z')), { all: 0, anon: 0, paid: 0 }, 'a new day starts at UTC midnight');
    await B.chargePaid(db, 4, day);
    assert.deepEqual(await B.spentToday(db, day), { all: 3.75, anon: 1.75, paid: 4 }, 'builds paid with bought credits are counted apart from the budget');
  });

  test('when builds without an account spend their part, they ask to sign in, and those signed in keep building to the whole budget', async () => {
    const day = new Date('2026-04-01T12:00:00Z');
    const cfg = { dailyUsd: 3, anonUsd: 1 };
    const build = async (usd, anonymous) => {
      if (B.overBudget(await B.spentToday(db, day), cfg, anonymous)) return 'turned away';
      const over = B.overBudget(await B.chargeFree(db, usd, anonymous, day), cfg, anonymous);
      return over ? `paused (${over})` : 'built';
    };
    assert.equal(await build(0.6, true), 'built');
    assert.equal(await build(0.6, true), 'paused (anon)', 'the build that spends it pauses');
    assert.equal(await build(0.6, true), 'turned away');
    assert.equal(await build(1, false), 'built');
    assert.equal(await build(1, false), 'paused (all)');
    assert.equal(await build(1, false), 'turned away');
    assert.equal(await build(0.1, true), 'turned away');
  });

  test('spend per day for the Pulse page', async () => {
    await B.chargeFree(db, 0.42, false);
    const days = await B.spendByDay(db, 7);
    const today = new Date().toISOString().slice(0, 10);
    close(days.get(today)?.all ?? 0, 0.42);
    assert.ok(![...days.keys()].includes('2026-03-01'), 'only the last 7 days');
  });
});
