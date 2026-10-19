// Run all engine tests: node --test --experimental-strip-types src/lib/engine/__tests__/*.test.mjs
// Plain JS on purpose: node strips the types of the imported .ts sources (explicit .ts paths,
// which the app tsconfig does not allow, so these files stay outside tsc).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolParser, parseAll, applyEdit, cleanBody, parseSuggestions } from '../protocol.ts';
import { ISLAND_HTML, REALISTIC_EDITS, realisticReply, expectedAfterReply, rng, randomChunks } from './fixtures.mjs';

/** Collapse an event list into a comparable summary (progress events are timing-dependent). */
function digest(events) {
  const d = { say: '', sayBlocks: 0, titles: [], starts: [], writes: [], edits: [], failed: [], suggest: [], errors: [], remix: 0 };
  for (const e of events) {
    switch (e.type) {
      case 'say':
        d.say += e.delta;
        if (e.done) d.sayBlocks++;
        break;
      case 'title':
        d.titles.push(e.text);
        break;
      case 'step-start':
        d.starts.push(`${e.id}:${e.kind}:${e.label}`);
        break;
      case 'write':
        d.writes.push({ id: e.id, label: e.label, html: e.html });
        break;
      case 'edit':
        d.edits.push({ id: e.id, label: e.label, find: e.find, replace: e.replace });
        break;
      case 'step-failed':
        d.failed.push(`${e.id}:${e.error}`);
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

function feed(chunks, opts) {
  const p = new ProtocolParser(opts);
  const events = [];
  for (const c of chunks) events.push(...p.push(c));
  events.push(...p.end());
  return events;
}

/** Apply write/edit events in order to a base code (like useBuild does). */
function applyEvents(base, events) {
  let code = base;
  const failed = [];
  for (const e of events) {
    if (e.type === 'write') code = e.html;
    if (e.type === 'edit') {
      const r = applyEdit(code, e.find, e.replace);
      if (r.ok) code = r.code;
      else failed.push(e.label);
    }
  }
  return { code, failed };
}

describe('ProtocolParser — realistic replies', () => {
  test('parses a full reply into the expected events', () => {
    const d = digest(parseAll(realisticReply()));
    assert.equal(d.say, "Ooh, a floating island in the sky — let's make it!\n\nDrag to look around — the clouds drift by slowly.");
    assert.equal(d.sayBlocks, 2);
    assert.deepEqual(d.titles, ['Sky Island']);
    assert.deepEqual(d.starts, [
      'step-1:write:Raising the island',
      'step-2:edit:Adding drifting clouds',
      'step-3:edit:Letting the clouds float <gently>',
      'step-4:edit:Warming up the sunset',
    ]);
    assert.equal(d.writes.length, 1);
    assert.equal(d.writes[0].html, ISLAND_HTML);
    assert.equal(d.edits.length, 3);
    REALISTIC_EDITS.forEach((e, i) => {
      assert.equal(d.edits[i].find, e.find);
      assert.equal(d.edits[i].replace, e.replace);
    });
    assert.deepEqual(d.suggest, [['Make it night', 'Add a little waterfall', 'Add soft music']]);
    assert.deepEqual(d.failed, []);
    assert.equal(applyEvents('', parseAll(realisticReply())).code, expectedAfterReply());
  });

  test('randomized chunk splitting yields identical results (500 runs)', () => {
    const text = realisticReply();
    const reference = digest(parseAll(text));
    for (let seed = 1; seed <= 500; seed++) {
      const rand = rng(seed);
      const chunks = randomChunks(text, rand, 1 + Math.floor(rand() * 60));
      const events = feed(chunks);
      assert.deepEqual(digest(events), reference, `seed ${seed}`);
      assert.equal(applyEvents('', events).code, expectedAfterReply(), `seed ${seed}`);
    }
  });

  test('one character at a time', () => {
    const text = realisticReply();
    const events = feed([...text]);
    assert.deepEqual(digest(events), digest(parseAll(text)));
  });

  test('randomized splitting of tricky edge-case replies', () => {
    const tricky = [
      `Sure thing!\n<orb:title>'Moon Garden'</orb:title><orb:edit label='Planting "moon" flowers'>\n<orb:find>a</orb:find>\n<orb:replace>b</orb:replace>\n</orb:edit>`,
      `<ORB:SAY>Hi <3 — a < b and b > a</ORB:SAY><orb:edit label=“Curly > quotes”><orb:find>x</orb:find><orb:replace>y</orb:replace></orb:edit>`,
      `<orb:say>One</orb:say>\n\n<orb:plan>secret plan</orb:plan><orb:say>Two</orb:say><orb:suggest>\n- A\n- B\n- "C"\n</orb:suggest>`,
      `<orb:write label="Base">\n\`\`\`html\n<!DOCTYPE html><html><body>hi</body></html>\n\`\`\`\n</orb:write><orb:remix/>`,
      `<orb:say>Fixing</orb:say><orb:find>\nfoo\n</orb:find><orb:replace>\nbar\n</orb:replace></orb:edit><orb:suggest>a|b|c</orb:suggest>`,
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

  test('step-start fires as soon as the opening tag completes, even mid-attribute splits', () => {
    const p = new ProtocolParser({ idPrefix: 'm1:' });
    assert.deepEqual(p.push('<orb:edit lab'), []);
    assert.deepEqual(p.push('el="Plant'), []);
    assert.deepEqual(p.push('ing trees"'), []);
    assert.deepEqual(p.push('>'), [{ type: 'step-start', id: 'm1:step-1', kind: 'edit', label: 'Planting trees' }]);
  });

  test('step-progress is throttled and carries a tail for the code peek', () => {
    const body = 'x'.repeat(1000) + 'THE_END';
    const p = new ProtocolParser({ progressEvery: 200, tailChars: 50 });
    const events = [];
    events.push(...p.push('<orb:write label="Big">'));
    for (let i = 0; i < body.length; i += 10) events.push(...p.push(body.slice(i, i + 10)));
    const progress = events.filter((e) => e.type === 'step-progress');
    assert.ok(progress.length >= 4 && progress.length <= 6, `got ${progress.length}`);
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i].chars - progress[i - 1].chars >= 200);
    const last = progress[progress.length - 1];
    assert.ok(last.tail.length <= 50);
    events.push(...p.push('</orb:write>'));
    assert.equal(events.at(-1).type, 'write');
  });

  test('edit progress tail hides the find/replace tags', () => {
    const p = new ProtocolParser({ progressEvery: 10 });
    const ev = p.push('<orb:edit label="x"><orb:find>aaaa</orb:find><orb:replace>bbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const prog = ev.filter((e) => e.type === 'step-progress').at(-1);
    assert.ok(prog && !prog.tail.includes('<orb:'), prog?.tail);
    assert.ok(prog.tail.endsWith('bbbb'));
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
  test('attribute quoting styles and entities', () => {
    const labels = digest(
      parseAll(
        [
          `<orb:edit label='Single quoted'><orb:find>a</orb:find><orb:replace>b</orb:replace></orb:edit>`,
          `<orb:edit label=Unquoted><orb:find>a</orb:find><orb:replace>b</orb:replace></orb:edit>`,
          `<orb:edit id="7" label="Fish &amp; chips &#x2728;" extra='1'><orb:find>a</orb:find><orb:replace>b</orb:replace></orb:edit>`,
          `<orb:edit label = "Spaced  out  "><orb:find>a</orb:find><orb:replace>b</orb:replace></orb:edit>`,
          `<orb:edit label="**Markdown** label"><orb:find>a</orb:find><orb:replace>b</orb:replace></orb:edit>`,
        ].join('\n'),
      ),
    ).edits.map((e) => e.label);
    assert.deepEqual(labels, ['Single quoted', 'Unquoted', 'Fish & chips ✨', 'Spaced out', 'Markdown label']);
  });

  test('missing labels get friendly defaults', () => {
    const d = digest(
      parseAll(`<orb:write><html></html></orb:write><orb:edit><orb:find>a</orb:find><orb:replace>b</orb:replace></orb:edit><orb:edit label=""><orb:find>c</orb:find><orb:replace>d</orb:replace></orb:edit><orb:write>x</orb:write>`),
    );
    assert.deepEqual(
      d.starts.map((s) => s.split(':').slice(2).join(':')),
      ['Building your world', 'Adding a new touch', 'Polishing the details', 'Rebuilding your world'],
    );
  });

  test('markdown fences and single surrounding newlines are stripped from bodies', () => {
    const d = digest(
      parseAll(
        '<orb:write label="w">\n```html\n<!DOCTYPE html>\n<html></html>\n```\n</orb:write>' +
          '<orb:edit label="e"><orb:find>\n```js\nconst a = 1;\n```\n</orb:find><orb:replace>\n\nconst a = 2;\n\n</orb:replace></orb:edit>',
      ),
    );
    assert.equal(d.writes[0].html, '<!DOCTYPE html>\n<html></html>');
    assert.equal(d.edits[0].find, 'const a = 1;');
    // only ONE leading and ONE trailing newline is removed
    assert.equal(d.edits[0].replace, '\nconst a = 2;\n');
  });

  test('cleanBody keeps a trailing fence in snippets without a leading fence', () => {
    assert.equal(cleanBody('const s = `\n```', 'snippet'), 'const s = `\n```');
    assert.equal(cleanBody('```\nx\n```', 'snippet'), 'x');
  });

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

  test('an unterminated write that contains </html> is applied at end()', () => {
    const d = digest(parseAll('<orb:write label="w"><!DOCTYPE html><html><body>ok</body></html>\n</orb:wri'));
    assert.equal(d.writes.length, 1);
    assert.equal(d.writes[0].html, '<!DOCTYPE html><html><body>ok</body></html>');
    assert.deepEqual(d.failed, []);
  });

  test('an unterminated write without </html> is marked failed', () => {
    const d = digest(parseAll('<orb:write label="w"><!DOCTYPE html><html><body>half'));
    assert.equal(d.writes.length, 0);
    assert.equal(d.failed.length, 1);
    assert.match(d.failed[0], /cut off/);
  });

  test('an unterminated edit is marked failed; complete pairs before it still apply', () => {
    const d = digest(parseAll('<orb:edit label="e"><orb:find>a</orb:find><orb:replace>b</orb:replace><orb:find>c</orb:find><orb:replace>d'));
    assert.deepEqual(d.edits.map((e) => [e.find, e.replace]), [['a', 'b']]);
    assert.equal(d.failed.length, 1);
    const d2 = digest(parseAll('<orb:edit label="e"><orb:find>a</orb:find><orb:rep'));
    assert.equal(d2.edits.length, 0);
    assert.equal(d2.failed.length, 1);
  });

  test('a forgotten </orb:write> is closed by the next block', () => {
    const d = digest(parseAll('<orb:write label="w"><html>x</html>\n<orb:edit label="e"><orb:find>x</orb:find><orb:replace>y</orb:replace></orb:edit>'));
    assert.equal(d.writes[0].html, '<html>x</html>');
    assert.equal(d.edits.length, 1);
    assert.equal(applyEvents('', parseAll('<orb:write label="w"><html>x</html>\n<orb:edit label="e"><orb:find>x</orb:find><orb:replace>y</orb:replace></orb:edit>')).code, '<html>y</html>');
  });

  test('a forgotten </orb:say> is closed by the next block', () => {
    const d = digest(parseAll('<orb:say>Hello<orb:title>T</orb:title>'));
    assert.equal(d.say, 'Hello');
    assert.deepEqual(d.titles, ['T']);
  });

  test('bare find/replace without an edit wrapper becomes an edit', () => {
    const d = digest(parseAll('<orb:say>Fix</orb:say><orb:find>a</orb:find><orb:replace>b</orb:replace><orb:say>Done</orb:say>'));
    assert.equal(d.edits.length, 1);
    assert.equal(d.edits[0].label, 'Adding a new touch');
    assert.equal(d.say, 'Fix\n\nDone');
  });

  test('several find/replace pairs in one edit share the step id', () => {
    const d = digest(parseAll('<orb:edit label="Two"><orb:find>a</orb:find><orb:replace>b</orb:replace>\n<orb:find>c</orb:find><orb:replace>d</orb:replace></orb:edit>'));
    assert.deepEqual(d.edits.map((e) => `${e.id}:${e.find}>${e.replace}`), ['step-1:a>b', 'step-1:c>d']);
  });

  test('missing </orb:find> and </orb:replace> are tolerated inside a closed edit', () => {
    const d = digest(parseAll('<orb:edit label="x"><orb:find>a\n<orb:replace>b\n</orb:edit>'));
    assert.deepEqual(d.edits.map((e) => [e.find, e.replace]), [['a', 'b']]);
  });

  test('an edit without find is reported as failed', () => {
    const d = digest(parseAll('<orb:edit label="x">just text</orb:edit>'));
    assert.equal(d.edits.length, 0);
    assert.equal(d.failed.length, 1);
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
  });

  test('unknown blocks and stray closing tags are ignored', () => {
    const d = digest(parseAll('</orb:edit><orb:thinking>plan: <b>x</b></orb:thinking><orb:say>Hi</orb:say>'));
    assert.equal(d.say, 'Hi');
  });

  test('non-tags that look similar are plain text', () => {
    const d = digest(parseAll('<orb:say>Use <orbit> and <or> and <orb:sayhi> here</orb:say>'));
    assert.equal(d.say, 'Use <orbit> and <or> and <orb:sayhi> here');
  });

  test('labels containing ">" survive chunking inside quotes', () => {
    const text = '<orb:edit label="a > b">\n<orb:find>q</orb:find><orb:replace>r</orb:replace></orb:edit>';
    for (let i = 1; i < text.length; i++) {
      const d = digest(feed([text.slice(0, i), text.slice(i)]));
      assert.equal(d.edits[0]?.label, 'a > b', `split at ${i}`);
    }
  });

  test('every possible two-way split of a mixed reply is equivalent', () => {
    const text = '<orb:say>Hi!</orb:say>\n<orb:title>T</orb:title>\n<orb:edit label="E"><orb:find>\n  a\n</orb:find><orb:replace>\n  b\n</orb:replace></orb:edit>\n<orb:suggest>x|y|z</orb:suggest>';
    const ref = digest(parseAll(text));
    for (let i = 1; i < text.length; i++) assert.deepEqual(digest(feed([text.slice(0, i), text.slice(i)])), ref, `split at ${i}`);
  });
});

describe('applyEdit', () => {
  test('exact match replaces the first occurrence only', () => {
    const r = applyEdit('a\nb\na\n', 'a', 'X');
    assert.deepEqual(r, { ok: true, code: 'X\nb\na\n', fuzzy: false });
  });

  test('replacement text is inserted literally ($ patterns are not special)', () => {
    const r = applyEdit('price = 1;', 'price = 1;', "price = '$&$1';");
    assert.equal(r.ok && r.code, "price = '$&$1';");
  });

  test('indentation differences: unindented find + unindented replace gets the code indentation', () => {
    const code = 'function f() {\n    const a = 1;\n    const b = 2;\n    return a + b;\n}\n';
    const r = applyEdit(code, 'const a = 1;\nconst b = 2;', 'const a = 10;\nif (a) {\n  log(a);\n}\nconst b = 20;');
    assert.ok(r.ok && r.fuzzy);
    assert.equal(r.code, 'function f() {\n    const a = 10;\n    if (a) {\n      log(a);\n    }\n    const b = 20;\n    return a + b;\n}\n');
  });

  test('indentation differences: replacement is shifted from the find base to the code base', () => {
    const code = '<body>\n        <div id="a">\n          <p>hi</p>\n        </div>\n</body>';
    const r = applyEdit(code, '  <div id="a">\n    <p>hi</p>\n  </div>', '  <div id="a">\n    <p>hello</p>\n    <p>more</p>\n  </div>');
    assert.ok(r.ok && r.fuzzy);
    assert.equal(r.code, '<body>\n        <div id="a">\n          <p>hello</p>\n          <p>more</p>\n        </div>\n</body>');
  });

  test('replacement already at the code indentation is left untouched', () => {
    const code = '  x();\n  y();\n';
    const r = applyEdit(code, 'x();\ny();', '  x();\n  z();\n  y();');
    assert.ok(r.ok);
    assert.equal(r.code, '  x();\n  z();\n  y();\n');
  });

  test('trailing spaces, blank lines and internal spacing differences are ignored', () => {
    const code = 'a();   \n\n\nb( 1,  2 );\nc();\n';
    const r = applyEdit(code, 'a();\nb( 1, 2 );', 'A();\nB();');
    assert.ok(r.ok && r.fuzzy);
    assert.equal(r.code, 'A();\nB();\nc();\n');
  });

  test('CRLF code keeps its line endings', () => {
    const code = 'one\r\n  two\r\nthree\r\n';
    const r = applyEdit(code, 'two\nthree', 'TWO\nTHREE');
    assert.ok(r.ok);
    assert.equal(r.code, 'one\r\n  TWO\r\n  THREE\r\n');
  });

  test('mid-line snippets with different whitespace still match', () => {
    const code = 'const cfg = { speed:2,  size : 3 };';
    const r = applyEdit(code, 'speed: 2, size: 3', 'speed: 4, size: 3');
    assert.ok(r.ok && r.fuzzy);
    assert.equal(r.code, 'const cfg = { speed: 4, size: 3 };');
  });

  test('fuzzy deletion removes the whole lines', () => {
    const code = 'keep1\n    drop1\n    drop2\nkeep2\n';
    const r = applyEdit(code, 'drop1\ndrop2', '');
    assert.ok(r.ok);
    assert.equal(r.code, 'keep1\nkeep2\n');
  });

  test('idempotent: an already-applied edit succeeds without changes', () => {
    const code = 'scene.add(clouds);\nclouds.rotation.y += dt * 0.02;\n';
    const r = applyEdit(code, 'scene.add(old);', 'scene.add(clouds);\nclouds.rotation.y += dt * 0.02;');
    assert.deepEqual(r, { ok: true, code, fuzzy: true, noop: true });
  });

  test('a short replacement that happens to exist is not treated as applied', () => {
    const r = applyEdit('x = 1;\n}\n', 'y = 2;', '}');
    assert.equal(r.ok, false);
  });

  test('failure explains where the snippet diverges', () => {
    const r = applyEdit(ISLAND_HTML, '// === WORLD ===\nconst island = new THREE.Group();', 'x');
    assert.equal(r.ok, false);
    assert.match(r.error, /first line matches at line \d+/);
    assert.match(r.error, /THREE\.Group/);
    const r2 = applyEdit(ISLAND_HTML, 'const dragon = makeDragon();', 'x');
    assert.equal(r2.ok, false);
    assert.match(r2.error, /does not exist/);
  });

  test('empty find fails', () => {
    assert.equal(applyEdit('abc', '  \n', 'x').ok, false);
  });

  test('fuzzy matching picks the first occurrence', () => {
    const code = '  a();\n  b();\n  a();\n  b();\n';
    const r = applyEdit(code, 'a();\nb();', 'c();');
    assert.ok(r.ok);
    assert.equal(r.code, '  c();\n  a();\n  b();\n');
  });

  test('realistic edits with mangled indentation still land in the right place', () => {
    // The model dropped all indentation in both find and replace.
    const find = 'renderer.setAnimationLoop((t) => {\ntimer.update(t);';
    const r = applyEdit(ISLAND_HTML, find, 'renderer.setAnimationLoop((t) => {\ntimer.update(t);\nif (paused) return;');
    assert.ok(r.ok && r.fuzzy);
    assert.ok(r.code.includes('renderer.setAnimationLoop((t) => {\n  timer.update(t);\n  if (paused) return;\n  const dt'), r.code.slice(-400));
  });

  test('nesting added around kept lines is preserved', () => {
    const code = 'function loop() {\n    a();\n    b();\n}\n';
    const r = applyEdit(code, 'a();\nb();', 'if (on) {\n  a();\n  b();\n}');
    assert.ok(r.ok && r.fuzzy);
    assert.equal(r.code, 'function loop() {\n    if (on) {\n      a();\n      b();\n    }\n}\n');
  });

  test('a flat replacement takes the code indentation even when the find was indented correctly', () => {
    const code = '  if (a) {   \n    go();\n  }\n';
    const r = applyEdit(code, '  if (a) {\n    go();', 'if (a) {\n  go();\n  stop();');
    assert.ok(r.ok && r.fuzzy);
    assert.equal(r.code, '  if (a) {\n    go();\n    stop();\n  }\n');
  });

  test('tab-indented code keeps tabs', () => {
    const code = 'x {\n\t\tone();\n\t\ttwo();\n}';
    const r = applyEdit(code, 'one();\ntwo();', 'one();\nmid();\ntwo();');
    assert.ok(r.ok);
    assert.equal(r.code, 'x {\n\t\tone();\n\t\tmid();\n\t\ttwo();\n}');
  });
});

test('<orb:cut/> drops a block that was cut off and keeps going', async () => {
  const { ProtocolParser } = await import('../protocol.ts');
  const p = new ProtocolParser();
  const text = '<orb:edit label="Trees"><orb:find>a: 1,</orb:find><orb:replace>a: 1, trees: [1,\n<orb:cut/>\n<orb:edit label="Trees"><orb:find>a: 1,</orb:find><orb:replace>a: 1, trees: 3,</orb:replace></orb:edit>';
  const ev = [...p.push(text), ...p.end()].filter((e) => e.type === 'edit' || e.type === 'step-failed');
  assert.equal(ev.length, 2);
  assert.equal(ev[0].type, 'step-failed');
  assert.equal(ev[0].cut, true);
  assert.equal(ev[1].type, 'edit');
  assert.equal(ev[1].replace, 'a: 1, trees: 3,');
});
