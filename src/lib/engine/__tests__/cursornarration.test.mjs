// What Cursor agents say in Orb's chat (src/server/agent/narration.ts): the sentences about what
// they couldn't verify are left out (the examples are what real agents said on the live site), and
// everything about the world stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { narration, withoutChecks } = await import('../../../server/agent/narration.ts');

test('sentences about saving and unverified checks are left out', () => {
  assert.equal(
    withoutChecks("I made a bouncy pink jelly with a happy face, sitting on a soft pink meadow with floating sparkles. I haven't opened it in a browser to try it, so I haven't seen it wobble myself. It's saved, so you can try it now."),
    'I made a bouncy pink jelly with a happy face, sitting on a soft pink meadow with floating sparkles.',
  );
  assert.equal(
    withoutChecks("I built your tiny aquarium. It has 14 colorful fish, swaying plants, pebbles and rocks, and a little stream of bubbles. I haven't been able to see it run, so I haven't checked how it looks or plays."),
    'I built your tiny aquarium. It has 14 colorful fish, swaying plants, pebbles and rocks, and a little stream of bubbles.',
  );
  assert.equal(
    withoutChecks("I'll write a fresh snowy scene.\nI built a snowy mountain cabin at dusk. It has falling snow. I saved it to your world, but I haven’t opened it in a browser to test it.\n"),
    "I'll write a fresh snowy scene.\nI built a snowy mountain cabin at dusk. It has falling snow.\n",
  );
  assert.equal(withoutChecks('I haven’t tested it yet. Have fun!'), 'Have fun!');
  assert.equal(narration('**Tap** the `fish`! I could not check how it looks.'), 'Tap the fish!');
});

test('sentences about getting the world’s files into the agent’s folder are left out', () => {
  assert.equal(withoutChecks("I'll bring the world's files in and take a look. Then I'll add a little dragon."), "Then I'll add a little dragon.");
  assert.equal(withoutChecks('Let me grab the files first.\nA cozy cabin, coming up!'), 'A cozy cabin, coming up!');
  assert.equal(withoutChecks("I'm downloading the world's files now. Here comes the snow!"), 'Here comes the snow!');
  assert.equal(withoutChecks('First, I’ll get the files.'), '');
});

test('everything about the world stays', () => {
  for (const s of [
    'Tap or click the snow to pop up a snowman, with a little puff and a happy sound. Drag to look around.',
    "I couldn't decide, so you can try both!",
    'Your snowmen are saved for next time.',
    'I saved your high score, so beat it tomorrow!',
    "Fish can't see you when the lights are off.",
    "I'll get the dragon flying over the hills.",
    'Grab the glowing orbs to fill your lantern.',
    'Pull the lever to open the gate.',
  ]) {
    assert.equal(withoutChecks(s), s);
  }
});
