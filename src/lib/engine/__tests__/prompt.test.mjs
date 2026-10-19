// Run all engine tests: node --test --experimental-strip-types src/lib/engine/__tests__/*.test.mjs
// Plain JS on purpose: node strips the types of the imported .ts sources (explicit .ts paths,
// which the app tsconfig does not allow, so these files stay outside tsc).
import './setup.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateBuildRequest, normalizeHistory, imagePart, BUILD_LIMITS } from '../prompt.ts';

const { agentSystemPrompt, cursorOrbPrompt } = await import('../../../server/agent/prompt.ts');

const req = (over = {}) => ({ worldId: 'w1', messages: [{ role: 'user', content: 'make it night' }], mode: 'build', worldName: 'Cloud Castle', ...over });
const opts = (over = {}) => ({ worldName: 'Cloud Castle', history: [], request: 'make it night', ...over });

describe('the agents’ system prompts', () => {
  test('carry Orb’s voice, direction, craft guide and SDK, for a world made of files', () => {
    const prompts = { agent: agentSystemPrompt('build'), cursor: cursorOrbPrompt({ ...opts(), mode: 'build' }) };
    for (const [name, p] of Object.entries(prompts)) {
      for (const s of ['# How you talk', '# Get the direction right first', '# Craft: wow within one second', '# The Orb platform (window.orb)', "Orb's starter templates"]) assert.ok(p.includes(s), `${name}: ${s}`);
      assert.match(p, /Keep going like this/, `${name}: a big new world stops at a first look`);
      assert.match(p, /restyle all of it/, `${name}: a named style replaces the island's look`);
      assert.doesNotMatch(p, /# Kind and safe|child|kids|five-year/i, `${name}: no safety rules or audience of its own`);
      assert.ok(p.length < 9000, `${name}: short (${p.length} characters)`);
      for (const s of ['three@0.186.1', 'cdn.jsdelivr.net', 'importmap', 'SRGBColorSpace', 'ACESFilmicToneMapping', 'PCFShadowMap', 'THREE.Timer', 'Fog', 'InstancedMesh']) assert.ok(p.includes(s), `${name}: ${s}`);
      for (const s of ['const orb = window.orb', 'orb?.store.get', 'orb?.store.incr', 'orb?.store.push', 'orb?.room.join', 'room.setState', 'orb?.visitors.show', 'orb?.shop.buy', 'orb?.capture()', 'orb?.toast', 'orb?.me', 'localStorage']) assert.ok(p.includes(s), `${name}: ${s}`);
      assert.ok(p.includes('The world is a small web project'), `${name}: the multi-file format`);
      assert.ok(!/<orb:(write|edit|find)/.test(p), `${name}: nothing of the single-file protocol`);
    }
    assert.match(prompts.agent, /write_file/);
    assert.match(prompts.cursor, /sh \.orb\/save/);
  });

  test('guides answer in place and offer a copy for changes', () => {
    const agent = agentSystemPrompt('ask');
    assert.match(agent, /# Mode: guide/);
    assert.match(agent, /offer_remix/);
    assert.doesNotMatch(agent, /# How you work/);
    assert.doesNotMatch(agent, /# Craft|# Get the direction/, 'a guide changes nothing: no craft guide');
    const cursor = cursorOrbPrompt({ ...opts(), mode: 'ask' });
    assert.match(cursor, /# Mode: guide/);
    assert.match(cursor, /Own copy: yes/);
  });

  test('a Cursor prompt carries the chat, the errors to fix and the request', () => {
    const p = cursorOrbPrompt({ ...opts({ worldName: 'Untitled world', history: [{ role: 'user', content: 'a castle' }, { role: 'assistant', content: 'Built it!' }], errors: ['TypeError: x'] }), mode: 'build' });
    assert.match(p, /# Earlier in this chat\n\nPerson: a castle\n\nYou: Built it!/);
    assert.match(p, /<errors>\n1\. TypeError: x\n<\/errors>/);
    assert.match(p, /# The request\nmake it night$/);
    assert.match(p, /It has no name yet/);
  });
});

describe('normalizeHistory', () => {
  test('makes strictly alternating turns starting with the user', () => {
    assert.deepEqual(
      normalizeHistory([
        { role: 'assistant', content: 'orphan reply' },
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second (first failed)' },
        { role: 'assistant', content: 'done' },
        { role: 'assistant', content: 'more' },
        { role: 'user', content: '   ' },
      ]).map((m) => [m.role, m.content]),
      [
        ['user', 'first'],
        ['assistant', '(no reply — that build did not finish)'],
        ['user', 'second (first failed)'],
        ['assistant', 'done\n\nmore'],
      ],
    );
  });

  test('a trailing unanswered user turn gets a placeholder reply', () => {
    assert.deepEqual(normalizeHistory([{ role: 'user', content: 'a' }]).map((m) => m.role), ['user', 'assistant']);
  });
});

describe('imagePart', () => {
  test('turns a data URL into a file part', () => {
    assert.deepEqual(imagePart('data:image/webp;base64,UklG\nRg=='), { type: 'file', mediaType: 'image/webp', data: 'UklGRg==' });
    assert.equal(imagePart('http://example.com/x.png'), null);
  });
});

describe('validateBuildRequest', () => {
  test('accepts and normalizes a valid request', () => {
    const r = validateBuildRequest({ ...req(), errors: ['x'.repeat(5000)], worldId: 'w'.repeat(100), extra: 1, code: '<html></html>' });
    assert.equal(r.ok, true);
    assert.equal(r.req.errors[0].length, BUILD_LIMITS.errorChars);
    assert.equal(r.req.worldId.length, BUILD_LIMITS.worldId);
    assert.equal(r.req.image, null);
    assert.equal('extra' in r.req, false);
    assert.equal('code' in r.req, false, "the world's code isn't part of a build request");
    assert.equal(validateBuildRequest({ ...req(), mode: undefined }).req.mode, 'build');
  });

  test('rejects bad input with a readable message', () => {
    const bad = [
      null,
      'str',
      { ...req(), messages: [] },
      { ...req(), messages: Array.from({ length: 31 }, () => ({ role: 'user', content: 'x' })) },
      { ...req(), messages: [{ role: 'user', content: 'x'.repeat(BUILD_LIMITS.messageChars + 1) }] },
      { ...req(), messages: [{ role: 'system', content: 'x' }] },
      { ...req(), messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] },
      { ...req(), image: 'http://example.com/x.png' },
      { ...req(), image: 'data:image/png;base64,' + 'A'.repeat(BUILD_LIMITS.image) },
      { ...req(), errors: [1] },
      { ...req(), mode: 'edit' },
      { ...req(), worldName: 7 },
      { ...req(), worldId: 7 },
    ];
    for (const b of bad) {
      const r = validateBuildRequest(b);
      assert.equal(r.ok, false, JSON.stringify(b)?.slice(0, 80));
      assert.ok(r.message.length > 5);
    }
  });
});
