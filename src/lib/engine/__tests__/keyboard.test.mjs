// Worlds that need a keyboard (src/lib/keyboard.ts): phones see the ones that play by touch first.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { needsKeyboard, onPhone, touchFirst } = await import('../../keyboard.ts');

const w = (id, ...tags) => ({ id, tags });

test('phones see worlds that play by touch first, each group in its own order', () => {
  const list = [w('a', 'game', 'keyboard'), w('b', 'toy'), w('c', 'keyboard'), w('d')];
  assert.deepEqual(touchFirst(list).map((x) => x.id), ['b', 'd', 'a', 'c']);
  assert.deepEqual(list.map((x) => x.id), ['a', 'b', 'c', 'd'], 'the input is left alone');
  assert.equal(needsKeyboard(list[0]), true);
  assert.equal(needsKeyboard(list[1]), false);
});

test('without matchMedia (on the server) nothing is a phone', () => {
  assert.equal(onPhone(), false);
});
