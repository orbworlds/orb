// Run all engine tests: node --test --experimental-strip-types src/lib/engine/__tests__/*.test.mjs
// Plain JS on purpose: node strips the types of the imported .ts sources (explicit .ts paths,
// which the app tsconfig does not allow, so these files stay outside tsc).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolParser, parseAll, parseSuggestions } from '../protocol.ts';

/** Collapse an event list into a comparable summary. */
function digest(events) {
  const d = { say: '', sayBlocks: 0, titles: [], suggest: [], errors: [], remix: 0 };
  for (const e of events) {
    switch (e.type) {
      case 'say':
        d.say += e.delta;
        if (e.done) d.sayBlocks++;
        break;
      case 'title':
        d.titles.push(e.text);
        break;
      case 'suggest':
        d.suggest.push(e.items);
        break;
      case 'error':
        d.errors.push(e.message);
        break;
      case 'remix':
        d.remix++;
        break;
    }
  }
  return d;
}

function feed(chunks) {
  const p = new ProtocolParser();
  const events = [];
  for (const c of chunks) events.push(...p.push(c));
  events.push(...p.end());
  return events;
}

/** Deterministic PRNG so randomized tests are reproducible (seed printed on failure). */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Split text into random chunks of 1..max characters. */
function randomChunks(text, rand, max = 24) {
  const out = [];
  for (let i = 0; i < text.length; ) {
    const n = 1 + Math.floor(rand() * max);
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

/** A reply as an agent job writes it: narration, the world's name, more narration, next ideas. */
const REPLY = `<orb:say>Ooh, a floating island in the sky — let's make it!</orb:say>
<orb:title>Sky Island</orb:title>
<orb:say>Drag to look around — the clouds drift by slowly as the sun sets.</orb:say>
<orb:suggest>Make it night|Add a little waterfall|Add soft music</orb:suggest>`;

describe('ProtocolParser — realistic replies', () => {
  test('parses a full reply into the expected events', () => {
    const d = digest(parseAll(REPLY));
    assert.equal(d.say, "Ooh, a floating island in the sky — let's make it!\n\nDrag to look around — the clouds drift by slowly as the sun sets.");
    assert.equal(d.sayBlocks, 2);
    assert.deepEqual(d.titles, ['Sky Island']);
    assert.deepEqual(d.suggest, [['Make it night', 'Add a little waterfall', 'Add soft music']]);
    assert.deepEqual(d.errors, []);
  });

  test('randomized chunk splitting yields identical results (500 runs)', () => {
    const reference = digest(parseAll(REPLY));
    for (let seed = 1; seed <= 500; seed++) {
      const rand = rng(seed);
      assert.deepEqual(digest(feed(randomChunks(REPLY, rand, 1 + Math.floor(rand() * 60)))), reference, `seed ${seed}`);
    }
  });

  test('one character at a time', () => {
    assert.deepEqual(digest(feed([...REPLY])), digest(parseAll(REPLY)));
  });

  test('randomized splitting of tricky edge-case replies', () => {
    const tricky = [
      `Sure thing!\n<orb:title>'Moon Garden'</orb:title><orb:say>Planting "moon" flowers</orb:say>`,
      `<ORB:SAY>Hi <3 — a < b and b > a</ORB:SAY><orb:title>Curly > quotes</orb:title>`,
      `<orb:say>One</orb:say>\n\n<orb:plan>secret plan</orb:plan><orb:say>Two</orb:say><orb:suggest>\n- A\n- B\n- "C"\n</orb:suggest>`,
      `<orb:say>Hm, that's someone else's world.</orb:say><orb:remix/><orb:suggest>a|b|c</orb:suggest>`,
      `<orb:say>Fixing<orb:error>Overloaded &amp; tired</orb:error>`,
    ];
    for (const text of tricky) {
      const reference = digest(parseAll(text));
      for (let seed = 1; seed <= 200; seed++) {
        const rand = rng(seed * 7919);
        assert.deepEqual(digest(feed(randomChunks(text, rand, 8))), reference, `seed ${seed}: ${text.slice(0, 40)}`);
      }
    }
  });
});

describe('ProtocolParser — streaming behaviour', () => {
  test('narration streams progressively before the block closes', () => {
    const p = new ProtocolParser();
    assert.deepEqual(p.push('<orb:say>Hello wor'), [{ type: 'say', delta: 'Hello wor', done: false }]);
    assert.deepEqual(p.push('ld, friend'), [{ type: 'say', delta: 'ld, friend', done: false }]);
    assert.deepEqual(p.push('!   </orb:sa'), [{ type: 'say', delta: '!', done: false }]);
    assert.deepEqual(p.push('y>'), [{ type: 'say', delta: '', done: true }]);
  });

  test('whitespace at a chunk boundary inside narration is preserved, outer whitespace trimmed', () => {
    const d = digest(feed(['<orb:say>\n  Hello ', ' there ', '\n</orb:say>']));
    assert.equal(d.say, 'Hello  there');
  });

  test('push after end() is ignored and end() is idempotent', () => {
    const p = new ProtocolParser();
    p.push('<orb:say>Hi</orb:say>');
    assert.ok(p.end().length === 0);
    assert.deepEqual(p.end(), []);
    assert.deepEqual(p.push('<orb:say>more</orb:say>'), []);
  });
});

describe('ProtocolParser — forgiving parsing', () => {
  test('stray text is narration only when no <orb:say> is used', () => {
    assert.equal(digest(parseAll('Just a plain answer.\nSecond line.')).say, 'Just a plain answer.\nSecond line.');
    assert.equal(digest(parseAll('<orb:say>Real</orb:say> ignored text <orb:suggest>a|b</orb:suggest>')).say, 'Real');
    // code-looking stray text is never narrated
    assert.equal(digest(parseAll('Here you go:\n```html\n<!DOCTYPE html><html></html>\n```')).say, 'Here you go:');
  });

  test('stray narration before the first tag closes cleanly', () => {
    const d = digest(parseAll('Okay!\n<orb:title>Moon</orb:title>Then more words.'));
    assert.equal(d.say, 'Okay!\n\nThen more words.');
    assert.deepEqual(d.titles, ['Moon']);
  });

  test('a forgotten </orb:say> is closed by the next block', () => {
    const d = digest(parseAll('<orb:say>Hello<orb:title>T</orb:title>'));
    assert.equal(d.say, 'Hello');
    assert.deepEqual(d.titles, ['T']);
  });

  test('an unterminated block is closed at the end of the stream', () => {
    const d = digest(parseAll('<orb:say>Almost</orb:say><orb:suggest>a|b</orb:sugg'));
    assert.equal(d.say, 'Almost');
    assert.deepEqual(d.suggest, [['a', 'b']]);
  });

  test('title and suggestion cleanup', () => {
    assert.deepEqual(digest(parseAll('<orb:title> "**Cloud Castle**". </orb:title>')).titles, ['Cloud Castle']);
    assert.deepEqual(parseSuggestions('- Make it night\n2. Add a dragon | "Add music" | add music | '), ['Make it night', 'Add a dragon', 'Add music']);
    assert.deepEqual(parseSuggestions('a|b|c|d|e'), ['a', 'b', 'c', 'd']);
  });

  test('error and remix extensions', () => {
    const d = digest(parseAll('<orb:say>Hm</orb:say><orb:remix/><orb:error>Overloaded &amp; tired</orb:error>'));
    assert.equal(d.remix, 1);
    assert.deepEqual(d.errors, ['Overloaded & tired']);
    assert.deepEqual(digest(parseAll('<orb:error></orb:error>')).errors, ['The AI stopped unexpectedly.']);
  });

  test('a remix with content counts once and its content is skipped', () => {
    const d = digest(parseAll('<orb:remix>make it red</orb:remix><orb:say>Hi</orb:say>'));
    assert.equal(d.remix, 1);
    assert.equal(d.say, 'Hi');
  });

  test('unknown blocks and stray closing tags are ignored', () => {
    const d = digest(parseAll('</orb:edit><orb:thinking>plan: <b>x</b></orb:thinking><orb:say>Hi</orb:say>'));
    assert.equal(d.say, 'Hi');
    // blocks of the old single-file protocol are unknown blocks now
    assert.equal(digest(parseAll('<orb:write label="w"><html></html></orb:write><orb:say>Done</orb:say>')).say, 'Done');
  });

  test('non-tags that look similar are plain text', () => {
    const d = digest(parseAll('<orb:say>Use <orbit> and <or> and <orb:sayhi> here</orb:say>'));
    assert.equal(d.say, 'Use <orbit> and <or> and <orb:sayhi> here');
  });

  test('every possible two-way split of a mixed reply is equivalent', () => {
    const text = '<orb:say>Hi!</orb:say>\n<orb:title>T</orb:title>\n<orb:remix/>\n<orb:say>  More  </orb:say>\n<orb:suggest>x|y|z</orb:suggest>';
    const ref = digest(parseAll(text));
    for (let i = 1; i < text.length; i++) assert.deepEqual(digest(feed([text.slice(0, i), text.slice(i)])), ref, `split at ${i}`);
  });
});
