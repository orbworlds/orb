// Looks for the blob (src/lib/looks.ts, src/server/looks.ts): what can be worn (one per slot), the
// colors, and buying and wearing Orb's things with credits — against an in-memory PGlite with the
// app's own schema: the listed price, once per account, Orb keeping the sale, only things the
// account has, and the daily cap shared with worlds' shops.
import { register } from 'node:module';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DDL } from '../../../server/ddl.mjs';

register('./resolve-hooks.mjs', import.meta.url);

const L = await import('../../looks.ts');
const S = await import('../../../server/looks.ts');
const C = await import('../../../server/credits.ts');

describe('what a blob can wear', () => {
  test('known things, one per slot (a later one wins), head first', () => {
    assert.deepEqual(L.cleanWear(['shades', 'crown']), ['crown', 'shades']);
    assert.deepEqual(L.cleanWear(['crown', 'halo', 'blush']), ['halo', 'blush']);
    assert.deepEqual(L.cleanWear(['cape', 42, null, 'sprout']), ['sprout']);
    assert.deepEqual(L.cleanWear('crown'), []);
  });
  test('colors are the palette’s; a stored look is cleaned', () => {
    assert.ok(L.isBlobColor('#5EC8FF'));
    assert.ok(!L.isBlobColor('#123456') && !L.isBlobColor('red') && !L.isBlobColor(null));
    assert.deepEqual(L.cleanLook({ color: '#5EC8FF', wear: ['shades', 'crown', 'nope'] }), { color: '#5ec8ff', wear: ['crown', 'shades'] });
    assert.deepEqual(L.cleanLook(null), { color: null, wear: [] });
    assert.deepEqual(L.cleanLook({ color: 'javascript:alert(1)', wear: 'crown' }), { color: null, wear: [] });
  });
  test('the catalog: ids fit what worlds receive, prices are whole credits', () => {
    for (const it of L.LOOK_ITEMS) {
      assert.match(it.id, /^[a-z0-9-]{1,24}$/);
      assert.ok(Number.isInteger(it.price) && it.price > 0, it.id);
      assert.ok(it.slot === 'head' || it.slot === 'face', it.id);
    }
    assert.equal(new Set(L.LOOK_ITEMS.map((i) => i.id)).size, L.LOOK_ITEMS.length);
  });
});

describe('buying and wearing', () => {
  let pg;
  let db;
  const cfg = C.plansConfig({ ORB_FREE_CREDITS: '1500', ORB_PRO_CREDITS: '3000' });
  const env = { ORB_SHOP_DAILY: '1000' };
  const as = (userId) => ({ deviceHash: null, deviceId: null, userId });
  const fail = (fn, status, error) => assert.rejects(fn, (e) => e.status === status && e.code === error, `${status} ${error}`);
  const item = (id) => L.lookItem(id);
  const buy = (u, id, price = item(id)?.price, e = env) => S.buyLook(db, as(u), id, price, cfg, e);

  before(async () => {
    pg = new PGlite();
    await pg.waitReady;
    await pg.exec(DDL);
    db = { kind: 'pglite', query: async (text, params = []) => (await pg.query(text, params)).rows };
    await db.query(`insert into orb_users (id, name) values ('ada', 'Ada'), ('bo', 'Bo'), ('cy', 'Cy')`);
  });
  after(async () => {
    await pg?.close();
  });

  test('signed out: the things and their prices, nothing owned, no credits', async () => {
    const v = await S.looksView(db, as(null), cfg);
    assert.equal(v.items.length, L.LOOK_ITEMS.length);
    assert.deepEqual({ owned: v.owned, look: v.look, credits: v.credits, signedIn: v.signedIn }, { owned: [], look: { color: null, wear: [] }, credits: null, signedIn: false });
    await fail(() => buy(null, 'crown'), 401, 'account_required');
    await fail(() => S.setLook(db, as(null), { color: '#5ec8ff' }, cfg), 401, 'account_required');
  });

  test('buying: the price leaves their credits, it’s theirs and on, and Orb keeps the sale', async () => {
    const left = cfg.free - item('crown').price;
    const v = await buy('ada', 'crown');
    assert.deepEqual({ owned: v.owned, wear: v.look.wear, credits: v.credits }, { owned: ['crown'], wear: ['crown'], credits: left });
    const [p] = await db.query(`select world_id, seller_user, earned_micros, status from orb_purchases where buyer_user = 'ada' and item_id = 'crown'`);
    assert.deepEqual({ shop: p.world_id, seller: p.seller_user, earned: Number(p.earned_micros), status: p.status }, { shop: S.LOOKS_SHOP, seller: null, earned: 0, status: 'done' });
    const again = await buy('ada', 'crown');
    assert.equal(again.credits, left, 'once: buying it again charges nothing');
  });

  test('another head thing takes the head; a face thing goes with it', async () => {
    let v = await buy('ada', 'sprout');
    assert.deepEqual(v.look.wear, ['sprout']);
    v = await buy('ada', 'blush');
    assert.deepEqual(v.look.wear, ['sprout', 'blush']);
    assert.deepEqual([...v.owned].sort(), ['blush', 'crown', 'sprout']);
  });

  test('wearing: only what they have; taking things off; one per slot', async () => {
    let v = await S.setLook(db, as('ada'), { wear: ['crown', 'blush'] }, cfg);
    assert.deepEqual(v.look.wear, ['crown', 'blush']);
    await fail(() => S.setLook(db, as('ada'), { wear: ['halo'] }, cfg), 403, 'not_owned');
    v = await S.setLook(db, as('ada'), { wear: ['crown', 'sprout'] }, cfg);
    assert.deepEqual(v.look.wear, ['sprout']);
    v = await S.setLook(db, as('ada'), { wear: [] }, cfg);
    assert.deepEqual(v.look.wear, []);
  });

  test('the color: one of the palette, kept with what they wear; null goes back to the device’s', async () => {
    await S.setLook(db, as('ada'), { wear: ['crown'] }, cfg);
    let v = await S.setLook(db, as('ada'), { color: '#FF6B81' }, cfg);
    assert.deepEqual(v.look, { color: '#ff6b81', wear: ['crown'] });
    await fail(() => S.setLook(db, as('ada'), { color: '#010203' }, cfg), 400, 'invalid_color');
    v = await S.setLook(db, as('ada'), { color: null }, cfg);
    assert.equal(v.look.color, null);
    const [row] = await db.query(`select look from orb_users where id = 'ada'`);
    assert.deepEqual(L.cleanLook(row.look), { color: null, wear: ['crown'] });
  });

  test('the price shown must still be the price; unknown things aren’t sold', async () => {
    await fail(() => buy('bo', 'halo', 5), 409, 'price_changed');
    await fail(() => buy('bo', 'cape', 5), 404, 'unknown_item');
    assert.deepEqual((await S.looksView(db, as('bo'), cfg)).owned, []);
  });

  test('not enough credits → 402; the day’s cap counts looks with worlds’ shops → 429', async () => {
    await C.ensureWallet(db, 'u:bo', cfg);
    await db.query(`update orb_wallets set used_micros = allowance_micros - 100000 where payer = 'u:bo'`);
    await fail(() => buy('bo', 'top-hat'), 402, 'no_credits');
    await buy('cy', 'crown');
    await fail(() => buy('cy', 'halo'), 429, 'daily_limit');
  });
});
