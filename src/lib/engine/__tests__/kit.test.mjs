// Run all engine tests: node --test --experimental-strip-types src/lib/engine/__tests__/*.test.mjs
// Orb's paint kit (public/kit/paint.js): every build gets it, the prompt points at its documentation.
import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { KIT_PATH, KIT_HEADER_LINES } = await import('../../../server/agent/kit.ts');
const { agentSystemPrompt, cursorOrbPrompt } = await import('../../../server/agent/prompt.ts');
const source = fs.readFileSync(new URL('../../../../public/kit/paint.js', import.meta.url), 'utf8');
const bundled = JSON.parse(fs.readFileSync(new URL('../../../data/paint-kit.json', import.meta.url), 'utf8')).source;

test('the bundled kit is the kit (after changing it: node scripts/paint-kit.mjs)', () => {
  assert.equal(bundled, source);
});

test('its opening comment documents it, and the prompts point there', () => {
  assert.equal(KIT_HEADER_LINES, source.split('\n').findIndex((l) => !l.startsWith('//')));
  assert.ok(KIT_HEADER_LINES > 5 && KIT_HEADER_LINES < 40, `a short header (${KIT_HEADER_LINES} lines)`);
  const header = source.split('\n').slice(0, KIT_HEADER_LINES).join('\n');
  for (const s of [`./${KIT_PATH}`, 'createPainter', 'paint(', 'skyMesh', 'clumps', 'scatter']) assert.ok(header.includes(s), s);
  for (const p of [agentSystemPrompt('build', 'search'), cursorOrbPrompt({ worldName: 'X', history: [], request: 'r', mode: 'build' })])
    assert.ok(p.includes(`./${KIT_PATH}; its first ${KIT_HEADER_LINES} lines say how`));
  assert.ok(!agentSystemPrompt('ask').includes(KIT_PATH), 'a guide changes nothing');
});
