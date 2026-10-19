#!/usr/bin/env node
// End-to-end tests for plans and credits (src/server/credits.ts, src/server/billing.ts): builds on
// Orb's AI charged in credits, running out, going Pro and buying credit packs through Stripe
// Checkout, Stripe's webhook (signed), coming back from a checkout, the customer portal,
// renewals and cancelling — with the webhook and without it.
//
//   node scripts/test-billing.mjs
//
// Starts the fake Cursor API (scripts/fake-cursor-github.mjs) and the fake Stripe API
// (scripts/fake-stripe.mjs), and `next dev` on :3105 (ORB_TEST_PORT) with a fresh database
// (.data/pglite-billing), the free builder on Orb's Cursor key and small plans (guests 24 credits,
// Free 20, Pro 60), so a few builds use them up. Then once more with a free builder budget that
// one build spends, to see Pro go on. Exit code 0 = all checks passed.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFake } from './fake-cursor-github.mjs';
import { startFakeStripe } from './fake-stripe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.ORB_TEST_PORT || '3105';
const BASE = `http://localhost:${PORT}`;
const WEBHOOK = `${BASE}/api/billing/webhook`;
const ADMIN_TOKEN = 'orb-test-admin';
const DATA_DIR = '.data/pglite-billing';

const results = [];
function check(name, ok, detail) {
  results.push(!!ok);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}
const near = (a, b, eps = 0.02) => typeof a === 'number' && Math.abs(a - b) <= eps;

const device = (label) => `test-${label}-${crypto.randomBytes(8).toString('hex')}`;

async function request(method, urlPath, { dev, body, cookie, headers: extra, raw } = {}) {
  const headers = { ...(dev ? { 'x-orb-device': dev } : {}), ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...extra };
  const res = await fetch(BASE + urlPath, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined), redirect: 'manual', signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json, headers: res.headers, cookie: /orb_session=[^;]+/.exec(res.headers.get('set-cookie') || '')?.[0] ?? null };
}

const BLANK = '<!doctype html><html><head><title>world</title></head><body>hi</body></html>';
const newWorld = async (dev, cookie) => (await request('POST', '/api/worlds', { dev, cookie, body: { name: 'Untitled world', code: BLANK } })).json.world;
const build = (dev, worldId, content, opts = {}) => request('POST', '/api/agent/jobs', { dev, ...opts, body: { worldId, messages: [{ role: 'user', content }], mode: 'build', code: '' } });
const billing = async (dev, cookie) => (await request('GET', '/api/billing', { dev, cookie })).json;
/** What a build used in all: its last credits frame (the ones before say what it used so far). */
const usedBy = (r) => Number([...r.text.matchAll(/"t":"credits","used":([\d.]+)/g)].at(-1)?.[1] ?? NaN);
const newest = (fake) => [...fake.agents.values()].at(-1);
const signUp = async (dev) => {
  const username = `maker-${crypto.randomBytes(3).toString('hex')}`;
  const r = await request('POST', '/api/auth/signup', { dev, body: { username, password: 'correct horse battery' } });
  return { cookie: r.cookie, id: r.json?.user?.id, username };
};

