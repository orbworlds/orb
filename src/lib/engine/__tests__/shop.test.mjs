// Shops in worlds (src/server/shop.ts): what a page's orb-shop list sells, and buying with credits —
// against an in-memory PGlite with the app's own schema: the listed price, once per account, paid
// credits before free ones, makers paid their share of the paid part only, Orb's own worlds keeping
// their sales, the daily cap, two purchases at once, and earnings put into building.
import { register } from 'node:module';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DDL } from '../../../server/ddl.mjs';

register('./resolve-hooks.mjs', import.meta.url);

const S = await import('../../../server/shop.ts');
const C = await import('../../../server/credits.ts');

const page = (list) => `<!doctype html><html><head><script type="application/json" id="orb-shop">${JSON.stringify(list)}</script></head><body></body></html>`;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} ≈ ${b}`);

describe('the list in the page', () => {
  test('items that fit, as listed', () => {
    const items = S.parseShop(page({ items: [{ id: 'star-hat', name: '  Star   Hat ', price: 40, emoji: '⭐', description: 'Twinkles' }, { id: 'Boots', name: 'Boots', price: 12.4 }] }));
    assert.deepEqual(items, [
      { id: 'star-hat', name: 'Star Hat', price: 40, emoji: '⭐', description: 'Twinkles' },
      { id: 'boots', name: 'Boots', price: 12, emoji: null, description: null },
    ]);
  });
  test('a bare array works too, and the tag can be written any way', () => {
    assert.equal(S.parseShop(page([{ id: 'a', name: 'A', price: 1 }])).length, 1);
    assert.equal(S.parseShop(`<script id='orb-shop' type='application/json' data-x>{"items":[{"id":"a","name":"A","price":5}]}</script >`)[0].price, 5);
  });
  test('what doesn’t fit is left out: bad ids, prices outside 1–1000, no name, the same id twice', () => {
    const items = S.parseShop(page({ items: [
      { id: 'ok', name: 'Fine', price: 1000 },
      { id: 'has space', name: 'X', price: 5 }, { id: '-dash', name: 'X', price: 5 }, { id: 'x'.repeat(41), name: 'X', price: 5 },
      { id: 'zero', name: 'X', price: 0 }, { id: 'big', name: 'X', price: 1001 }, { id: 'nan', name: 'X', price: 'ten' },
      { id: 'noname', name: '  ', price: 5 }, { id: 'ok', name: 'Again', price: 2 }, null, 'nope',
    ] }));
    assert.deepEqual(items.map((i) => i.id), ['ok']);
  });
  test('long names, descriptions and emoji are cut short; at most 40 items', () => {
    const [it] = S.parseShop(page({ items: [{ id: 'long', name: 'N'.repeat(80), price: 3, emoji: '🌌🔥🪶🌙⭐', description: 'D'.repeat(300) }] }));
    assert.equal(it.name.length, 40);
    assert.equal(it.description.length, 140);
    assert.equal([...it.emoji].length, 4);
    const many = S.parseShop(page({ items: Array.from({ length: 60 }, (_, i) => ({ id: `i${i}`, name: `Item ${i}`, price: 5 })) }));
    assert.equal(many.length, 40);
  });
  test('no list, or one that isn’t JSON: nothing for sale', () => {
    assert.deepEqual(S.parseShop('<html><body>hi</body></html>'), []);
    assert.deepEqual(S.parseShop('<script type="application/json" id="orb-shop">{ items: nope }</script>'), []);
    assert.deepEqual(S.parseShop(null), []);
  });
});

describe('buying', () => {
  let pg;
  let db;
  const cfg = C.plansConfig({ ORB_FREE_CREDITS: '20', ORB_PRO_CREDITS: '60' });
  const env = { ORB_SHOP_SHARE: '0.7', ORB_SHOP_DAILY: '150' };
  const as = (userId) => ({ deviceHash: null, deviceId: null, userId });
  const fail = (fn, status, error) => assert.rejects(fn, (e) => e.status === status && e.code === error, `${status} ${error}`);
  const items = { items: [{ id: 'hat', name: 'Hat', price: 30 }, { id: 'boots', name: 'Boots', price: 10 }, { id: 'cape', name: 'Cape', price: 25 }, { id: 'crown', name: 'Crown', price: 100 }] };
  const wallet = (u) => C.ensureWallet(db, `u:${u}`, cfg);
  const buy = (u, world, item, price, e = env) => S.buyItem(db, as(u), world, item, price, cfg, e);

  before(async () => {
    pg = new PGlite();
    await pg.waitReady;
    await pg.exec(DDL);
    db = { kind: 'pglite', query: async (text, params = []) => (await pg.query(text, params)).rows };
    await db.query(`insert into orb_users (id, name) values ('maker', 'Maker'), ('fan', 'Fan'), ('kid', 'Kid'), ('mixed', 'Mixed'), ('pro', 'Pro'), ('twin', 'Twin'), ('rich', 'Rich'), ('broke', 'Broke')`);
    await db.query(`insert into orb_worlds (id, name, code, owner_user, visibility) values ('shopw', 'Hat Shop', $1, 'maker', 'public'), ('hidden', 'Hidden', $1, 'maker', 'private'), ('orbw', 'VampireZ', $1, null, 'public')`, [page(items)]);
    await db.query(`insert into orb_worlds (id, name, kind, external_url, visibility) values ('ext', 'Elsewhere', 'external', 'https://example.com', 'public')`);
  });
  after(async () => {
    await pg?.close();
  });

  test('the shop as the buyer sees it', async () => {
    const v = await S.shopView(db, as('fan'), 'shopw', cfg);
    assert.deepEqual(v.items.map((i) => i.id), ['hat', 'boots', 'cape', 'crown']);
    assert.deepEqual({ owned: v.owned, credits: v.credits, paid: v.paid, mine: v.mine, signedIn: v.signedIn }, { owned: [], credits: 20, paid: 0, mine: false, signedIn: true });
    const anon = await S.shopView(db, as(null), 'shopw', cfg);
    assert.deepEqual({ credits: anon.credits, paid: anon.paid, signedIn: anon.signedIn }, { credits: null, paid: null, signedIn: false });
    assert.equal((await S.shopView(db, as('maker'), 'shopw', cfg)).mine, true);
    await fail(() => S.shopView(db, as('fan'), 'hidden', cfg), 404, 'not_found');
    assert.deepEqual((await S.shopView(db, as('fan'), 'ext', cfg)).items, []);
  });

  test('free credits buy things too, but earn the maker nothing', async () => {
    const r = await buy('kid', 'shopw', 'boots', 10);
    assert.deepEqual({ charged: r.charged, owned: r.owned, already: r.already }, { charged: 10, owned: ['boots'], already: false });
    close(r.credits, 10);
    close((await wallet('maker')).earned, 0);
  });

  test('bought credits go first in worlds, and the maker earns 70% of them', async () => {
    await C.grantTopup(db, 'u:fan', 100, 'cs_fan', cfg);
    const r = await buy('fan', 'shopw', 'hat', 30);
    close(r.credits, 90);
    const w = await wallet('fan');
    close(w.topup, 70, 'from the pack');
    close(w.usedMonthly, 0, 'the month’s free credits stay for building');
    const maker = await wallet('maker');
    close(maker.earned, 21);
    close(maker.earnedTotal, 21);
    const [p] = await db.query(`select paid_micros, earned_micros, seller_user, status from orb_purchases where buyer_user = 'fan' and item_id = 'hat'`);
    assert.deepEqual({ paid: Number(p.paid_micros), earned: Number(p.earned_micros), seller: p.seller_user, status: p.status }, { paid: 300_000, earned: 210_000, seller: 'maker', status: 'done' });
    const v = await S.shopView(db, as('fan'), 'shopw', cfg);
    assert.deepEqual({ credits: v.credits, paid: v.paid }, { credits: 90, paid: 70 });
  });

  test('a top-up smaller than the price: the rest from the month, which earns nothing', async () => {
    await C.grantTopup(db, 'u:mixed', 10, 'cs_mixed', cfg);
    const r = await buy('mixed', 'shopw', 'hat', 30);
    close(r.credits, 0);
    close((await wallet('mixed')).usedMonthly, 20);
    close((await wallet('maker')).earned, 28, '70% of the 10 bought ones');
  });

  test('Pro’s credits are all paid for', async () => {
    await C.setProPeriod(db, 'u:pro', { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 20 * 86_400_000), credits: 60, customer: 'cus_pro', subscription: 'sub_pro', status: 'active', cancelAt: null });
    assert.equal((await S.shopView(db, as('pro'), 'shopw', cfg)).paid, 60);
    await buy('pro', 'shopw', 'boots', 10);
    close((await wallet('pro')).usedMonthly, 10, 'the month’s first');
    close((await wallet('maker')).earned, 35);
  });

  test('once per account: again it charges nothing', async () => {
    const r = await buy('fan', 'shopw', 'hat', 30);
    assert.deepEqual({ charged: r.charged, already: r.already }, { charged: 0, already: true });
    close(r.credits, 90);
  });

  test('the price must be the listed one; the item must be on the list', async () => {
    await fail(() => buy('fan', 'shopw', 'cape', 20), 409, 'price_changed');
    await fail(() => buy('fan', 'shopw', 'unicorn', 5), 404, 'unknown_item');
    await fail(() => buy('fan', 'hidden', 'hat', 30), 404, 'not_found');
    await fail(() => buy(null, 'shopw', 'hat', 30), 401, 'account_required');
  });

  test('not enough credits → 402, and nothing is kept', async () => {
    await fail(() => buy('fan', 'shopw', 'crown', 100), 402, 'no_credits');
    assert.equal((await db.query(`select count(*)::int as n from orb_purchases where buyer_user = 'fan' and item_id = 'crown'`))[0].n, 0);
    close((await wallet('fan')).left, 90);
  });

  test('a wallet a build left below zero: the message says where the extra credits go', async () => {
    await C.chargeCredits(db, 'u:broke', C.toMicros(21.6), cfg);
    close((await wallet('broke')).left, -1.6);
    await assert.rejects(
      () => buy('broke', 'shopw', 'hat', 30),
      (e) => e.code === 'no_credits' && e.extra?.need === 32 && e.message === 'You need 32 more credits: your last build went 2 below zero.',
    );
  });

  test('the maker’s own: free, a test, no earnings', async () => {
    const before = await wallet('maker');
    const r = await buy('maker', 'shopw', 'crown', 100);
    assert.equal(r.charged, 0);
    assert.deepEqual(r.owned, ['crown']);
    const after = await wallet('maker');
    close(after.left, before.left);
    close(after.earned, before.earned);
  });

  test('Orb’s own worlds keep their sales', async () => {
    await C.grantTopup(db, 'u:rich', 1000, 'cs_rich', cfg);
    const before = await wallet('maker');
    const r = await buy('rich', 'orbw', 'cape', 25);
    assert.equal(r.charged, 25);
    close((await wallet('maker')).earned, before.earned);
    const [p] = await db.query(`select seller_user, earned_micros from orb_purchases where buyer_user = 'rich' and world_id = 'orbw'`);
    assert.deepEqual({ seller: p.seller_user, earned: Number(p.earned_micros) }, { seller: null, earned: 0 });
  });

  test('a day’s spending in worlds is capped', async () => {
    await buy('rich', 'orbw', 'crown', 100);
    await fail(() => buy('rich', 'orbw', 'hat', 30), 429, 'daily_limit');
    const r = await buy('rich', 'orbw', 'hat', 30, { ...env, ORB_SHOP_DAILY: '1000' });
    assert.equal(r.charged, 30);
  });

  test('purchases at once never spend the same credits twice, nor buy one thing twice', async () => {
    await C.grantTopup(db, 'u:twin', 30, 'cs_twin', cfg);
    const results = await Promise.allSettled([buy('twin', 'orbw', 'cape', 25), buy('twin', 'orbw', 'hat', 30), buy('twin', 'orbw', 'cape', 25)]);
    const ok = results.filter((x) => x.status === 'fulfilled' && x.value.charged > 0);
    const w = await wallet('twin');
    assert.equal(ok.length, 1, `50 credits buy the cape or the hat, once: ${JSON.stringify(results.map((x) => x.value?.charged ?? x.reason?.code))}`);
    close(50 - w.left, ok[0].value.charged, 'what was charged is what went');
    assert.ok(w.left >= 0, `never below zero: ${w.left}`);
    const rows = await db.query(`select item_id from orb_purchases where buyer_user = 'twin' and status = 'done'`);
    assert.deepEqual(rows.map((r) => r.item_id), [ok[0].value.item.id]);
  });

  test('a purchase cut off midway goes after a minute (nothing was taken)', async () => {
    await db.query(`insert into orb_purchases (world_id, item_id, item_name, buyer_user, seller_user, price_micros, created_at) values ('shopw', 'boots', 'Boots', 'fan', 'maker', 100000, now() - interval '5 minutes')`);
    const r = await buy('fan', 'shopw', 'boots', 10);
    assert.equal(r.charged, 10);
    await db.query(`insert into orb_purchases (world_id, item_id, item_name, buyer_user, seller_user, price_micros) values ('shopw', 'cape', 'Cape', 'fan', 'maker', 250000)`);
    await fail(() => buy('fan', 'shopw', 'cape', 25), 409, 'busy');
  });

  test('the maker hears: one note per world that adds up', async () => {
    const notes = await db.query(`select kind, world_id, actor_id, detail from orb_notifications where user_id = 'maker' and kind = 'sale'`);
    assert.equal(notes.length, 1);
    const d = typeof notes[0].detail === 'string' ? JSON.parse(notes[0].detail) : notes[0].detail;
    assert.equal(notes[0].actor_id, null);
    assert.equal(d.count, 5, 'the kid’s boots, two hats, the Pro boots and the fan’s boots (not the maker’s own crown)');
    close(Number(d.credits), 0 + 21 + 7 + 7 + 7);
    assert.equal(d.item, 'Boots');
  });

  test('earnings go into building, once, as bonus credits (not bought ones)', async () => {
    const before = await wallet('maker');
    const after = await S.buildWithEarnings(db, as('maker'), cfg);
    close(after.bonus, before.bonus + before.earned);
    close(after.topup, before.topup, 'bonus credits aren’t top-ups');
    close(after.left, before.left + before.earned);
    close(after.earned, 0);
    close(after.earnedTotal, before.earnedTotal);
    const again = await S.buildWithEarnings(db, as('maker'), cfg);
    close(again.bonus, after.bonus);
    const log = await db.query(`select micros from orb_credit_log where payer = 'u:maker' and kind = 'earnings'`);
    assert.deepEqual(log.map((l) => Number(l.micros)), [Math.round(before.earned * 10_000)]);
  });

  test('earnings passed on to another maker’s shop earn them nothing: only bought credits do', async () => {
    await db.query(`insert into orb_users (id, name) values ('other', 'Other')`);
    await db.query(`insert into orb_worlds (id, name, code, owner_user, visibility) values ('otherw', 'Other Shop', $1, 'other', 'public')`, [page(items)]);
    // Only bonus credits left: the month's are used up and there are no top-ups.
    await db.query(`update orb_wallets set topup_micros = 0, used_micros = allowance_micros where payer = 'u:maker'`);
    const m = await wallet('maker');
    assert.ok(m.bonus >= 10, `the maker has bonus credits to spend (${m.bonus})`);
    const r = await buy('maker', 'otherw', 'boots', 10);
    assert.equal(r.charged, 10);
    close((await wallet('maker')).bonus, m.bonus - 10);
    close((await wallet('other')).earned, 0, 'what bonus credits buy earns nobody anything');
    const v = await S.shopView(db, as('maker'), 'otherw', cfg);
    assert.equal(v.paid, 0, 'none of them count as paid for');
  });

  test('builds take plan credits, then bonus credits, then top-ups; a refund gives each back where it came from', async () => {
    await db.query(`insert into orb_users (id, name) values ('builder', 'Builder')`);
    await C.ensureWallet(db, 'u:builder', cfg);
    await db.query(`update orb_wallets set bonus_micros = $2, topup_micros = $3 where payer = $1`, ['u:builder', C.toMicros(15), C.toMicros(40)]);
    const w = await C.chargeCredits(db, 'u:builder', C.toMicros(45), cfg);
    close(w.usedMonthly, 20, 'the month’s 20');
    close(w.bonus, 0, 'the 15 bonus');
    close(w.topup, 30, '10 from the top-ups');
    close(C.toCredits(w.fromTopup), 10);
    const back = await C.refundCredits(db, 'u:builder', C.toMicros(45), 'job-builder', w.fromTopup);
    close(back.topup, 40);
    close(back.usedMonthly, 0);
    close(back.bonus, 15);
  });
});

describe('cash payouts: what is payable (src/server/payouts.ts)', async () => {
  const P = await import('../../../server/payouts.ts');
  const pay = (w) => P.payableMicros({ excluded: 0, paidOut: 0, ...w });
  test('only cleared sales, less what was built with, at most what is left', () => {
    assert.equal(pay({ earned: 100, earnedTotal: 100, cleared: 0 }), 0, 'nothing cleared yet');
    assert.equal(pay({ earned: 100, earnedTotal: 100, cleared: 60 }), 60, 'part cleared');
    assert.equal(pay({ earned: 40, earnedTotal: 100, cleared: 60 }), 0, 'the 60 that cleared were built with');
    assert.equal(pay({ earned: 40, earnedTotal: 100, cleared: 100 }), 40, 'all cleared: what is left');
    assert.equal(pay({ earned: 0, earnedTotal: 300, cleared: 300, paidOut: 300 }), 0, 'all paid out');
  });
  test('building comes out of what can’t be cashed first; payouts never add up to more than other players paid', () => {
    assert.equal(pay({ earned: 230, earnedTotal: 300, cleared: 140, excluded: 160 }), 140, 'built 70 out of the 160 from own accounts');
    assert.equal(pay({ earned: 90, earnedTotal: 330, cleared: 240, excluded: 160, paidOut: 240 }), 0, 'all that other players paid is paid out');
    // Whatever happens, payouts so far + payable ≤ cleared.
    for (const [earned, total, cleared, excluded, paidOut] of [[50, 500, 300, 400, 100], [10, 200, 200, 0, 150], [0, 1000, 1000, 1000, 0], [-40, 200, 40, 0, 240]]) {
      assert.ok(paidOut + pay({ earned, earnedTotal: total, cleared, excluded, paidOut }) <= Math.max(cleared, paidOut), `${earned},${total},${cleared},${excluded},${paidOut}`);
    }
  });
});
