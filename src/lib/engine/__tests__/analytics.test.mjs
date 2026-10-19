// The analytics tracker (src/lib/analytics.ts): the first page view says where the visitor came
// from and an address counts once; events wait a few seconds and go together (50 at most, ~30 KB);
// props stay flat and small; events carry the world on screen unless they name one; a hidden tab
// sends at once by beacon (device key in the body) after the leave hooks ran; a tab's visit lasts
// until it's been 30 minutes out of sight, across reloads; nothing is tracked on /lab and /dev; and
// nothing it does can throw.
import './setup.mjs';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.UTC(2026, 9, 9, 12) });

class Memory {
  #m = new Map();
  getItem(k) {
    return this.#m.has(k) ? this.#m.get(k) : null;
  }
  setItem(k, v) {
    this.#m.set(k, String(v));
  }
}
const win = new EventTarget();
globalThis.addEventListener = win.addEventListener.bind(win);
globalThis.dispatchEvent = win.dispatchEvent.bind(win);
const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', referrer: '' });
globalThis.document = doc;
globalThis.location = { pathname: '/', search: '', origin: 'https://orb.test' };
globalThis.sessionStorage = new Memory();

const sent = [];
const beacons = [];
let beaconTakes = true;
globalThis.fetch = (url, init) => {
  sent.push({ url, init, body: JSON.parse(init.body) });
  return Promise.resolve(new Response('{"accepted":0}'));
};
navigator.sendBeacon = (url, blob) => {
  beacons.push({ url, blob });
  return beaconTakes;
};

const { flush, onLeave, sameView, setWorldContext, track, trackPageView } = await import('../../analytics.ts');

const events = () => sent.flatMap((s) => s.body.events);
const take = () => {
  flush();
  const out = events();
  sent.length = 0;
  return out;
};
const go = (pathname, search = '') => Object.assign(location, { pathname, search });

test('the first page view says where the visitor came from; an address counts once', () => {
  go('/', '?utm_source=hn&utm_medium=social&utm_campaign=&q=secret');
  doc.referrer = 'https://news.ycombinator.com/item?id=42';
  trackPageView();
  trackPageView();
  go('/explore');
  trackPageView();
  go('/w/abc');
  sameView();
  trackPageView();
  go('/explore');
  dispatchEvent(new Event('popstate'));
  const views = take();
  assert.deepEqual(
    views.map((e) => [e.name, e.path, e.props, e.ref]),
    [
      ['page_view', '/', { landing: true, utm_source: 'hn', utm_medium: 'social' }, 'https://news.ycombinator.com/item'],
      ['page_view', '/explore', undefined, undefined],
      ['page_view', '/explore', undefined, undefined],
    ],
  );
  doc.referrer = '';
});

test('events wait a few seconds, then go together with the device key and the tab’s visit', () => {
  track('like', { liked: true });
  track('share_open');
  mock.timers.tick(3999);
  assert.equal(sent.length, 0);
  mock.timers.tick(1);
  assert.equal(sent.length, 1);
  const [{ url, init, body }] = sent;
  assert.equal(url, '/api/events');
  assert.equal(init.headers['x-orb-device'], localStorage.getItem('orb:device'));
  assert.equal(init.keepalive, true);
  assert.equal(body.sent, Date.now());
  assert.equal(body.mobile, false);
  assert.deepEqual(
    body.events.map((e) => [e.name, e.t, e.path, e.props]),
    [
      ['like', Date.now() - 4000, '/explore', { liked: true }],
      ['share_open', Date.now() - 4000, '/explore', undefined],
    ],
  );
  assert.match(body.events[0].session, /^[a-z0-9]{12,}$/);
  assert.equal(body.events[1].session, body.events[0].session);
  sent.length = 0;
});

test('props stay flat and small; bad names are dropped', () => {
  track('test_props', { a: 'x'.repeat(400), b: undefined, c: Infinity, 'Bad-Key': 1, d: { nested: 1 }, e: null, f: false, g: 2 });
  track('test_big', Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, 'y'.repeat(300)])));
  track('Bad-Name');
  track('x');
  const got = take();
  assert.deepEqual(
    got.map((e) => [e.name, e.props]),
    [
      ['test_props', { a: 'x'.repeat(300), c: null, e: null, f: false, g: 2 }],
      ['test_big', undefined],
    ],
  );
});

