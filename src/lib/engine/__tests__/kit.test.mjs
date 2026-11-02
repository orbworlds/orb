// Run all engine tests: node --test --experimental-strip-types src/lib/engine/__tests__/*.test.mjs
// Orb's kits (public/kit/*.js): every build gets them, the prompt points at each one's documentation.
import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { KITS, kitHeaderLines } = await import('../../../server/agent/kit.ts');
const { agentSystemPrompt, cursorOrbPrompt } = await import('../../../server/agent/prompt.ts');
const dir = new URL('../../../../public/kit/', import.meta.url);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
const API = {
  'paint.js': ['createPainter', 'paint(', 'skyMesh', 'clumps', 'scatter'],
  'nature.js': ['createNature', 'terrain(', 'heightAt', 'grass(', 'flowers(', 'trees(', 'rocks(', 'water(', 'world.render()', 'setSize'],
};

test('the bundled kits are the kits (after changing one: node scripts/kits.mjs)', () => {
  assert.deepEqual(Object.keys(KITS).sort(), files.map((f) => `orb/${f}`).sort());
  for (const f of files) assert.equal(KITS[`orb/${f}`], fs.readFileSync(new URL(f, dir), 'utf8'), f);
});

test('each opening comment documents its kit, and the prompts point there', () => {
  const prompts = [agentSystemPrompt('build', 'search'), cursorOrbPrompt({ worldName: 'X', history: [], request: 'r', mode: 'build' })];
  for (const f of files) {
    const path = `orb/${f}`, lines = kitHeaderLines(path), header = KITS[path].split('\n').slice(0, lines).join('\n');
    assert.ok(lines > 5 && lines < 40, `${f}: a short header (${lines} lines)`);
    for (const s of [`./${path}`, ...(API[f] ?? [])]) assert.ok(header.includes(s), `${f}: ${s}`);
    for (const p of prompts) assert.ok(p.includes(`./${path}; its first ${lines} lines say how`), `${f}: in the prompt`);
    assert.ok(!agentSystemPrompt('ask').includes(path), 'a guide changes nothing');
  }
});
