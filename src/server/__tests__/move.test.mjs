// Moving to a new domain, the pure parts: Orb's addresses and passkey relying party
// (src/server/origins.ts), the redirects on former addresses (next.config.ts) and the hand-off's
// data rules (src/lib/move.ts). scripts/test-move.mjs runs these, then the whole journey.
//
//   node --test --experimental-strip-types src/server/__tests__/move.test.mjs
import { register } from 'node:module';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

register('../../lib/engine/__tests__/resolve-hooks.mjs', import.meta.url);

const { originsConfig, relyingParty, relatedOrigins, originForHost } = await import('../origins.ts');
const { safeTo, mergeEntries, dropOrder, pack, unpack, packWithin } = await import('../../lib/move.ts');
const { default: nextConfig } = await import('../../../next.config.ts');

const MOVED = { NEXT_PUBLIC_SITE_URL: 'https://orb.example/', ORB_FORMER_ORIGINS: 'https://orbworld.vercel.app' };
const DEV = { NEXT_PUBLIC_SITE_URL: 'http://new.localhost:3333', ORB_FORMER_ORIGINS: 'http://localhost:3333', ORB_PASSKEY_RP_ID: 'localhost' };

const req = (url, headers = {}) => new Request(url, { headers });

describe('originsConfig', () => {
  test('before any move: one address, the RP ID’s own', () => {
    const one = 'https://orbworld.vercel.app';
    assert.deepEqual(originsConfig({}), { site: one, former: [], extra: [], rpId: 'orbworld.vercel.app', home: one, allowed: [one], targets: [one] });
  });

  test('after a move the RP ID stays, and the old address is its home', () => {
    assert.deepEqual(originsConfig(MOVED), {
      site: 'https://orb.example',
      former: ['https://orbworld.vercel.app'],
      extra: [],
      rpId: 'orbworld.vercel.app',
      home: 'https://orbworld.vercel.app',
      allowed: ['https://orb.example', 'https://orbworld.vercel.app'],
      targets: ['https://orb.example'],
    });
  });

  test('lists take commas or spaces; paths, junk, duplicates and the site’s own hostname are dropped', () => {
    const o = originsConfig({ ...MOVED, ORB_FORMER_ORIGINS: ' https://a.example/x?y=1, ftp://b.example  https://a.example nonsense https://orb.example http://orb.example,,' });
    assert.deepEqual(o.former, ['https://a.example']);
  });

  test('ORB_ORIGINS: more addresses people can stay on', () => {
    const o = originsConfig({ ...MOVED, ORB_ORIGINS: 'https://www.orb.example https://orbworld.vercel.app' });
    assert.deepEqual(o.extra, ['https://www.orb.example']);
    assert.deepEqual(o.targets, ['https://orb.example', 'https://www.orb.example']);
    assert.ok(o.allowed.includes('https://www.orb.example'));
  });

  test('ORB_PASSKEY_RP_ID is normalised; with no address of its own its home is https://<RP ID>', () => {
    const o = originsConfig({ NEXT_PUBLIC_SITE_URL: 'https://www.orb.example', ORB_PASSKEY_RP_ID: ' Orb.Example. ' });
    assert.equal(o.rpId, 'orb.example');
    assert.equal(o.home, 'https://orb.example');
    assert.deepEqual(o.allowed, ['https://www.orb.example', 'https://orb.example']);
  });
});

