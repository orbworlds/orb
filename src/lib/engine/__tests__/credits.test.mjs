// Plans and credits (src/server/credits.ts, src/server/billing.ts) and Stripe's webhook signatures
// (src/server/stripe.ts): the plans' settings, wallets and their weeks, charging plan credits
// before top-ups, refunds and top-ups that count once, Pro periods from subscriptions, and what
// people are told — against an in-memory PGlite with the app's own schema.
import crypto from 'node:crypto';
import { register } from 'node:module';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DDL } from '../../../server/ddl.mjs';

register('./resolve-hooks.mjs', import.meta.url);

delete process.env.STRIPE_SECRET_KEY;
delete process.env.ORB_STRIPE_SECRET_KEY;
const C = await import('../../../server/credits.ts');
const S = await import('../../../server/stripe.ts');
const B = await import('../../../server/billing.ts');

const cfg = C.plansConfig({});
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} ≈ ${b}`);

describe('settings', () => {
  test('defaults: a week, guests 25, Free 70, Pro 460 for $20 a month, three packs', () => {
    assert.equal(cfg.guest, 25);
    assert.equal(cfg.free, 70);
    assert.deepEqual(cfg.pro, { credits: 460, usd: 20 });
    assert.deepEqual(cfg.topups.map((p) => [p.usd, p.credits]), [[10, 800], [25, 2100], [50, 4200]]);
  });

  test('a month of Pro (4.35 weeks) is about breakeven and the packs cover the card fee (2.9% + 30¢)', () => {
    assert.ok(Math.abs((cfg.pro.credits * 4.35) / 100 - cfg.pro.usd) < 0.5, 'a credit is a cent of AI');
    for (const p of cfg.topups) assert.ok(p.usd * 0.971 - 0.3 >= (p.credits / 100) * 0.99, `${p.usd}: ${p.credits}`);
  });

  test('from the environment, bad values ignored', () => {
    const c = C.plansConfig({ ORB_GUEST_CREDITS: '50', ORB_FREE_CREDITS: '500', ORB_PRO_CREDITS: '3000', ORB_PRO_USD: '25', ORB_TOPUPS: '5:450, 20:1900' });
    assert.deepEqual([c.guest, c.free, c.pro.credits, c.pro.usd], [50, 500, 3000, 25]);
    assert.deepEqual(c.topups, [{ id: 'usd5', usd: 5, credits: 450 }, { id: 'usd20', usd: 20, credits: 1900 }]);
    const bad = C.plansConfig({ ORB_FREE_CREDITS: 'lots', ORB_PRO_USD: '0', ORB_TOPUPS: '5=450' });
    assert.equal(bad.free, 70);
    assert.equal(bad.pro.usd, 1, 'Pro costs at least a dollar');
    assert.deepEqual(bad.topups, C.PLAN_DEFAULTS.topups);
  });

  test('who pays: the account, else the device', () => {
    assert.equal(C.payerOf({ userId: 'u1', deviceHash: 'abc' }), 'u:u1');
    assert.equal(C.payerOf({ deviceHash: 'abc' }), 'd:abc');
    assert.equal(C.payerOf({}), null);
    assert.equal(C.userOfPayer('u:u1'), 'u1');
    assert.equal(C.userOfPayer('d:abc'), null);
  });

  test('a week runs from Monday 00:00 UTC', () => {
    const w = C.weekOf(new Date('2026-03-10T12:00:00Z'));
    assert.equal(w.start.toISOString(), '2026-03-09T00:00:00.000Z');
    assert.equal(w.end.toISOString(), '2026-03-16T00:00:00.000Z');
    assert.equal(C.weekOf(new Date('2026-03-15T23:59:59Z')).start.toISOString(), '2026-03-09T00:00:00.000Z', 'Sunday night is still that week');
    assert.equal(C.weekOf(new Date('2026-03-16T00:00:00Z')).start.toISOString(), '2026-03-16T00:00:00.000Z', 'Monday starts the next');
  });
});

describe('wallets (PGlite)', () => {
  let pg;
  let db;
  before(async () => {
    pg = new PGlite();
    await pg.waitReady;
    await pg.exec(DDL);
    db = { kind: 'pglite', query: async (text, params = []) => (await pg.query(text, params)).rows };
    await db.query(`insert into orb_users (id, name) values ('u1', 'One'), ('u2', 'Two'), ('u3', 'Three')`);
  });
  after(async () => {
    await pg?.close();
  });

  const march = new Date('2026-03-10T12:00:00Z'); // a Tuesday: its week began on Monday the 9th
  const nextWeek = new Date('2026-03-17T08:00:00Z');

  test('a device gets the guest credits for the week, an account the Free plan’s', async () => {
    const g = await C.ensureWallet(db, 'd:dev1', cfg, march);
    assert.equal(g.plan, 'guest');
    assert.equal(g.left, 25);
    assert.equal(g.periodStart, '2026-03-09T00:00:00.000Z');
    assert.equal(g.periodEnd, '2026-03-16T00:00:00.000Z');
    assert.equal(g.refreshAt, '2026-03-16T00:00:00.000Z');
    const f = await C.ensureWallet(db, 'u:u1', cfg, march);
    assert.equal(f.plan, 'free');
    assert.equal(f.left, 70);
  });

  test('plan credits first, then top-ups, which may go below zero', async () => {
    await C.grantTopup(db, 'u:u1', 50, 'cs_test_1', cfg, march);
    let w = await C.chargeCredits(db, 'u:u1', C.toMicros(60), cfg, march);
    assert.equal(w.left, 60);
    assert.equal(w.used, 60);
    w = await C.chargeCredits(db, 'u:u1', C.toMicros(40), cfg, march);
    assert.equal(w.used, 70);
    assert.equal(w.topup, 20, 'the plan’s last 10, then 30 from the top-up');
    w = await C.chargeCredits(db, 'u:u1', C.toMicros(25), cfg, march);
    close(w.left, -5, 'a build’s last step may overdraw');
  });

  test('a new week refreshes the plan credits; top-ups (and what was overdrawn) carry over', async () => {
    const w = await C.ensureWallet(db, 'u:u1', cfg, nextWeek);
    assert.equal(w.periodEnd, '2026-03-23T00:00:00.000Z');
    assert.equal(w.used, 0);
    close(w.left, 65, '70 fresh, less the 5 overdrawn');
    const again = await C.ensureWallet(db, 'u:u1', cfg, nextWeek);
    close(again.left, 65, 'once per week');
  });

  test('a changed Free allowance applies at once', async () => {
    const more = { ...cfg, free: 500 };
    const w = await C.ensureWallet(db, 'u:u1', more, new Date('2026-03-18T00:00:00Z'));
    assert.equal(w.allowance, 500);
    close(w.left, 495);
  });

  test('refunds and top-ups count once', async () => {
    const before = (await C.ensureWallet(db, 'd:dev1', cfg, march)).left;
    await C.chargeCredits(db, 'd:dev1', C.toMicros(12.5), cfg, march);
    const refunded = await C.refundCredits(db, 'd:dev1', C.toMicros(12.5), 'job1');
    close(refunded.left, before);
    assert.equal(await C.refundCredits(db, 'd:dev1', C.toMicros(12.5), 'job1'), null, 'the same job again: nothing');
    assert.ok(await C.grantTopup(db, 'u:u2', 900, 'cs_pack', cfg, march));
    assert.equal(await C.grantTopup(db, 'u:u2', 900, 'cs_pack', cfg, march), null);
    assert.equal((await C.readWallet(db, 'u:u2')).topup, 900);
  });

  test('a refund gives credits back where they came from: free plan credits never become top-ups', async () => {
    await db.query(`insert into orb_users (id, name) values ('u9', 'Nine')`);
    await C.ensureWallet(db, 'u:u9', cfg, march);
    await C.grantTopup(db, 'u:u9', 100, 'cs_u9', cfg, march);
    // 60 of the plan's 70, then 30: 10 from the plan, 20 from the top-up.
    const a = await C.chargeCredits(db, 'u:u9', C.toMicros(60), cfg, march);
    const b = await C.chargeCredits(db, 'u:u9', C.toMicros(30), cfg, march);
    assert.equal(a.fromTopup, 0);
    close(C.toCredits(b.fromTopup), 20);
    let w = await C.refundCredits(db, 'u:u9', C.toMicros(30), 'job-b', b.fromTopup);
    close(w.topup, 100, 'the 20 back to the top-up');
    close(w.used, 60, 'the 10 back to the plan');
    // Charged one week from the plan, refunded the next: those free credits are gone, not top-ups.
    await C.ensureWallet(db, 'u:u9', cfg, nextWeek);
    w = await C.refundCredits(db, 'u:u9', C.toMicros(60), 'job-a', a.fromTopup);
    close(w.topup, 100, 'no free credits turned into top-ups');
    assert.equal(w.used, 0);
  });

  test('Pro: its credits for the week at once, fresh every week; Stripe repeating itself or renewing changes nothing', async () => {
    const period = { start: new Date('2026-03-05T10:00:00Z'), end: new Date('2026-04-05T10:00:00Z'), credits: 460, customer: 'cus_1', subscription: 'sub_1', status: 'active', cancelAt: null };
    let w = await C.setProPeriod(db, 'u:u3', period, march);
    assert.equal(w.plan, 'pro');
    assert.equal(w.left, 460);
    w = await C.chargeCredits(db, 'u:u3', C.toMicros(150), cfg, march);
    assert.equal(w.left, 310);
    w = await C.setProPeriod(db, 'u:u3', { ...period, cancelAt: period.end }, march);
    assert.equal(w.left, 310, 'Stripe telling us again (here: cancelling at the end) keeps what was used');
    assert.equal(w.cancelAt, '2026-04-05T10:00:00.000Z');
    w = await C.ensureWallet(db, 'u:u3', cfg, nextWeek);
    assert.equal(w.left, 460, 'a new week: Pro’s credits again');
    assert.equal(w.periodEnd, '2026-04-05T10:00:00.000Z', 'Pro’s paid month stays Stripe’s');
    w = await C.ensureWallet(db, 'u:u3', cfg, new Date('2026-04-06T00:00:00Z'));
    assert.equal(w.plan, 'pro', 'Pro periods end with Stripe, not by the calendar');
    w = await C.chargeCredits(db, 'u:u3', C.toMicros(100), cfg, new Date('2026-04-06T00:00:00Z'));
    w = await C.setProPeriod(db, 'u:u3', { ...period, start: period.end, end: new Date('2026-05-05T10:00:00Z'), cancelAt: null }, new Date('2026-04-06T00:00:00Z'));
    assert.equal(w.left, 360, 'renewed: the week’s credits go on as they were');
  });

  test('Pro ends: back on Free with the week’s Free credits, what was used this week staying used', async () => {
    let w = await C.endPro(db, 'u:u3', 'canceled', cfg, new Date('2026-04-08T00:00:00Z'));
    assert.equal(w.plan, 'free');
    assert.equal(w.allowance, 70);
    assert.equal(w.left, 0, '100 used this week, more than Free’s 70');
    assert.equal(w.periodEnd, '2026-04-13T00:00:00.000Z');
    assert.equal(w.stripeCustomer, 'cus_1', 'the customer stays, for the next checkout');
    assert.equal(await C.endPro(db, 'u:u3', 'canceled', cfg), null, 'only Pro can end');
    w = await C.ensureWallet(db, 'u:u3', cfg, new Date('2026-04-14T00:00:00Z'));
    assert.equal(w.left, 70, 'the next week: Free’s 70');
  });

  test('subscriptions from Stripe: active is Pro for its period (either API shape), anything else ends it', async () => {
    const sub = { id: 'sub_9', status: 'active', customer: 'cus_9', metadata: { orb_user: 'u2' }, items: { data: [{ current_period_start: 1772900000, current_period_end: 1775500000 }] } };
    let w = await B.applySubscription(db, sub, cfg);
    assert.equal(w.plan, 'pro');
    assert.equal(w.left, 1360, 'the week’s 460 and the pack bought before');
    assert.equal(w.periodEnd, new Date(1775500000 * 1000).toISOString());
    w = await B.applySubscription(db, { id: 'sub_9', status: 'active', customer: { id: 'cus_9' }, current_period_start: 1772900000, current_period_end: 1775500000, cancel_at_period_end: true }, cfg);
    assert.equal(w.plan, 'pro', 'found by its customer, period on the subscription itself');
    assert.equal(w.cancelAt, new Date(1775500000 * 1000).toISOString());
    w = await B.applySubscription(db, { id: 'sub_other', status: 'canceled', customer: 'cus_9', metadata: { orb_user: 'u2' } }, cfg);
    assert.equal(w.plan, 'pro', 'another subscription ending leaves this one alone');
    w = await B.applySubscription(db, { id: 'sub_9', status: 'canceled', customer: 'cus_9', metadata: { orb_user: 'u2' } }, cfg);
    assert.equal(w.plan, 'free');
    assert.equal(w.topup, 900, 'bought credits stay');
    assert.equal(await B.applySubscription(db, { id: 'sub_x', status: 'active', customer: 'cus_unknown' }, cfg), null, 'no account: nothing');
  });

  test('a paid credit pack from a checkout counts once; unpaid or foreign ones not at all', async () => {
    const session = { id: 'cs_pack2', mode: 'payment', payment_status: 'paid', client_reference_id: 'u1', customer: 'cus_u1', metadata: { kind: 'topup', credits: '900' } };
    const before = (await C.readWallet(db, 'u:u1')).topup;
    assert.deepEqual(await B.applyCheckoutSession(db, session, cfg), { kind: 'topup', done: true });
    await B.applyCheckoutSession(db, session, cfg);
    assert.equal((await C.readWallet(db, 'u:u1')).topup, before + 900);
    assert.deepEqual(await B.applyCheckoutSession(db, { ...session, id: 'cs_unpaid', payment_status: 'unpaid' }, cfg), { kind: 'topup', done: false });
    assert.deepEqual(await B.applyCheckoutSession(db, { ...session, id: 'cs_nobody', client_reference_id: 'u404' }, cfg), { kind: null, done: false });
    assert.equal((await C.readWallet(db, 'u:u1')).stripeCustomer, 'cus_u1');
  });

  test('a Pro period Stripe never renewed lapses after a few days of grace', async () => {
    const period = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z'), credits: 460, customer: 'cus_l', subscription: 'sub_l', status: 'active', cancelAt: null };
    await db.query(`insert into orb_users (id, name) values ('u4', 'Four')`);
    await C.setProPeriod(db, 'u:u4', period, new Date('2026-01-05T00:00:00Z'));
    assert.equal((await B.currentWallet(db, 'u:u4', cfg, new Date('2026-02-02T00:00:00Z'))).plan, 'pro', 'a late renewal is still possible');
    const w = await B.currentWallet(db, 'u:u4', cfg, new Date('2026-02-05T00:00:00Z'));
    assert.equal(w.plan, 'free');
    assert.equal(w.left, 70);
  });

  test('what the page is told', async () => {
    const info = B.billingInfo(await C.readWallet(db, 'u:u2'), cfg);
    assert.equal(info.plan, 'free');
    assert.equal(info.payments, false);
    assert.equal(info.manage, false, 'no portal without Stripe');
    assert.equal(info.plans.typicalBuild, C.TYPICAL_BUILD_CREDITS);
    const guest = B.billingInfo(null, cfg, march);
    assert.equal(guest.plan, 'guest');
    assert.equal(guest.credits.left, 25);
    assert.equal(guest.credits.allowance, 25);
    assert.equal(guest.credits.refreshAt, '2026-03-16T00:00:00.000Z');
  });
});

describe('out of credits', () => {
  const wallet = (plan, extra = {}) => ({ plan, left: 0, allowance: plan === 'pro' ? 460 : 70, used: 70, topup: 0, refreshAt: '2026-11-16T00:00:00.000Z', periodEnd: '2026-12-01T00:00:00.000Z', cancelAt: null, ...extra });

  test('guests are asked to make a free account, without a word of their own allowance', () => {
    const msg = C.outOfCredits(wallet('guest'), cfg, true);
    assert.match(msg, /create a free account \(You → Account\) to keep going — it comes with 70 credits every week/);
    assert.doesNotMatch(msg, /25|this week|Nov/);
    assert.match(C.outOfCredits(wallet('guest'), cfg, true, true), /^That's all the building without an account for now, so I'll pause here — what I made so far is saved\. Create a free account/);
  });

  test('Free: when they are back, Pro when payments are on, and the own-key way', () => {
    const msg = C.outOfCredits(wallet('free'), cfg, true);
    assert.match(msg, /this week's 70 free credits/);
    assert.match(msg, /back on Nov 16/);
    assert.match(msg, /go Pro for 460 a week/);
    assert.match(msg, /You → Model/);
    assert.doesNotMatch(C.outOfCredits(wallet('free'), cfg, false), /Pro/);
  });

  test('Pro: top up, or wait for the week’s credits', () => {
    assert.match(C.outOfCredits(wallet('pro'), cfg, true), /this week's credits\. Top up in You → Plan.*Nov 16/);
  });

  test('mid-build: it pauses and keeps what it made', () => {
    assert.match(C.outOfCredits(wallet('free'), cfg, true, true), /^You're out of credits, so I'll pause here — what I made so far is saved\. They're back on Nov 16/);
  });
});

describe('Stripe', () => {
  const secret = 'whsec_test';
  const payload = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });

  test('signatures: the right secret and time pass; anything else fails', () => {
    const now = Date.UTC(2026, 9, 12, 12);
    const at = Math.floor(now / 1000);
    const header = `t=${at},v1=${crypto.createHmac('sha256', secret).update(`${at}.${payload}`, 'utf8').digest('hex')}`;
    assert.ok(S.verifySignature(payload, header, secret, 300, now));
    assert.ok(S.verifySignature(payload, `${header},v1=${'0'.repeat(64)}`, secret, 300, now), 'any of several signatures');
    assert.ok(!S.verifySignature(payload, header, 'whsec_other', 300, now));
    assert.ok(!S.verifySignature(`${payload} `, header, secret, 300, now), 'another body');
    assert.ok(!S.verifySignature(payload, header, secret, 300, now + 301_000), 'too old (a replay)');
    for (const bad of [null, '', 't=abc,v1=00', `v1=${'a'.repeat(64)}`, `t=${at}`]) assert.ok(!S.verifySignature(payload, bad, secret, 300, now), String(bad));
  });

  test('form fields nest the way Stripe reads them', () => {
    const f = S.formEncode({ mode: 'payment', line_items: [{ price_data: { currency: 'usd', unit_amount: 1000 }, quantity: 1 }], metadata: { kind: 'topup' }, skip: undefined, flag: true });
    assert.equal(decodeURIComponent(f.toString()), 'mode=payment&line_items[0][price_data][currency]=usd&line_items[0][price_data][unit_amount]=1000&line_items[0][quantity]=1&metadata[kind]=topup&flag=true');
  });

  test('without a secret key there are no payments', () => {
    assert.equal(S.paymentsOn(), false);
  });

  test('a sandbox key on the live site takes only the test accounts (anyone else would pay with a test card)', () => {
    try {
      process.env.STRIPE_SECRET_KEY = 'sk_test_orb';
      assert.equal(S.stripeTestMode(), true);
      assert.equal(B.paymentsFor('anyone', { VERCEL_ENV: 'preview' }), true, 'previews and local runs: everyone');
      assert.equal(B.paymentsFor('anyone', {}), true);
      assert.equal(B.paymentsFor('anyone', { VERCEL_ENV: 'production' }), false);
      assert.equal(B.paymentsFor('QA-One', { VERCEL_ENV: 'production', ORB_STRIPE_TEST_ACCOUNTS: 'qa-one, qa-two' }), true);
      assert.equal(B.paymentsFor(null, { VERCEL_ENV: 'production', ORB_STRIPE_TEST_ACCOUNTS: 'qa-one' }), false, 'no account: no');
      process.env.STRIPE_SECRET_KEY = 'sk_live_orb';
      assert.equal(B.paymentsFor('anyone', { VERCEL_ENV: 'production' }), true, 'a live key: everyone');
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
    }
    assert.equal(B.paymentsFor('anyone', { VERCEL_ENV: 'production' }), false, 'no key: no one');
  });

  test('Orb’s own key wins over the one the Vercel integration manages', () => {
    try {
      process.env.STRIPE_SECRET_KEY = 'sk_test_from_the_integration';
      process.env.ORB_STRIPE_SECRET_KEY = 'sk_live_chosen';
      assert.equal(S.stripeKey(), 'sk_live_chosen');
      assert.equal(S.stripeTestMode(), false);
      assert.equal(B.paymentsFor('anyone', { VERCEL_ENV: 'production' }), true);
      process.env.ORB_STRIPE_SECRET_KEY = ' ';
      assert.equal(S.stripeKey(), 'sk_test_from_the_integration', 'blank: the integration’s');
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.ORB_STRIPE_SECRET_KEY;
    }
  });
});
