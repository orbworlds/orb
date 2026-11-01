// Run all engine tests: node --test --experimental-strip-types src/lib/engine/__tests__/*.test.mjs
// Three-way merge of text, line by line (src/server/merge.ts): builds of a world made together.
import './setup.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { merge3 } = await import('../../../server/merge.ts');

const text = (...lines) => lines.map((l) => `${l}\n`).join('');

describe('merge3', () => {
  test('changes in different places are both kept', () => {
    const base = text('a', 'b', 'c', 'd', 'e');
    const r = merge3(base, text('a', 'B', 'c', 'd', 'e'), text('a', 'b', 'c', 'd', 'E'));
    assert.deepEqual(r, { text: text('a', 'B', 'c', 'd', 'E'), conflicts: 0 });
  });

  test('one side unchanged: the other side’s text', () => {
    const base = text('a', 'b');
    assert.equal(merge3(base, base, text('a', 'x')).text, text('a', 'x'));
    assert.equal(merge3(base, text('y', 'b'), base).text, text('y', 'b'));
    assert.equal(merge3(base, text('z'), text('z')).text, text('z'));
  });

  test('the same lines changed on both sides: ours wins, and it says so', () => {
    const r = merge3(text('sky = blue', 'x'), text('sky = pink', 'x'), text('sky = green', 'x'));
    assert.deepEqual(r, { text: text('sky = pink', 'x'), conflicts: 1 });
  });

  test('both sides adding at the same place keep both (theirs first)', () => {
    const base = text('<body>', '</body>');
    const r = merge3(base, text('<body>', '<p>mine</p>', '</body>'), text('<body>', '<p>theirs</p>', '</body>'));
    assert.deepEqual(r, { text: text('<body>', '<p>theirs</p>', '<p>mine</p>', '</body>'), conflicts: 0 });
    // …at the end too
    assert.equal(merge3(text('a'), text('a', 'm'), text('a', 't')).text, text('a', 't', 'm'));
  });

  test('a whole file written again from an older copy only brings its own changes', () => {
    // The world moved on (a line on top) while a build rewrote the file it had read (a line at the end).
    const base = text('import x', 'one', 'two', 'three');
    const theirs = text('// by Ana', 'import x', 'one', 'two', 'three');
    const ours = text('import x', 'one', 'two', 'three', 'four');
    assert.equal(merge3(base, ours, theirs).text, text('// by Ana', 'import x', 'one', 'two', 'three', 'four'));
  });

  test('deleting lines on one side, changing others on the other', () => {
    const base = text('a', 'b', 'c', 'd', 'e', 'f');
    assert.equal(merge3(base, text('a', 'd', 'e', 'f'), text('a', 'b', 'c', 'd', 'e', 'F')).text, text('a', 'd', 'e', 'F'));
  });

  test('a last line without a line ending', () => {
    assert.equal(merge3('a\nb\nc', 'A\nb\nc', 'a\nb\nC').text, 'A\nb\nC');
    assert.equal(merge3('', 'mine', '').text, 'mine');
  });

  test('too different to merge line by line: null', () => {
    const base = text(...Array.from({ length: 1200 }, (_, i) => `line ${i}`));
    const ours = text(...Array.from({ length: 1200 }, (_, i) => `other ${i}`));
    assert.equal(merge3(base, ours, text('changed', ...Array.from({ length: 1199 }, (_, i) => `line ${i + 1}`))), null);
  });

  test('random edits in separate places always merge to both', () => {
    let seed = 7;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const edit = (lines, from, to, tag) => {
      const out = lines.slice(0, from);
      for (let i = from; i < to; i++) {
        const r = rnd(4);
        if (r === 0) continue; // delete
        if (r === 1) out.push(`${tag} changed ${i}`);
        else if (r === 2) out.push(`${tag} added ${i}`, lines[i]);
        else out.push(lines[i]);
      }
      return [...out, ...lines.slice(to)];
    };
    for (let round = 0; round < 300; round++) {
      const n = 20 + rnd(200);
      const base = Array.from({ length: n }, (_, i) => `line ${i} ${rnd(3) ? '' : '{'}`);
      // Two separate stretches, with a line between them that neither changes.
      const cut = 1 + rnd(n - 2);
      const a = [rnd(cut), cut];
      const b = [cut + 1, cut + 1 + rnd(n - cut - 1)];
      const swap = rnd(2) === 1;
      const ours = edit(base, ...(swap ? b : a), 'mine');
      const theirs = edit(base, ...(swap ? a : b), 'theirs');
      // Expected: each stretch as the side that changed it made it.
      const [first, second] = swap ? [theirs, ours] : [ours, theirs];
      const expected = [...first.slice(0, first.length - (n - a[1])), ...base.slice(a[1], b[0]), ...second.slice(b[0])];
      const r = merge3(text(...base), text(...ours), text(...theirs));
      assert.equal(r.text, text(...expected), `round ${round}`);
      assert.equal(r.conflicts, 0, `round ${round}`);
    }
  });
});