describe('relyingParty', () => {
  test('on the new address: Orb’s RP ID, this origin, and the passkey home as fallback', () => {
    assert.deepEqual(relyingParty(req('https://orb.example/api/auth/passkey/login/options'), originsConfig(MOVED)), {
      rpID: 'orbworld.vercel.app',
      origin: 'https://orb.example',
      home: 'https://orbworld.vercel.app',
    });
  });

  test('on the RP ID’s own host (and before any move) nothing changes', () => {
    for (const o of [originsConfig({}), originsConfig(MOVED)]) {
      assert.deepEqual(relyingParty(req('https://orbworld.vercel.app/x'), o), { rpID: 'orbworld.vercel.app', origin: 'https://orbworld.vercel.app', home: null });
    }
  });

  test('other hosts (localhost, previews) keep their own hostname', () => {
    const o = originsConfig(MOVED);
    assert.deepEqual(relyingParty(req('http://localhost:3000/x'), o), { rpID: 'localhost', origin: 'http://localhost:3000', home: null });
    assert.deepEqual(relyingParty(req('https://orb-git-x-me.vercel.app/x'), o), { rpID: 'orb-git-x-me.vercel.app', origin: 'https://orb-git-x-me.vercel.app', home: null });
  });

  test('honours the proxy’s forwarded host and protocol', () => {
    const r = req('http://127.0.0.1:3000/x', { 'x-forwarded-host': 'orb.example, proxy.internal', 'x-forwarded-proto': 'https' });
    assert.equal(relyingParty(r, originsConfig(MOVED)).origin, 'https://orb.example');
  });

  test('a subdomain uses its parent RP ID natively, but not a single label like localhost', () => {
    const sub = originsConfig({ NEXT_PUBLIC_SITE_URL: 'https://app.orb.example', ORB_PASSKEY_RP_ID: 'orb.example' });
    assert.equal(relyingParty(req('https://app.orb.example/x'), sub).home, null);
    assert.deepEqual(relyingParty(req('http://new.localhost:3333/x'), originsConfig(DEV)), { rpID: 'localhost', origin: 'http://new.localhost:3333', home: 'http://localhost:3333' });
  });
});

describe('relatedOrigins (/.well-known/webauthn)', () => {
  test('lists every address allowed to use Orb’s passkeys', () => {
    assert.deepEqual(relatedOrigins(originsConfig({})), { origins: ['https://orbworld.vercel.app'] });
    assert.deepEqual(relatedOrigins(originsConfig({ ...MOVED, ORB_ORIGINS: 'https://www.orb.example' })), {
      origins: ['https://orb.example', 'https://orbworld.vercel.app', 'https://www.orb.example'],
    });
  });
});

test('originForHost matches host and port, ignoring case', () => {
  const list = ['https://orbworld.vercel.app', 'http://localhost:3333'];
  assert.equal(originForHost(list, 'OrbWorld.vercel.app'), 'https://orbworld.vercel.app');
  assert.equal(originForHost(list, 'localhost:3333'), 'http://localhost:3333');
  assert.equal(originForHost(list, 'localhost'), null);
  assert.equal(originForHost(list, ''), null);
});

