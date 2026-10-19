// A small fake of the Stripe API Orb's plans and payouts use (src/server/stripe.ts, billing.ts, payouts.ts), for
// scripts/test-billing.mjs: point ORB_STRIPE_API at it. It keeps customers, prices, checkout
// sessions, subscriptions and webhook endpoints in memory, answers in Stripe's shapes (form-encoded
// requests, `{ error: { message } }` failures), and plays the customer's side: paying a checkout,
// a renewal, cancelling. Each of those delivers its events to the registered webhook endpoints,
// signed the way Stripe signs them (or not at all: `webhooks = false`).
import http from 'node:http';
import crypto from 'node:crypto';

const DAY = 86_400;

/** `a[b][0][c]=1` form fields → nested objects and arrays. */
function parseForm(body) {
  const out = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const parts = key.split(/\[|\]\[|\]/).filter((p) => p !== '');
    let node = out;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(parts[i + 1]);
      if (last) node[part] = value;
      else node = node[part] ??= nextIsIndex ? [] : {};
    });
  }
  return out;
}

export function startFakeStripe(port = 0) {
  const customers = new Map();
  const prices = new Map();
  const sessions = new Map();
  const subscriptions = new Map();
  const endpoints = new Map();
  const accounts = new Map();
  const transfers = [];
  const intents = new Map();
  const charges = new Map();
  const disputes = new Map();
  const deliveries = [];
  const log = [];
  const idem = new Map();
  let seq = 0;
  const id = (prefix) => `${prefix}_${(++seq).toString(36)}${crypto.randomBytes(5).toString('hex')}`;
  const now = () => Math.floor(Date.now() / 1000);
  let base = '';
  // connect: the account has Stripe Connect; balance: the platform's (cents); dropTransferReply: the
  // next transfer is made but its answer is lost (a 500).
  // card: the fingerprint of the card the next checkout is paid with (default: one per customer).
  const state = { webhooks: true, period: 30 * DAY, connect: true, balance: 1e9, dropTransferReply: false, card: null };

  /** The maker finishes Stripe's onboarding: transfers are active and their bank can be paid. */
  function onboard(acctId) {
    const a = accounts.get(acctId);
    a.details_submitted = true;
    a.payouts_enabled = true;
    a.capabilities.transfers = 'active';
    return a;
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const fail = (res, status, message, extra = {}) => send(res, status, { error: { message, type: 'invalid_request_error', ...extra } });
  const noCustomer = (res, cus) => fail(res, 400, `No such customer: '${cus}'`, { code: 'resource_missing', param: 'customer' });
  const page = (res, title, body) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${title}</title><style>body{font:16px system-ui;max-width:420px;margin:80px auto;padding:0 20px}h1{font-size:22px}.muted{color:#888}button{font:inherit;padding:10px 22px;border-radius:8px;border:0;background:#635bff;color:#fff;cursor:pointer}</style>${body}`);
  };

  function sign(payload, secret) {
    const t = now();
    return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
  }

  /** Send an event to every endpoint that wants it (in order, waiting for each answer). */
  async function deliver(type, object) {
    if (!state.webhooks) return [];
    const event = { id: id('evt'), object: 'event', type, created: now(), data: { object } };
    const payload = JSON.stringify(event);
    const answers = [];
    for (const ep of endpoints.values()) {
      if (!ep.enabled_events.includes(type) && !ep.enabled_events.includes('*')) continue;
      const res = await fetch(ep.url, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload, ep.secret) }, body: payload }).catch((e) => ({ status: 0, text: async () => String(e) }));
      answers.push(res.status);
      deliveries.push({ type, url: ep.url, status: res.status });
    }
    return answers;
  }

  function newSubscription(customer, priceId, metadata) {
    const start = now();
    const sub = {
      id: id('sub'),
      object: 'subscription',
      status: 'active',
      customer,
      metadata: metadata ?? {},
      cancel_at_period_end: false,
      cancel_at: null,
      items: { data: [{ id: id('si'), price: prices.get(priceId), current_period_start: start, current_period_end: start + state.period }] },
    };
    subscriptions.set(sub.id, sub);
    return sub;
  }

  const invoiceFor = (sub, reason) => ({ id: id('in'), object: 'invoice', status: 'paid', billing_reason: reason, customer: sub.customer, parent: { type: 'subscription_details', subscription_details: { subscription: sub.id } } });

  /** The customer pays a checkout (`expire`: the page timed out instead). */
  async function complete(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error(`fake stripe: no session ${sessionId}`);
    if (!s.customer) {
      const c = { id: id('cus'), object: 'customer', metadata: {} };
      customers.set(c.id, c);
      s.customer = c.id;
    }
    s.status = 'complete';
    s.payment_status = 'paid';
    const fingerprint = state.card ?? `fp_${s.customer}`;
    state.card = null;
    s.card = fingerprint;
    if (s.mode === 'payment') {
      const amount = Number(s.line_items[0]?.price_data?.unit_amount ?? 0);
      const pi = { id: id('pi'), object: 'payment_intent', amount, metadata: s.payment_intent_data?.metadata ?? {}, latest_charge: null };
      const ch = { id: id('ch'), object: 'charge', amount, amount_refunded: 0, refunded: false, disputed: false, customer: s.customer, payment_intent: pi.id, payment_method_details: { card: { fingerprint } } };
      pi.latest_charge = ch.id;
      intents.set(pi.id, pi);
      charges.set(ch.id, ch);
      s.payment_intent = pi.id;
    }
    if (s.mode === 'subscription') {
      const sub = newSubscription(s.customer, s.line_items[0].price, s.subscription_data?.metadata);
      sub.default_payment_method = { id: id('pm'), object: 'payment_method', card: { fingerprint } };
      s.subscription = sub.id;
      await deliver('customer.subscription.created', sub);
      await deliver('checkout.session.completed', s);
      await deliver('invoice.paid', invoiceFor(sub, 'subscription_create'));
      return { session: s, subscription: sub };
    }
    await deliver('checkout.session.completed', s);
    return { session: s };
  }

  /** The customer gets (some of) a pack's payment back: a refund, or a dispute (a chargeback). */
  async function refund(chargeId, amount) {
    const ch = charges.get(chargeId);
    ch.amount_refunded = Math.min(ch.amount, ch.amount_refunded + (amount ?? ch.amount));
    ch.refunded = ch.amount_refunded >= ch.amount;
    await deliver('charge.refunded', ch);
    return ch;
  }
  async function dispute(chargeId) {
    const ch = charges.get(chargeId);
    ch.disputed = true;
    const d = { id: id('dp'), object: 'dispute', charge: ch.id, amount: ch.amount, status: 'needs_response' };
    disputes.set(d.id, d);
    await deliver('charge.dispute.created', d);
    return d;
  }

  /** The next period of a subscription starts (and its invoice is paid). */
  async function renew(subId) {
    const sub = subscriptions.get(subId);
    const item = sub.items.data[0];
    item.current_period_start = Math.max(item.current_period_end, now() - 1);
    item.current_period_end = item.current_period_start + state.period;
    await deliver('invoice.paid', invoiceFor(sub, 'subscription_cycle'));
    await deliver('customer.subscription.updated', sub);
    return sub;
  }

  /** Cancel at the end of the period (as the customer portal does). */
  async function cancelAtPeriodEnd(subId) {
    const sub = subscriptions.get(subId);
    sub.cancel_at_period_end = true;
    sub.cancel_at = sub.items.data[0].current_period_end;
    await deliver('customer.subscription.updated', sub);
    return sub;
  }

  /** The subscription is over. */
  async function end(subId) {
    const sub = subscriptions.get(subId);
    sub.status = 'canceled';
    sub.ended_at = now();
    await deliver('customer.subscription.deleted', sub);
    return sub;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    let body = '';
    for await (const c of req) body += c;
    log.push(`${req.method} ${p}`);
    let m;
    // The customer's side in a browser: a checkout page to pay on, and the portal to cancel in.
    if ((m = /^\/pay\/([^/]+)$/.exec(p))) {
      const s = sessions.get(m[1]);
      if (!s) return fail(res, 404, 'No such checkout');
      if (req.method === 'POST') {
        await complete(s.id);
        res.writeHead(303, { location: s.success_url.replace('{CHECKOUT_SESSION_ID}', s.id) });
        return res.end();
      }
      const item = s.mode === 'subscription' ? `Orb Pro — $${prices.get(s.line_items[0].price).unit_amount / 100} a month` : `${s.line_items[0].price_data.product_data?.name ?? 'Credits'} — $${Number(s.line_items[0].price_data.unit_amount) / 100}`;
      return page(res, 'Checkout', `<p class="muted">Fake Stripe Checkout (test)</p><h1>${item}</h1><form method="post"><button>Pay</button></form><p><a href="${s.cancel_url}">Back</a></p>`);
    }
    if ((m = /^\/portal\/([^/]+)$/.exec(p))) {
      const back = url.searchParams.get('return') ?? '/';
      const sub = [...subscriptions.values()].find((x) => x.customer === m[1] && x.status === 'active');
      if (req.method === 'POST') {
        if (sub) await cancelAtPeriodEnd(sub.id);
        res.writeHead(303, { location: back });
        return res.end();
      }
      return page(res, 'Billing', `<p class="muted">Fake Stripe customer portal (test)</p><h1>${sub ? (sub.cancel_at_period_end ? 'Orb Pro — ends at the period’s end' : 'Orb Pro — active') : 'No plan'}</h1>${sub && !sub.cancel_at_period_end ? '<form method="post"><button>Cancel plan</button></form>' : ''}<p><a href="${back}">Back to Orb</a></p>`);
    }
    if ((m = /^\/connect\/([^/]+)$/.exec(p))) {
      const a = accounts.get(m[1]);
      if (!a) return fail(res, 404, 'No such account');
      if (req.method === 'POST') {
        onboard(a.id);
        res.writeHead(303, { location: url.searchParams.get('return') ?? '/' });
        return res.end();
      }
      return page(res, 'Payouts', `<p class="muted">Fake Stripe Connect onboarding (test)</p><h1>Get paid by Orb</h1><form method="post"><button>Agree and submit</button></form>`);
    }
    if (!/^Bearer sk_test_\w+$/.test(req.headers.authorization ?? '')) return fail(res, 401, 'Invalid API Key provided');
    const form = req.method === 'GET' ? parseForm(url.search.slice(1)) : parseForm(body);
    const key = req.headers['idempotency-key'];
    if (key && idem.has(key)) return send(res, 200, idem.get(key));
    const ok = (obj) => {
      if (key) idem.set(key, obj);
      send(res, 200, obj);
    };

    if (req.method === 'POST' && p === '/v1/customers') {
      const c = { id: id('cus'), object: 'customer', metadata: form.metadata ?? {} };
      customers.set(c.id, c);
      return ok(c);
    }
    if (req.method === 'GET' && p === '/v1/prices') {
      const keys = form.lookup_keys ?? [];
      return ok({ object: 'list', data: [...prices.values()].filter((x) => keys.includes(x.lookup_key) && x.active) });
    }
    if (req.method === 'POST' && p === '/v1/prices') {
      if (!form.unit_amount || !form.currency) return fail(res, 400, 'Missing unit_amount or currency');
      const price = { id: id('price'), object: 'price', active: true, currency: form.currency, unit_amount: Number(form.unit_amount), recurring: form.recurring ?? null, lookup_key: form.lookup_key ?? null, product: id('prod') };
      prices.set(price.id, price);
      return ok(price);
    }
    if (req.method === 'GET' && p === '/v1/account') {
      return ok({ id: 'acct_fake', object: 'account', country: 'EE', default_currency: 'eur', charges_enabled: true, payouts_enabled: true, business_profile: { name: 'Orbworld' }, settings: { payments: { statement_descriptor: 'ORBWORLD' } }, requirements: { currently_due: [] } });
    }
    // ---- Connect ----
    if (req.method === 'POST' && p === '/v1/accounts') {
      if (!state.connect) return fail(res, 400, "You can only create new accounts if you've signed up for Connect, which you can learn how to do at https://stripe.com/docs/connect.");
      if (!/^[A-Z]{2}$/.test(form.country ?? '') || form.country === 'XX') return fail(res, 400, `Country '${form.country}' is unknown. Try using a 2-character alphanumeric country code instead, such as 'US', 'EG', or 'GB'.`, { param: 'country' });
      if (form.country === 'US' && form.tos_acceptance?.service_agreement === 'recipient') return fail(res, 400, 'The recipient service agreement is not supported for accounts in US.', { param: 'tos_acceptance[service_agreement]' });
      const a = { id: id('acct'), object: 'account', type: form.type, country: form.country, metadata: form.metadata ?? {}, tos_acceptance: form.tos_acceptance ?? {}, capabilities: { transfers: 'inactive' }, payouts_enabled: false, details_submitted: false };
      accounts.set(a.id, a);
      return ok(a);
    }
    if (req.method === 'GET' && (m = /^\/v1\/accounts\/([^/]+)$/.exec(p))) {
      const a = accounts.get(m[1]);
      return a ? ok(a) : fail(res, 404, `No such account: '${m[1]}'`, { code: 'resource_missing' });
    }
    if (req.method === 'POST' && p === '/v1/account_links') {
      if (!accounts.has(form.account)) return fail(res, 400, `No such account: '${form.account}'`);
      if (!form.return_url || !form.refresh_url) return fail(res, 400, 'Missing return_url or refresh_url');
      return ok({ object: 'account_link', url: `${base}/connect/${form.account}?return=${encodeURIComponent(form.return_url)}&refresh=${encodeURIComponent(form.refresh_url)}` });
    }
    if (req.method === 'POST' && (m = /^\/v1\/accounts\/([^/]+)\/login_links$/.exec(p))) {
      return accounts.get(m[1])?.details_submitted ? ok({ object: 'login_link', url: `${base}/express/${m[1]}` }) : fail(res, 400, 'Cannot create a login link for an account that has not completed onboarding.');
    }
    if (req.method === 'POST' && p === '/v1/transfers') {
      const a = accounts.get(form.destination);
      if (!a || a.capabilities.transfers !== 'active') return fail(res, 400, 'Your destination account needs to have the transfers capability active.');
      const amount = Number(form.amount);
      if (amount > state.balance) return fail(res, 400, 'You have insufficient available funds in your Stripe account.', { code: 'balance_insufficient' });
      state.balance -= amount;
      const t = { id: id('tr'), object: 'transfer', amount, currency: form.currency, destination: form.destination, metadata: form.metadata ?? {}, created: now() };
      transfers.push(t);
      if (key) idem.set(key, t);
      if (state.dropTransferReply) {
        state.dropTransferReply = false;
        return fail(res, 500, 'An unknown error occurred');
      }
      return ok(t);
    }
    if (req.method === 'GET' && p === '/v1/transfers') {
      return ok({ object: 'list', data: transfers.filter((t) => !form.destination || t.destination === form.destination).reverse(), has_more: false });
    }
    if (req.method === 'POST' && p === '/v1/checkout/sessions') {
      const items = form.line_items ?? [];
      if (!['subscription', 'payment'].includes(form.mode)) return fail(res, 400, 'Invalid mode');
      if (!form.success_url?.includes('{CHECKOUT_SESSION_ID}')) return fail(res, 400, 'success_url should carry {CHECKOUT_SESSION_ID}');
      if (form.mode === 'subscription' && !prices.get(items[0]?.price)?.recurring) return fail(res, 400, 'A subscription needs a recurring price');
      if (form.mode === 'payment' && !items[0]?.price_data?.unit_amount) return fail(res, 400, 'A payment needs price_data');
      if (form.customer && !customers.has(form.customer)) return noCustomer(res, form.customer);
      const s = {
        id: id('cs_test'),
        object: 'checkout.session',
        mode: form.mode,
        status: 'open',
        payment_status: 'unpaid',
        client_reference_id: form.client_reference_id ?? null,
        customer: form.customer ?? null,
        subscription: null,
        metadata: form.metadata ?? {},
        subscription_data: form.subscription_data ?? null,
        payment_intent_data: form.payment_intent_data ?? null,
        allow_promotion_codes: form.allow_promotion_codes ?? null,
        line_items: items,
        success_url: form.success_url,
        cancel_url: form.cancel_url,
      };
      s.url = `${base}/pay/${s.id}`;
      sessions.set(s.id, s);
      return ok(s);
    }
    if (req.method === 'GET' && (m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(p))) {
      const s = sessions.get(m[1]);
      return s ? ok(s) : fail(res, 404, `No such checkout.session: '${m[1]}'`);
    }
    if (req.method === 'GET' && (m = /^\/v1\/subscriptions\/([^/]+)$/.exec(p))) {
      const s = subscriptions.get(m[1]);
      if (!s) return fail(res, 404, `No such subscription: '${m[1]}'`);
      const expanded = (form.expand ?? []).includes('default_payment_method');
      return ok({ ...s, default_payment_method: expanded ? (s.default_payment_method ?? null) : (s.default_payment_method?.id ?? null) });
    }
    if (req.method === 'GET' && (m = /^\/v1\/payment_intents\/([^/]+)$/.exec(p))) {
      const pi = intents.get(m[1]);
      if (!pi) return fail(res, 404, `No such payment_intent: '${m[1]}'`);
      return ok({ ...pi, latest_charge: (form.expand ?? []).includes('latest_charge') ? charges.get(pi.latest_charge) : pi.latest_charge });
    }
    if (req.method === 'GET' && (m = /^\/v1\/charges\/([^/]+)$/.exec(p))) {
      const ch = charges.get(m[1]);
      if (!ch) return fail(res, 404, `No such charge: '${m[1]}'`);
      return ok({ ...ch, payment_intent: (form.expand ?? []).includes('payment_intent') ? intents.get(ch.payment_intent) : ch.payment_intent });
    }
    if (req.method === 'GET' && (m = /^\/v1\/disputes\/([^/]+)$/.exec(p))) {
      const d = disputes.get(m[1]);
      return d ? ok(d) : fail(res, 404, `No such dispute: '${m[1]}'`);
    }
    if (req.method === 'POST' && (m = /^\/v1\/webhook_endpoints\/([^/]+)$/.exec(p))) {
      const ep = endpoints.get(m[1]);
      if (!ep) return fail(res, 404, `No such webhook endpoint: '${m[1]}'`);
      if (form.enabled_events) ep.enabled_events = form.enabled_events;
      return ok({ id: ep.id, object: ep.object, url: ep.url, enabled_events: ep.enabled_events });
    }
    if (req.method === 'POST' && p === '/v1/billing_portal/configurations') return ok({ id: id('bpc'), object: 'billing_portal.configuration', features: form.features });
    if (req.method === 'POST' && p === '/v1/billing_portal/sessions') {
      if (!customers.has(form.customer)) return noCustomer(res, form.customer);
      return ok({ id: id('bps'), object: 'billing_portal.session', url: `${base}/portal/${form.customer}?return=${encodeURIComponent(form.return_url ?? '')}`, return_url: form.return_url, configuration: form.configuration ?? null });
    }
    if (req.method === 'GET' && p === '/v1/webhook_endpoints') {
      return ok({ object: 'list', data: [...endpoints.values()].map((ep) => ({ id: ep.id, object: ep.object, url: ep.url, description: ep.description, enabled_events: ep.enabled_events })), has_more: false });
    }
    if (req.method === 'POST' && p === '/v1/webhook_endpoints') {
      const ep = { id: id('we'), object: 'webhook_endpoint', url: form.url, description: form.description ?? null, enabled_events: form.enabled_events ?? [], secret: `whsec_${crypto.randomBytes(16).toString('hex')}` };
      endpoints.set(ep.id, ep);
      return ok(ep);
    }
    if (req.method === 'DELETE' && (m = /^\/v1\/webhook_endpoints\/([^/]+)$/.exec(p))) {
      endpoints.delete(m[1]);
      return ok({ id: m[1], deleted: true });
    }
    fail(res, 404, `fake stripe: no route ${req.method} ${p}`);
  });

  return new Promise((resolve) =>
    server.listen(port, () => {
      base = `http://localhost:${server.address().port}`;
      resolve({ url: base, state, customers, prices, sessions, subscriptions, endpoints, accounts, transfers, intents, charges, disputes, deliveries, log, complete, renew, cancelAtPeriodEnd, end, deliver, onboard, refund, dispute, close: () => server.close() });
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = await startFakeStripe(Number(process.argv[2]) || 3119);
  console.log(`fake Stripe on ${f.url}`);
}