test('events carry the world on screen, unless they name one; page views carry none', () => {
  setWorldContext(() => 'onscreen1');
  track('like');
  track('remix', { world_id: 'copy1', from_world: 'onscreen1' });
  track('build_done', { world_id: null, status: 'done' });
  go('/w/onscreen1');
  trackPageView();
  const got = take();
  assert.deepEqual(
    got.map((e) => [e.name, e.world, e.props]),
    [
      ['like', 'onscreen1', undefined],
      ['remix', 'copy1', { from_world: 'onscreen1' }],
      ['build_done', undefined, { status: 'done' }],
      ['page_view', undefined, undefined],
    ],
  );
  setWorldContext(() => null);
});

test('50 events go at once; batches stay under ~30 KB', () => {
  for (let i = 0; i < 120; i++) track('test_many', { i });
  assert.deepEqual(
    sent.map((s) => s.body.events.length),
    [50, 50],
  );
  mock.timers.tick(4000);
  assert.deepEqual(
    sent.map((s) => s.body.events.length),
    [50, 50, 20],
  );
  sent.length = 0;
  for (let i = 0; i < 30; i++) track('test_wide', { a: 'z'.repeat(300), b: 'z'.repeat(300), c: 'z'.repeat(300), d: 'z'.repeat(300), e: 'z'.repeat(300), f: 'z'.repeat(300) });
  flush();
  assert.ok(sent.length >= 2, `${sent.length} batches`);
  assert.ok(
    sent.every((s) => JSON.stringify(s.body.events).length < 32_000),
    'each batch fits a keepalive request',
  );
  assert.equal(events().length, 30);
  sent.length = 0;
});

test('a hidden tab runs the leave hooks, then sends at once by beacon (the device in the body)', async () => {
  const off = onLeave(() => track('world_leave', { seconds: 5, why: 'hidden' }));
  track('code_open');
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  off();
  assert.equal(sent.length, 0);
  assert.equal(beacons.length, 1);
  assert.equal(beacons[0].url, '/api/events');
  assert.equal(beacons[0].blob.type, 'application/json');
  const body = JSON.parse(await beacons[0].blob.text());
  assert.equal(body.device, localStorage.getItem('orb:device'));
  assert.deepEqual(
    body.events.map((e) => e.name),
    ['code_open', 'world_leave'],
  );
  beaconTakes = false;
  track('explore_open');
  dispatchEvent(new Event('pagehide'));
  assert.equal(beacons.length, 2);
  assert.equal(sent.length, 1, 'a refused beacon falls back to fetch');
  assert.equal(sent[0].init.headers['x-orb-device'], localStorage.getItem('orb:device'));
  sent.length = 0;
  beaconTakes = true;
  doc.visibilityState = 'visible';
});

test('a visit lasts until the tab has been out of sight for 30 minutes', () => {
  track('a_visit');
  const [first] = take();
  doc.visibilityState = 'hidden';
  mock.timers.tick(29 * 60_000);
  track('a_visit');
  assert.equal(take()[0].session, first.session, '29 minutes away: the same visit');
  mock.timers.tick(31 * 60_000);
  track('a_visit');
  const [later] = take();
  assert.notEqual(later.session, first.session, '31 minutes away: a new visit');
  assert.equal(JSON.parse(sessionStorage.getItem('orb:visit')).id, later.session);
  doc.visibilityState = 'visible';
  mock.timers.tick(45 * 60_000);
  track('a_visit');
  assert.equal(take()[0].session, later.session, 'a tab in view stays one visit');
});

test('nothing is tracked on the secret pages', () => {
  for (const p of ['/lab/key/analytics', '/dev/sandbox', '/lab']) {
    go(p);
    track('like');
    trackPageView();
  }
  mock.timers.tick(5000);
  flush();
  assert.equal(sent.length, 0);
  go('/');
});

test('nothing throws: no network, no sessionStorage', () => {
  globalThis.fetch = () => {
    throw new Error('offline');
  };
  sessionStorage.getItem = () => {
    throw new Error('blocked');
  };
  assert.doesNotThrow(() => {
    track('like');
    mock.timers.tick(4000);
    track('share_open');
    flush();
  });
});

test('a reload keeps the visit', async () => {
  globalThis.sessionStorage = new Memory();
  globalThis.fetch = (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    return Promise.resolve(new Response('{"accepted":0}'));
  };
  track('before_reload');
  const [before] = take();
  const reloaded = await import('../../analytics.ts?reload');
  mock.timers.tick(60_000);
  reloaded.track('after_reload');
  reloaded.flush();
  const [after] = events();
  assert.equal(after.name, 'after_reload');
  assert.equal(after.session, before.session);
});