describe('next.config.ts redirects', () => {
  async function redirects(env) {
    const keys = ['NEXT_PUBLIC_SITE_URL', 'ORB_FORMER_ORIGINS'];
    const saved = keys.map((k) => process.env[k]);
    for (const k of keys) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    try {
      // The move's rules (by host); the replaced worlds' fixed redirects are another matter.
      return (await nextConfig.redirects()).filter((r) => r.has);
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  }

  test('none until ORB_FORMER_ORIGINS is set', async () => {
    assert.deepEqual(await redirects({}), []);
    assert.deepEqual(await redirects({ NEXT_PUBLIC_SITE_URL: 'https://orb.example' }), []);
  });

  test('a former address: page visits go through the hand-off unless moved, everything else 308s', async () => {
    const rules = await redirects(MOVED);
    const host = { type: 'host', value: 'orbworld\\.vercel\\.app' };
    const visit = [host, { type: 'header', key: 'sec-fetch-dest', value: 'document' }];
    const missing = [{ type: 'cookie', key: 'orb_moved' }];
    const start = 'https://orb.example/api/move/start/orbworld.vercel.app';
    assert.deepEqual(
      rules.map(({ source, ...r }) => ({ root: source === '/', ...r })),
      [
        { root: true, has: visit, missing, destination: start, permanent: false },
        { root: false, has: visit, missing, destination: `${start}/:path`, permanent: false },
        { root: true, has: [host], destination: 'https://orb.example/', permanent: true },
        { root: false, has: [host], destination: 'https://orb.example/:path', permanent: true },
      ],
    );
  });

  test('the API, Next’s files, /.well-known, /dev, files and /move itself stay put', async () => {
    const [, { source }] = await redirects(MOVED);
    const page = new RegExp(`^(?:${source.slice('/:path('.length, -1)})$`);
    for (const p of ['w/abc', '@alice/castle', 'explore', 'moved', 'apis', 'devices', 'w/a.b/c']) assert.ok(page.test(p), p);
    for (const p of ['api', 'api/me', '_next/static/x.js', '_vercel/insights/script.js', '.well-known/webauthn', 'dev/passkey', 'move', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'w/abc.json']) {
      assert.ok(!page.test(p), p);
    }
  });

  test('a port goes along in the start path; the site’s own hostname never redirects', async () => {
    assert.equal((await redirects(DEV))[0].destination, 'http://new.localhost:3333/api/move/start/localhost%3A3333');
    assert.deepEqual(await redirects({ NEXT_PUBLIC_SITE_URL: 'https://orb.example', ORB_FORMER_ORIGINS: 'http://orb.example https://orb.example' }), []);
  });
});

describe('safeTo', () => {
  test('keeps paths on this site, with their query', () => {
    for (const p of ['/', '/w/abc?x=1&y=%20z', '/@alice/castle', '/%2F%2Fevil.example']) assert.equal(safeTo(p), p);
    assert.equal(safeTo('/w/abc#top'), '/w/abc');
  });

  test('anything else lands on "/"', () => {
    const bad = ['https://evil.example/x', '//evil.example', '/\\evil.example', '/\t/evil.example', '/..//evil.example', '/./%2e//evil.example/x', '/a/../..//evil.example', 'javascript:alert(1)', 'w/abc', '', null, undefined, 42, {}, `/${'x'.repeat(2001)}`];
    for (const p of bad) assert.equal(safeTo(p), '/', JSON.stringify(p));
  });
});

const thread = (id, updatedAt, extra = {}) => ({ id, worldId: 'w1', title: id, updatedAt, ...extra });
const chats = (...list) => JSON.stringify(list);

describe('mergeEntries', () => {
  test('what this browser lacks comes along; what it has stays its own', () => {
    const { set, remove } = mergeEntries(
      { 'orb:model': 'local-model', 'orb:pos': '{"side":"left"}' },
      { 'orb:model': 'carried-model', 'orb:github': '{"token":"t"}', 'orb:ls:w1': '{"best":"12"}', 'orb:device': 'D'.repeat(43) },
    );
    assert.deepEqual(set, { 'orb:github': '{"token":"t"}', 'orb:ls:w1': '{"best":"12"}', 'orb:device': 'D'.repeat(43) });
    assert.deepEqual(remove, []);
  });

  test('a different carried device key wins, and brings its name and colour', () => {
    const local = { 'orb:device': 'L'.repeat(43), 'orb:name': 'Misty Otter', 'orb:color': '#8b7bff', 'orb:model': 'm1' };
    const carried = { 'orb:device': 'C'.repeat(43), 'orb:name': 'Sunny Fox', 'orb:color': '#ffd36e', 'orb:model': 'm2' };
    assert.deepEqual(mergeEntries(local, carried).set, { 'orb:device': 'C'.repeat(43), 'orb:name': 'Sunny Fox', 'orb:color': '#ffd36e' });
    // Same key: names stay this browser's.
    assert.deepEqual(mergeEntries({ ...local, 'orb:device': 'C'.repeat(43) }, carried).set, {});
  });

  test('chats merge by id, the newer thread winning with its messages', () => {
    const local = {
      'orb:chats': chats(thread('a', 10), thread('b', 50)),
      'orb:chat:a': '["local a"]',
      'orb:chat:b': '["local b"]',
    };
    const carried = {
      'orb:chats': chats(thread('a', 20), thread('b', 40), thread('c', 30)),
      'orb:chat:a': '["carried a"]',
      'orb:chat:b': '["carried b"]',
      'orb:chat:c': '["carried c"]',
    };
    const { set, remove } = mergeEntries(local, carried);
    assert.deepEqual(JSON.parse(set['orb:chats']), [thread('b', 50), thread('c', 30), thread('a', 20)]);
    assert.equal(set['orb:chat:a'], '["carried a"]');
    assert.equal(set['orb:chat:b'], undefined);
    assert.equal(set['orb:chat:c'], '["carried c"]');
    assert.deepEqual(remove, []);
  });

  test('keeps the 200 newest chats, removing the messages of the rest', () => {
    const local = { 'orb:chats': chats(thread('old', 1)), 'orb:chat:old': '[]' };
    const many = Array.from({ length: 200 }, (_, i) => thread(`n${i}`, 100 + i));
    const { set, remove } = mergeEntries(local, { 'orb:chats': chats(...many) });
    assert.equal(JSON.parse(set['orb:chats']).length, 200);
    assert.ok(!set['orb:chats'].includes('"old"'));
    assert.deepEqual(remove, ['orb:chat:old']);
  });

  test('id → value maps are combined, this browser winning a clash', () => {
    const { set } = mergeEntries({ 'orb:world-names': '{"w1":"Mine","w2":"Two"}' }, { 'orb:world-names': '{"w1":"Theirs","w3":"Three"}' });
    assert.deepEqual(JSON.parse(set['orb:world-names']), { w1: 'Mine', w2: 'Two', w3: 'Three' });
  });

  test('malformed carried chat lists are ignored', () => {
    const local = { 'orb:chats': chats(thread('a', 1)) };
    assert.deepEqual(mergeEntries(local, { 'orb:chats': 'not json' }).set, {});
    assert.deepEqual(mergeEntries(local, { 'orb:chats': '{"a":1}' }).set, {});
  });
});

describe('packing', () => {
  test('pack → unpack round trip (gzip), keeping only orb: strings', async () => {
    const entries = { 'orb:device': 'x'.repeat(43), 'orb:chat:a': '["héllo 🌍"]' };
    const packed = await pack(entries);
    assert.equal(packed.pack, 'gzip');
    assert.deepEqual(await unpack(packed.body.buffer, 'gzip'), entries);
    const json = new TextEncoder().encode(JSON.stringify({ ...entries, other: 'x', 'orb:n': 5 }));
    assert.deepEqual(await unpack(json.buffer, 'json'), entries);
  });

  test('drop order: chats’ messages, then worlds’ saved games, then the rest — never the device key or chat list', () => {
    const entries = { 'orb:device': 'd', 'orb:chats': '[]', 'orb:model': 'mm', 'orb:ls:w1': 'x'.repeat(10), 'orb:ls:w2': 'x'.repeat(50), 'orb:chat:a': 'x', 'orb:chat:b': 'x'.repeat(30) };
    assert.deepEqual(dropOrder(entries), ['orb:chat:b', 'orb:chat:a', 'orb:ls:w2', 'orb:ls:w1', 'orb:model']);
  });

  test('a bundle that fits is untouched', async () => {
    const { dropped } = await packWithin({ 'orb:device': 'd'.repeat(43), 'orb:chats': '[]' }, 10_000);
    assert.deepEqual(dropped, []);
  });

  test('too big: the bulkiest go first, and dropped chats leave the chat list', async () => {
    const noise = (n) => Array.from({ length: n }, (_, i) => ((i * 2654435761) >>> 0).toString(36)).join('');
    const entries = {
      'orb:device': 'd'.repeat(43),
      'orb:chats': chats(thread('big', 2), thread('small', 1)),
      'orb:chat:big': JSON.stringify([noise(6000)]),
      'orb:chat:small': '["hi"]',
      'orb:ls:w1': JSON.stringify({ save: noise(3000) }),
      'orb:model': 'm',
    };
    const max = (await pack({ ...entries, 'orb:chat:big': '[]' })).body.byteLength + 200;
    const { body, pack: format, dropped } = await packWithin(entries, max);
    assert.ok(body.byteLength <= max, `${body.byteLength} > ${max}`);
    assert.deepEqual(dropped, ['orb:chat:big']);
    const kept = await unpack(body.buffer, format);
    assert.deepEqual(JSON.parse(kept['orb:chats']), [thread('small', 1)]);
    assert.equal(kept['orb:chat:small'], '["hi"]');
    assert.ok(kept['orb:ls:w1'] && kept['orb:device']);
  });
});