async function startServer(extraEnv = {}) {
  fs.rmSync(path.join(root, DATA_DIR), { recursive: true, force: true });
  const env = { ...process.env };
  for (const k of ['ORB_MOCK_AI', 'ANTHROPIC_API_KEY', 'AI_GATEWAY_API_KEY', 'POSTGRES_URL', 'DATABASE_URL', 'CURSOR_API_KEY', 'ORB_BOTID_TEST', 'STRIPE_WEBHOOK_SECRET', 'ORB_FREE_DAILY_USD', 'ORB_FREE_DAILY_USD_ANON', 'ORB_TOPUPS']) delete env[k];
  Object.assign(env, {
    ORB_CURSOR_KEY: 'crsr_test_billing',
    ORB_CURSOR_API: `http://localhost:${fakeCursor.port}`,
    STRIPE_SECRET_KEY: 'sk_test_orb',
    ORB_STRIPE_API: stripe.url,
    ORB_STRIPE_WEBHOOK_URL: WEBHOOK,
    ORB_GUEST_CREDITS: '24',
    ORB_FREE_CREDITS: '20',
    ORB_PRO_CREDITS: '60',
    ORB_PGLITE_DIR: DATA_DIR,
    ORB_SECRET: 'orb-test-secret',
    ORB_ADMIN_TOKEN: ADMIN_TOKEN,
    ORB_PAYOUT_HOLD_DAYS: '0',
    ORB_PAYOUT_MIN: '50',
    ORB_PAYOUT_BUYERS: '2',
    ORB_PAYOUT_SETTLE_S: '1',
    ORB_USD_PER_EUR: '1.25',
    NEXT_TELEMETRY_DISABLED: '1',
    ...extraEnv,
  });
  console.log(`Starting next dev on :${PORT} (PGlite: ${DATA_DIR}${extraEnv.ORB_FREE_DAILY_USD ? `, $${extraEnv.ORB_FREE_DAILY_USD} a day` : ''}) …`);
  const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '-p', PORT], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next dev exited early:\n${log.slice(-2000)}`);
    try {
      if ((await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(90_000) })).ok) return { child, log: () => log };
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`next dev did not become ready:\n${log.slice(-2000)}`);
}

async function stopServer({ child }) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
}

const fakeCursor = await startFake();
const stripe = await startFakeStripe();
let server = await startServer();
try {
  console.log('\nChecking the Stripe key');
  const noToken = await request('POST', '/api/admin/stripe', {});
  check('checking the key needs the admin token', noToken.status === 401, noToken.json);
  const setup = (await request('POST', '/api/admin/stripe', { headers: { 'x-admin-token': ADMIN_TOKEN } })).json;
  check('…the account it reaches, as Checkout and card statements show it, and that it’s a sandbox', setup?.account?.id === 'acct_fake' && setup.account.name === 'Orbworld' && setup.account.descriptor === 'ORBWORLD' && setup.account.charges === true && setup.live === false, setup);
  check('…and what a first checkout sets up, made now: the Pro price, the portal’s settings, the webhook', !!setup?.price && !!setup.portal && setup.webhook === WEBHOOK && setup.connect === true && setup.problems.length === 0 && stripe.endpoints.size === 1, { setup, endpoints: stripe.endpoints.size });
  await request('POST', '/api/admin/stripe', { headers: { 'x-admin-token': ADMIN_TOKEN } });
  check('…once', stripe.endpoints.size === 1 && stripe.prices.size === 1, { endpoints: stripe.endpoints.size, prices: stripe.prices.size });

  console.log('\nThe plans');
  const GUEST = device('guest');
  let b = await billing(GUEST);
  check('a device without an account has the guest credits, and payments are on', b?.plan === 'guest' && b.credits.left === 24 && b.payments === true && !b.manage, b);
  check('…the guest allowance isn’t among the plans the page is told about', b?.plans && !('guest' in b.plans), b?.plans);
  check('…the plans as set: Free 20, Pro 60 for $20, three packs', b?.plans.free === 20 && b.plans.pro.credits === 60 && b.plans.pro.usd === 20 && b.plans.topups.length === 3, b?.plans);

  console.log('\nA guest builds');
  const w = await newWorld(GUEST);
  const first = await build(GUEST, w.id, 'a glowing garden');
  const used1 = usedBy(first);
  check('the build runs and says what it used when it ends', first.status === 200 && /"t":"version"/.test(first.text) && used1 > 1 && used1 < 24, { used1, tail: first.text.slice(-300) });
  b = await billing(GUEST);
  check('…the device’s credits went down by that', near(b.credits.left, 24 - used1), { left: b.credits.left, used1 });
  check('Orb’s model built it (Claude Opus 5.5, the same for everyone)', newest(fakeCursor).model?.id === 'claude-opus-5-5', newest(fakeCursor).model);
  const second = await build(GUEST, w.id, 'more flowers');
  check('the build that uses the credits up pauses, keeping what it saved', /so I'll pause here — what I made so far is saved\. Create a free account/.test(second.text) && /"t":"version"/.test(second.text) && !/<orb:error>/.test(second.text), second.text.slice(-500));
  check('…its agent is stopped at Cursor', fakeCursor.log.includes(`POST /v1/agents/${newest(fakeCursor).id}/runs/${newest(fakeCursor).runs[0].id}/cancel`));
  const third = await build(GUEST, w.id, 'and a pond');
  check('then builds are turned away → 402 out_of_credits, asking for a free account', third.status === 402 && third.json?.error === 'out_of_credits' && third.json.plan === 'guest' && /create a free account/.test(third.json.message), third.json);
  const ownKey = await build(GUEST, w.id, 'with my own key', { headers: { 'x-orb-agent-provider': 'cursor', 'x-orb-agent-key': 'crsr_own_key' } });
  check('building with one’s own key needs no credits', ownKey.status === 200 && /"t":"version"/.test(ownKey.text) && !/"t":"credits"/.test(ownKey.text), ownKey.json ?? ownKey.text.slice(-200));

  console.log('\nAn account');
  const maker = await signUp(GUEST);
  b = await billing(GUEST, maker.cookie);
  check('signed up: the Free plan’s credits, for the calendar month', b?.plan === 'free' && b.credits.left === 20 && b.credits.monthly === 20 && new Date(b.credits.periodEnd).getUTCDate() === 1, b?.credits);
  const pack = await request('POST', '/api/billing/checkout', { dev: GUEST, cookie: maker.cookie, body: { item: 'usd10' } });
  const freePack = [...stripe.sessions.values()].at(-1);
  check('a Free account can buy a credit pack too: a payment for 800 credits, no Stripe customer yet', pack.status === 200 && pack.json?.url === freePack?.url && freePack.mode === 'payment' && freePack.customer === null && freePack.metadata.credits === '800', { pack: pack.json, freePack });
  check('…without a promotion code field', freePack.allow_promotion_codes === null, freePack.allow_promotion_codes);
  const anon = await request('POST', '/api/billing/checkout', { dev: device('anon'), body: { item: 'pro' } });
  check('checkouts need an account → 401 account_required', anon.status === 401 && anon.json?.error === 'account_required', anon.json);
  const unknown = await request('POST', '/api/billing/checkout', { dev: GUEST, cookie: maker.cookie, body: { item: 'gold' } });
  check('an unknown plan → 400', unknown.status === 400, unknown.json);

  console.log('\nGoing Pro');
  const from = `/w/${w.id}`;
  const co = await request('POST', '/api/billing/checkout', { dev: GUEST, cookie: maker.cookie, body: { item: 'pro', from } });
  const session = [...stripe.sessions.values()].at(-1);
  check('Go Pro opens a Stripe checkout', co.status === 200 && co.json?.url === session?.url, co.json);
  const price = stripe.prices.get(session?.line_items?.[0]?.price);
  check('…for a monthly Pro price of $20, made by Orb with its lookup key', price?.unit_amount === 2000 && price.recurring?.interval === 'month' && price.lookup_key === 'orb_pro_month_usd_2000', price);
  check('…for this account, coming back to the page they left', session.client_reference_id === maker.id && session.subscription_data?.metadata?.orb_user === maker.id && session.success_url === `${BASE}/api/billing/return?session_id={CHECKOUT_SESSION_ID}&to=${encodeURIComponent(from)}` && session.cancel_url === `${BASE}${from}`, session);
  check('…without a promotion code field (Orb has none)', session.allow_promotion_codes === null, session.allow_promotion_codes);
  const endpoint = [...stripe.endpoints.values()][0];
  check('Orb registered its webhook with Stripe, for the events it needs', stripe.endpoints.size === 1 && endpoint.url === WEBHOOK && ['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid'].every((e) => endpoint.enabled_events.includes(e)), [...stripe.endpoints.values()]);
  await request('POST', '/api/billing/checkout', { dev: GUEST, cookie: maker.cookie, body: { item: 'pro', from } });
  check('…once (the next checkout reuses it and the price)', stripe.endpoints.size === 1 && stripe.prices.size === 1);
  const paid = await stripe.complete(session.id);
  check('paying: Stripe’s signed events are accepted', stripe.deliveries.length >= 3 && stripe.deliveries.every((d) => d.status === 200), stripe.deliveries);
  b = await billing(GUEST, maker.cookie);
  check('…and the account is Pro, with Pro’s credits until next month', b?.plan === 'pro' && b.credits.left === 60 && b.credits.monthly === 60 && b.manage === true && Date.parse(b.credits.periodEnd) > Date.now() + 29 * 86_400_000, b?.credits);
  const back = await request('GET', `/api/billing/return?session_id=${session.id}&to=${encodeURIComponent(from)}`);
  check('coming back from Stripe lands on the page they left, saying so', back.status === 303 && back.headers.get('location') === `${from}?billing=pro`, { status: back.status, location: back.headers.get('location') });
  check('…without starting the month again', (await billing(GUEST, maker.cookie)).credits.left === 60);
  const twice = await request('POST', '/api/billing/checkout', { dev: GUEST, cookie: maker.cookie, body: { item: 'pro' } });
  check('Pro again → 409 already_pro', twice.status === 409 && twice.json?.error === 'already_pro', twice.json);

  console.log('\nBuilding on Pro');
  const best = await build(GUEST, w.id, 'a castle on the hill', { cookie: maker.cookie, headers: { 'x-orb-free-model': 'best' } });
  const usedBest = usedBy(best);
  check('Pro builds with the same model as everyone, whatever it asks for', best.status === 200 && newest(fakeCursor).model?.id === 'claude-opus-5-5', newest(fakeCursor).model);
  check('…at the same price per build', usedBest > used1 * 0.6 && usedBest < used1 * 1.6, { usedBest, used1 });
  b = await billing(GUEST, maker.cookie);
  check('…taken from Pro’s credits', near(b.credits.left, 60 - usedBest), { left: b.credits.left, usedBest });

  console.log('\nA credit pack');
  const topup = await request('POST', '/api/billing/checkout', { dev: GUEST, cookie: maker.cookie, body: { item: 'usd10', from: '/' } });
  const packSession = [...stripe.sessions.values()].at(-1);
  check('a Pro member can buy a pack: a $10 payment for 800 credits, as the Pro customer', topup.status === 200 && packSession.mode === 'payment' && packSession.line_items[0].price_data.unit_amount === '1000' && packSession.metadata.credits === '800' && packSession.customer === paid.session.customer, packSession);
  await stripe.complete(packSession.id);
  await stripe.deliver('checkout.session.completed', packSession);
  const packBack = await request('GET', `/api/billing/return?session_id=${packSession.id}&to=/`);
  b = await billing(GUEST, maker.cookie);
  check('the credits are added once, however often Stripe and the page say so', b.credits.topup === 800 && near(b.credits.left, 60 - usedBest + 800) && packBack.headers.get('location') === '/?billing=topup', { credits: b.credits, location: packBack.headers.get('location') });

  console.log('\nBilling');
  const portal = await request('POST', '/api/billing/portal', { dev: GUEST, cookie: maker.cookie, body: { from: from } });
  check('Manage billing opens Stripe’s portal for this customer, coming back to the page', portal.status === 200 && portal.json?.url === `${stripe.url}/portal/${paid.session.customer}?return=${encodeURIComponent(`${BASE}${from}`)}`, portal.json);
  const noPortal = await request('POST', '/api/billing/portal', { dev: device('none'), cookie: (await signUp(device('none'))).cookie, body: {} });
  check('…an account that never paid has no billing to manage → 404', noPortal.status === 404, noPortal.json);

  console.log('\nRenewing and cancelling');
  await stripe.renew(paid.subscription.id);
  b = await billing(GUEST, maker.cookie);
  check('a renewal brings the month’s credits back; the pack stays', b.plan === 'pro' && b.credits.used === 0 && near(b.credits.left, 860), b.credits);
  await stripe.cancelAtPeriodEnd(paid.subscription.id);
  b = await billing(GUEST, maker.cookie);
  check('cancelling in the portal: Pro until the period ends', b.plan === 'pro' && b.credits.cancelAt === new Date(paid.subscription.items.data[0].current_period_end * 1000).toISOString(), b.credits);
  await stripe.end(paid.subscription.id);
  b = await billing(GUEST, maker.cookie);
  check('then back on Free, with the bought credits still there', b.plan === 'free' && b.credits.monthly === 20 && b.credits.topup === 800 && near(b.credits.left, 820), b.credits);
  const after = await build(GUEST, w.id, 'a moon too', { cookie: maker.cookie });
  check('…and builds go on', after.status === 200 && /"t":"version"/.test(after.text), after.json ?? after.text.slice(-200));

  console.log('\nThe webhook only takes Stripe’s word');
  const forged = JSON.stringify({ id: 'evt_x', type: 'customer.subscription.updated', data: { object: { ...paid.subscription, status: 'active' } } });
  const unsigned = await request('POST', '/api/billing/webhook', { raw: forged });
  const wrong = await request('POST', '/api/billing/webhook', { raw: forged, headers: { 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` } });
  check('an unsigned or wrongly signed event is refused → 400', unsigned.status === 400 && wrong.status === 400, [unsigned.status, wrong.status]);
  check('…and changes nothing', (await billing(GUEST, maker.cookie)).plan === 'free');
  // With the signing secret (a leaked one, say), an event still only says what to look up at Stripe.
  const beforeForged = (await billing(GUEST, maker.cookie)).credits;
  await stripe.deliver('checkout.session.completed', { ...packSession, id: 'cs_made_up', metadata: { ...packSession.metadata, credits: '1000000' } });
  await stripe.deliver('checkout.session.completed', { ...packSession, metadata: { ...packSession.metadata, credits: '1000000' } });
  await stripe.deliver('customer.subscription.updated', { ...paid.subscription, id: 'sub_made_up', status: 'active' });
  const forgedAfter = await billing(GUEST, maker.cookie);
  check('a correctly signed but made-up or doctored event grants nothing: what counts is what Stripe has', forgedAfter.plan === 'free' && forgedAfter.credits.topup === beforeForged.topup && stripe.deliveries.slice(-3).every((d) => d.status === 200), { before: beforeForged, after: forgedAfter.credits, plan: forgedAfter.plan, statuses: stripe.deliveries.slice(-3).map((d) => d.status) });

  console.log('\nWithout the webhook');
  stripe.state.webhooks = false;
  stripe.state.period = 6;
  const D2 = device('quiet');
  const quiet = await signUp(D2);
  await request('POST', '/api/billing/checkout', { dev: D2, cookie: quiet.cookie, body: { item: 'pro', from: '/' } });
  const quietSession = [...stripe.sessions.values()].at(-1);
  const quietPaid = await stripe.complete(quietSession.id);
  check('paid, but Stripe hasn’t told Orb yet: still Free', (await billing(D2, quiet.cookie)).plan === 'free');
  const quietBack = await request('GET', `/api/billing/return?session_id=${quietSession.id}&to=/`);
  check('coming back from Stripe makes it Pro', quietBack.headers.get('location') === '/?billing=pro' && (await billing(D2, quiet.cookie)).plan === 'pro', quietBack.headers.get('location'));
  const qw = await newWorld(D2, quiet.cookie);
  await build(D2, qw.id, 'a quiet lake', { cookie: quiet.cookie });
  await new Promise((r) => setTimeout(r, 6500));
  await stripe.renew(quietPaid.subscription.id);
  b = await billing(D2, quiet.cookie);
  check('a Pro period that ended is looked up in Stripe: renewed, with fresh credits', b.plan === 'pro' && b.credits.used === 0 && b.credits.left === 60 && Date.parse(b.credits.periodEnd) > Date.now(), b.credits);
  stripe.state.webhooks = true;
  stripe.state.period = 30 * 86_400;

  console.log('\nShops in worlds: makers earn from paid credits');
  const SELLER = device('seller');
  const FAN = device('fan');
  const PRO_FAN = device('pro-fan');
  const seller = await signUp(SELLER);
  const shopPage = `<!doctype html><html><head><title>shop</title><script type="application/json" id="orb-shop">${JSON.stringify({ items: [{ id: 'star-hat', name: 'Star Hat', price: 30 }, { id: 'boots', name: 'Moon Boots', price: 10 }, { id: 'castle', name: 'Castle', price: 1000 }, { id: 'cape', name: 'Cape', price: 60 }, { id: 'crown', name: 'Crown', price: 100 }, { id: 'gem', name: 'Gem', price: 60 }] })}</script></head><body>shop</body></html>`;
  const shopWorld = (await request('POST', '/api/worlds', { dev: SELLER, cookie: seller.cookie, body: { name: 'Hat Shop', code: shopPage } })).json.world;
  const buy = (dev, cookie, item, price) => request('POST', `/api/worlds/${shopWorld.id}/shop`, { dev, cookie, body: { item, price } });
  const earned = async () => (await billing(SELLER, seller.cookie)).earnings;
  const fan = await signUp(FAN);
  await request('POST', '/api/billing/checkout', { dev: FAN, cookie: fan.cookie, body: { item: 'usd10', from: '/' } });
  await stripe.complete([...stripe.sessions.values()].at(-1).id);
  b = await billing(FAN, fan.cookie);
  check('a Free account’s pack: its credits on top of the month’s', b.plan === 'free' && b.credits.topup === 800 && b.credits.left === 820, b.credits);
  const shopView = (await request('GET', `/api/worlds/${shopWorld.id}/shop`, { dev: FAN, cookie: fan.cookie })).json;
  check('…the shop knows 800 of the 820 are paid for', shopView?.credits === 820 && shopView.paid === 800, shopView);
  const hat = await buy(FAN, fan.cookie, 'star-hat', 30);
  let earn = await earned();
  b = await billing(FAN, fan.cookie);
  check('a 30-credit hat comes out of the pack first (the month’s free credits stay for building): the maker earns all of it', hat.status === 200 && near(hat.json.credits, 790) && b.credits.topup === 770 && b.credits.used === 0 && near(earn?.credits, 30) && near(earn.total, 30), { hat: hat.json, credits: b.credits, earn });
  await buy(FAN, fan.cookie, 'boots', 10);
  earn = await earned();
  check('boots: 10 more', near(earn?.credits, 40), earn);
  const castle = await buy(FAN, fan.cookie, 'castle', 1000);
  check('more than they have → 402 no_credits, with how many more', castle.status === 402 && castle.json?.error === 'no_credits' && castle.json.need === 220 && near((await billing(FAN, fan.cookie)).credits.left, 780), castle.json);
  const proFan = await signUp(PRO_FAN);
  await request('POST', '/api/billing/checkout', { dev: PRO_FAN, cookie: proFan.cookie, body: { item: 'pro', from: '/' } });
  await stripe.complete([...stripe.sessions.values()].at(-1).id);
  const proHat = await buy(PRO_FAN, proFan.cookie, 'star-hat', 30);
  earn = await earned();
  check('Pro’s monthly credits are paid for: 30 more', proHat.status === 200 && near(proHat.json.credits, 30) && near(earn?.credits, 70) && near(earn.total, 70), { proHat: proHat.json, earn });
  const saleNotes = (await request('GET', '/api/friends', { dev: SELLER, cookie: seller.cookie })).json?.notes?.filter((n) => n.kind === 'sale') ?? [];
  check('the maker has one note for the world, adding up the sales and what they earned', saleNotes.length === 1 && saleNotes[0].sale.count === 3 && near(saleNotes[0].sale.credits, 70) && saleNotes[0].sale.item === 'Star Hat', saleNotes);
  const sellerBefore = (await billing(SELLER, seller.cookie)).credits;
  const use = await request('POST', '/api/billing/earnings', { dev: SELLER, cookie: seller.cookie });
  check('building with the earnings: they become bonus credits (not bought ones)', use.status === 200 && near(use.json.credits.bonus, sellerBefore.bonus + 70) && near(use.json.credits.topup, sellerBefore.topup) && near(use.json.credits.left, sellerBefore.left + 70) && near(use.json.earnings.credits, 0) && near(use.json.earnings.total, 70), { before: sellerBefore, after: use.json?.credits, earnings: use.json?.earnings });
  const useAgain = await request('POST', '/api/billing/earnings', { dev: SELLER, cookie: seller.cookie });
  check('…once', near(useAgain.json.credits.bonus, sellerBefore.bonus + 70), useAgain.json?.credits);
  const sellerBuild = await build(SELLER, shopWorld.id, 'a bigger shop', { cookie: seller.cookie });
  check('…and they build with them', sellerBuild.status === 200 && /"t":"version"/.test(sellerBuild.text), sellerBuild.json ?? sellerBuild.text.slice(-200));

  console.log('\nCash payouts of earnings (Stripe Connect): only what other players paid, checked by Orb');
  {
    // A shop of its own: the seller's build just now rewrote the first one's page.
    const stall = (await request('POST', '/api/worlds', { dev: SELLER, cookie: seller.cookie, body: { name: 'Cape Stall', code: shopPage } })).json.world;
    const buy = (dev, cookie, item, price) => request('POST', `/api/worlds/${stall.id}/shop`, { dev, cookie, body: { item, price } });
    const seen = (dev, cookie) => request('POST', '/api/events', { dev, cookie, body: { events: [{ name: 'page_view', session: `s${crypto.randomBytes(4).toString('hex')}`, path: '/' }] } });
    const pack = async (dev, cookie, card) => {
      stripe.state.card = card ?? null;
      await request('POST', '/api/billing/checkout', { dev, cookie, body: { item: 'usd10', from: '/' } });
      return stripe.complete([...stripe.sessions.values()].at(-1).id);
    };
    const earnings = async () => (await billing(SELLER, seller.cookie)).earnings;
    const admin = { 'x-admin-token': ADMIN_TOKEN };
    await seen(SELLER, seller.cookie);
    await buy(FAN, fan.cookie, 'cape', 60);
    await buy(PRO_FAN, proFan.cookie, 'boots', 10);
    let po = await earnings();
    check('payouts are open: 70 payable from 2 players (what was built with came off the oldest), in euros', po?.payouts?.account === 'none' && near(po.payouts.payable, 70) && po.payouts.buyers === 2 && po.payouts.minBuyers === 2 && po.payouts.minimum === 50 && po.payouts.currency === 'eur' && po.payouts.usdPer === 1.25 && near(po.credits, 70), po);

    // The maker's own accounts: one on the maker's device, one paying with the maker's card.
    const ALT = device('alt');
    const alt = await signUp(ALT);
    await seen(SELLER, alt.cookie);
    await pack(ALT, alt.cookie);
    await buy(ALT, alt.cookie, 'crown', 100);
    await pack(SELLER, seller.cookie, 'fp_makers_card');
    const ALT2 = device('alt2');
    const alt2 = await signUp(ALT2);
    await pack(ALT2, alt2.cookie, 'fp_makers_card');
    await buy(ALT2, alt2.cookie, 'gem', 60);
    po = await earnings();
    check('what the maker’s own accounts (a shared device, a shared card) buy earns credits to build with, never cash (what was built with came out of them)', near(po.credits, 230) && near(po.payouts.payable, 140) && po.payouts.buyers === 2, po);
    await buy(FAN, fan.cookie, 'crown', 100);
    po = await earnings();
    check('another player’s purchase: cashable', near(po.payouts.payable, 240) && near(po.credits, 330), po);

    const noAccount = await request('POST', '/api/billing/payouts', { dev: SELLER, cookie: seller.cookie });
    check('cashing out before setting payouts up → 409 payout_setup', noAccount.status === 409 && noAccount.json?.error === 'payout_setup', noAccount.json);
    const us = await request('POST', '/api/billing/payouts/setup', { dev: SELLER, cookie: seller.cookie, body: { country: 'US', from: '/orb/x' } });
    check('a country Stripe can’t pay from Orb’s → 400 country_unsupported, nothing kept', us.status === 400 && us.json?.error === 'country_unsupported' && stripe.accounts.size === 0, us.json);
    const setup = await request('POST', '/api/billing/payouts/setup', { dev: SELLER, cookie: seller.cookie, body: { country: 'DE', from: '/orb/x' } });
    const acct = [...stripe.accounts.values()].at(-1);
    check('setting up: an Express account in their country that only receives transfers, and Stripe’s onboarding', setup.status === 200 && setup.json.url.includes(`/connect/${acct?.id}`) && acct.type === 'express' && acct.country === 'DE' && acct.tos_acceptance.service_agreement === 'recipient' && acct.metadata.orb_user === seller.id, { setup: setup.json, acct });
    const again = await request('POST', '/api/billing/payouts/setup', { dev: SELLER, cookie: seller.cookie, body: { country: 'FR', from: '/orb/x' } });
    check('…asking again keeps the same account', again.status === 200 && stripe.accounts.size === 1 && again.json.url.includes(acct.id));
    check('…which isn’t ready until Stripe says so', (await earnings()).payouts.account === 'pending' && (await request('POST', '/api/billing/payouts', { dev: SELLER, cookie: seller.cookie })).json?.error === 'payout_setup');
    const back = new URL(setup.json.url).searchParams.get('return');
    stripe.onboard(acct.id);
    const ret = await request('GET', new URL(back).pathname + new URL(back).search, { dev: SELLER, cookie: seller.cookie });
    check('back from Stripe: read from Stripe, ready, on the page they came from', ret.status === 303 && ret.headers.get('location') === '/orb/x?billing=payouts' && (await earnings()).payouts.account === 'ready', { status: ret.status, location: ret.headers.get('location') });

    const ask = async () => request('POST', '/api/billing/payouts', { dev: SELLER, cookie: seller.cookie });
    let req1 = await ask();
    check('cashing out is a request Orb checks first: 240 credits = €1.92 at 1.25 US$ a euro, nothing sent yet', req1.status === 200 && req1.json.payout.requested === true && near(req1.json.payout.credits, 240) && near(req1.json.payout.amount, 1.92) && stripe.transfers.length === 0 && near(req1.json.billing.earnings.payouts.requested, 240) && near(req1.json.billing.earnings.credits, 90), req1.json);
    await buy(FAN, fan.cookie, 'gem', 60);
    const open = await ask();
    check('…one open at a time (409 payout_open), however much more comes in', open.status === 409 && open.json?.error === 'payout_open', open.json);
    const list = await request('GET', '/api/admin/payouts', { headers: admin });
    const r1 = list.json?.requests?.[0];
    check('Orb sees what’s behind it: the sales, from how many players, the biggest buyer’s part, what can’t be paid out', list.status === 200 && list.json.requests.length === 1 && r1.id && r1.sales.buyers === 2 && near(r1.excluded, 160) && r1.country === 'DE' && r1.user.handle === seller.username && r1.sales.worlds.length === 2, r1);
    check('…only with the admin token', (await request('GET', '/api/admin/payouts')).status === 401);
    const rejected = await request('POST', `/api/admin/payouts/${r1.id}`, { headers: admin, body: { action: 'reject', note: 'looks like one buyer' } });
    po = await earnings();
    check('rejected: the earnings are the maker’s again', rejected.status === 200 && rejected.json.status === 'rejected' && near(po.credits, 390) && near(po.payouts.requested, 0) && near(po.payouts.payable, 300), { rejected: rejected.json, po });

    req1 = await ask();
    const r2 = (await request('GET', '/api/admin/payouts', { headers: admin })).json.requests[0];
    stripe.state.balance = 0;
    const broke = await request('POST', `/api/admin/payouts/${r2.id}`, { headers: admin, body: { action: 'approve' } });
    po = await earnings();
    check('approved, but Orb’s Stripe balance is too low → 502 payout_failed, the earnings stay the maker’s', broke.status === 502 && broke.json?.error === 'payout_failed' && near(po.credits, 390) && stripe.transfers.length === 0, { broke: broke.json, po });
    stripe.state.balance = 1e9;

    await ask();
    const r3 = (await request('GET', '/api/admin/payouts', { headers: admin })).json.requests[0];
    stripe.state.dropTransferReply = true;
    const lost = await request('POST', `/api/admin/payouts/${r3.id}`, { headers: admin, body: { action: 'approve' } });
    const tr = stripe.transfers.at(-1);
    check('approved: sent to their account in euros (Stripe’s answer lost: pending)', lost.status === 200 && lost.json.status === 'pending' && tr?.amount === 240 && tr.currency === 'eur' && tr.destination === acct.id && tr.metadata.orb_payout === r3.id, { lost: lost.json, tr });
    await new Promise((r) => setTimeout(r, 1600));
    po = await earnings();
    check('…then found in Stripe and settled as paid, not sent twice', near(po.payouts.paid, 300) && stripe.transfers.length === 1 && near(po.credits, 90), { payouts: po.payouts, transfers: stripe.transfers.length });
    check('…and nothing more to cash out from other players (409 below_minimum)', (await ask()).json?.error === 'below_minimum');

    const fanCharge = [...stripe.charges.values()].find((c) => stripe.intents.get(c.payment_intent)?.metadata?.orb_user === fan.id);
    check('Stripe listens for refunds and disputes too', [...stripe.endpoints.values()].every((ep) => ep.enabled_events.includes('charge.dispute.created') && ep.enabled_events.includes('charge.refunded')));
    await stripe.dispute(fanCharge.id);
    po = await earnings();
    const fanNow = await billing(FAN, fan.cookie);
    check('a fan’s payment is disputed: what their purchases earned is taken back (below zero: already paid out), and their pack’s credits', near(po.credits, -170) && near(po.payouts.payable, 0) && near(fanNow.credits.topup, -260), { earnings: po, fan: fanNow.credits });
    await stripe.dispute(fanCharge.id);
    check('…once', near((await earnings()).credits, -170) && near((await billing(FAN, fan.cookie)).credits.topup, -260));
    const dash = await request('POST', '/api/billing/payouts/dashboard', { dev: SELLER, cookie: seller.cookie, body: { from: '/' } });
    check('their payouts in Stripe’s dashboard', dash.status === 200 && dash.json.url.endsWith(`/express/${acct.id}`), dash.json);
    stripe.state.connect = false;
  }

  console.log('\nA customer from another Stripe account (after Orb’s key changed)');
  const fanCustomer = [...stripe.sessions.values()].find((s) => s.client_reference_id === fan.id && s.customer)?.customer;
  const fanBefore = await billing(FAN, fan.cookie);
  check('the fan has billing to manage, as far as Orb knows', !!fanCustomer && fanBefore.manage === true, fanCustomer);
  stripe.customers.delete(fanCustomer);
  const again = await request('POST', '/api/billing/checkout', { dev: FAN, cookie: fan.cookie, body: { item: 'usd10', from: '/' } });
  const fresh = [...stripe.sessions.values()].at(-1);
  check('a checkout with a customer Stripe doesn’t know starts without it', again.status === 200 && again.json?.url === fresh.url && fresh.customer === null && fresh.client_reference_id === fan.id, { again: again.json, customer: fresh.customer });
  await stripe.complete(fresh.id);
  b = await billing(FAN, fan.cookie);
  check('…paying there: the credits come, and the new customer is theirs', b.manage === true && b.credits.topup === fanBefore.credits.topup + 800, b.credits);
  stripe.customers.delete(fresh.customer);
  const gone = await request('POST', '/api/billing/portal', { dev: FAN, cookie: fan.cookie, body: {} });
  check('the portal with a customer Stripe doesn’t know → no billing to manage (404), and Orb forgets it', gone.status === 404 && gone.json?.error === 'not_found' && (await billing(FAN, fan.cookie)).manage === false, gone.json);

  console.log('\nPro goes on when the free builder’s budget is spent');
  await stopServer(server);
  const oldEndpoints = [...stripe.endpoints.keys()];
  server = await startServer({ ORB_FREE_DAILY_USD: '0.0001', ORB_FREE_DAILY_PER_ACCOUNT: '1' });
  const D3 = device('busy');
  const free3 = await signUp(D3);
  const w3 = await newWorld(D3, free3.cookie);
  const spend = await build(D3, w3.id, 'a little hill', { cookie: free3.cookie });
  check('the first free build of the day spends the whole (tiny) budget', spend.status === 200 && /"t":"version"/.test(spend.text), spend.json ?? spend.text.slice(-200));
  const rest = await build(D3, w3.id, 'a little tree', { cookie: free3.cookie });
  check('then free builds are turned away for today', rest.status === 429 || rest.status === 503, rest.json);
  await request('POST', '/api/billing/checkout', { dev: D3, cookie: free3.cookie, body: { item: 'pro', from: '/' } });
  await stripe.complete([...stripe.sessions.values()].at(-1).id);
  check('going Pro (Orb registered its webhook again in this new database)', stripe.endpoints.size === 1 && (await billing(D3, free3.cookie)).plan === 'pro', { endpoints: stripe.endpoints.size, deliveries: stripe.deliveries.slice(-3) });
  check('…and took its old endpoint at that address away (its secret was the old database’s)', oldEndpoints.length === 1 && !stripe.endpoints.has(oldEndpoints[0]), { oldEndpoints, now: [...stripe.endpoints.keys()] });
  const closed = (await billing(D3, free3.cookie)).earnings;
  check('without Stripe Connect, payouts stay closed', closed && closed.payouts === null, closed);
  const pro3 = await build(D3, w3.id, 'a little tree', { cookie: free3.cookie });
  const pro4 = await build(D3, w3.id, 'and a bench', { cookie: free3.cookie });
  check('Pro builds go on: outside the free budget and the daily caps', pro3.status === 200 && /"t":"version"/.test(pro3.text) && pro4.status === 200 && /"t":"version"/.test(pro4.text), pro3.json ?? pro4.json ?? pro4.text.slice(-200));
} catch (e) {
  check('unexpected exception', false, e?.stack?.split('\n').slice(0, 4).join(' | ') ?? String(e));
} finally {
  await stopServer(server);
  fakeCursor.close();
  stripe.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) console.log(server.log().slice(-4000));
process.exit(failed ? 1 : 0);
