// Cursor agents without GitHub (src/server/agent/sync.ts): the files link's token, the download
// with its .orb/save script, and saves read back into trees — with the real tar, sh and curl the
// agent uses, against an in-memory PGlite with the app's schema.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DDL } from '../../../server/ddl.mjs';

// Only the module resolution of ./setup.mjs: its browser globals would confuse PGlite.
register('./resolve-hooks.mjs', import.meta.url);

const sync = await import('../../../server/agent/sync.ts');
const files = await import('../../../server/files.ts');
const look = await import('../../../server/agent/look.ts');

let pg;
let db;
before(async () => {
  pg = new PGlite();
  await pg.exec(DDL);
  db = { query: async (sql, params = []) => (await pg.query(sql, params)).rows, kind: 'pglite' };
});
after(() => pg.close());

const LONG = `src/${'very-long-folder-name-'.repeat(4)}/${'module-'.repeat(10)}.js`;
/** Run .orb/save the way the agent does (asynchronously: the stand-in server answers in this process). */
const runSave = async (script, cwd) => (await promisify(execFile)('sh', [script], { cwd, encoding: 'utf8', timeout: 30_000 })).stdout;

async function treeOf(entries) {
  const tree = {};
  for (const [p, s] of Object.entries(entries)) tree[p] = (await files.putBlob(db, s)).sha;
  return tree;
}
const textOf = async (tree, p) => new TextDecoder().decode(await files.getBlob(db, tree[p]));

/** Unpack a download into a fresh folder with the real tar, as the agent does. */
async function unpack(stream) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-sync-'));
  execFileSync('tar', ['-xzf', '-'], { cwd: dir, input: Buffer.from(await new Response(stream).arrayBuffer()) });
  return dir;
}

/** Stands in for PUT /api/agent/jobs/:id/files: each save on top of `base`, answered in words. */
async function saveServer(base) {
  const saves = [];
  const server = http.createServer(async (req, res) => {
    let bytes = 0;
    req.on('data', (c) => (bytes += c.length));
    try {
      const saved = await sync.readSave(db, Readable.toWeb(req), base);
      saves.push({ ...saved, bytes, tree: await files.getTree(db, saved.tree) });
      res.end(`Saved to Orb (${saved.files} files, ${saved.changed} changed).`);
    } catch (e) {
      saves.push({ error: e.message, bytes });
      res.statusCode = 400;
      res.end(`Not saved: ${e.message}`);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/files?t=x&base=y`, saves, close: () => server.close() };
}
/** A download whose scripts save to `save` (and look at a server that isn't there). */
const links = (save) => ({ save, look: 'http://127.0.0.1:9/files/look?t=x&base=y' });

/** A 1×1 PNG, as a page's screenshot. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const SEEN = {
  size: { w: 390, h: 844, dpr: 3 },
  title: 'Campfire',
  uptime: 2400,
  fps: 57,
  errors: [],
  logs: [{ level: 'log', text: 'fire lit', t: 300 }],
  dropped: 0,
  ui: [{ text: 'Tap to add a log', x: 0.1, y: 0.85, w: 0.4, h: 0.05, tag: 'button', click: true }],
  canvas: { w: 390, h: 844, type: 'webgl2', cover: 1 },
  focus: 'page',
  locked: false,
  shots: [
    { label: 'Walking up!', t: 1200, dataUrl: `data:image/png;base64,${PNG.toString('base64')}` },
    { label: 'end', t: 2300, dataUrl: `data:image/png;base64,${PNG.toString('base64')}` },
  ],
  evals: [],
  notes: [],
};

/**
 * Stands in for POST /api/agent/jobs/:id/files/look: reads each look's upload on top of `base`
 * and answers with `answer(sent)` — what the page saw (a .tar.gz, as Orb sends it) or words.
 */
async function lookServer(base, answer) {
  const looks = [];
  const server = http.createServer(async (req, res) => {
    try {
      const sent = await sync.readSave(db, Readable.toWeb(req), base, { look: true });
      looks.push({ ...sent, tree: await files.getTree(db, sent.tree) });
      const a = answer(sent);
      if (typeof a === 'string') {
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        return res.end(`${a}\n`);
      }
      res.setHeader('content-type', 'application/gzip');
      res.end(sync.packSeen(a));
    } catch (e) {
      looks.push({ error: e.message });
      res.statusCode = 400;
      res.end(`Can't look: ${e.message}\n`);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/files/look?t=x&base=y`, looks, close: () => server.close() };
}

describe('files token', () => {
  test('works for its own job only', () => {
    const t = sync.filesToken('job-aaaaaaaaaaaaaaaaaaaaaa');
    assert.ok(sync.checkFilesToken('job-aaaaaaaaaaaaaaaaaaaaaa', t));
    assert.ok(!sync.checkFilesToken('job-bbbbbbbbbbbbbbbbbbbbbb', t));
    assert.ok(!sync.checkFilesToken('job-aaaaaaaaaaaaaaaaaaaaaa', `${t}x`));
    assert.ok(!sync.checkFilesToken('job-aaaaaaaaaaaaaaaaaaaaaa', null));
    assert.match(sync.filesUrl('https://orb.example', 'job-aaaaaaaaaaaaaaaaaaaaaa'), /^https:\/\/orb\.example\/api\/agent\/jobs\/job-a+\/files\?t=[\w-]+$/);
  });
});

describe('download and save', () => {
  test('the download has the files, their sha256 as sha256sum prints them, and save and look scripts only when saving is allowed', async () => {
    const base = await treeOf({ 'index.html': '<!doctype html><title>Hi</title>', 'src/main.js': 'console.log(1)\n', [LONG]: 'export const deep = 1;\n' });
    const dir = await unpack(sync.packWorld(db, base, { save: 'http://127.0.0.1:9/files?t=x', look: 'http://127.0.0.1:9/files/look?t=x' }));
    assert.equal(fs.readFileSync(path.join(dir, 'src/main.js'), 'utf8'), 'console.log(1)\n');
    assert.equal(fs.readFileSync(path.join(dir, LONG), 'utf8'), 'export const deep = 1;\n', 'long paths survive');
    const lines = (s) => s.split('\n').filter(Boolean).sort();
    assert.deepEqual(lines(fs.readFileSync(path.join(dir, '.orb/sums'), 'utf8')), lines(execFileSync('sha256sum', ['index.html', LONG, 'src/main.js'], { cwd: dir, encoding: 'utf8' })));
    assert.ok(fs.statSync(path.join(dir, '.orb/save')).mode & 0o100, 'the save script is executable');
    assert.match(fs.readFileSync(path.join(dir, '.orb/save'), 'utf8'), /'http:\/\/127\.0\.0\.1:9\/files\?t=x'/);
    assert.ok(fs.statSync(path.join(dir, '.orb/look')).mode & 0o100, 'the look script is executable');
    assert.match(fs.readFileSync(path.join(dir, '.orb/look'), 'utf8'), /'http:\/\/127\.0\.0\.1:9\/files\/look\?t=x'/);
    const guide = await unpack(sync.packWorld(db, base, null));
    assert.ok(fs.existsSync(path.join(guide, 'index.html')) && !['.orb/save', '.orb/look', '.orb/sums'].some((p) => fs.existsSync(path.join(guide, p))), 'no saving or looking for a guide');
    assert.match(sync.lookUrl('https://orb.example', 'job-aaaaaaaaaaaaaaaaaaaaaa'), /^https:\/\/orb\.example\/api\/agent\/jobs\/job-a+\/files\/look\?t=[\w-]+$/);
  });

  test('a change is found by its contents, even when the file keeps its old date (as Cursor’s edit tool does)', async () => {
    const base = await treeOf({ 'index.html': '<!doctype html><title>Untitled world</title>' });
    const server = await saveServer(base);
    try {
      const dir = await unpack(sync.packWorld(db, base, links(server.url)));
      const page = path.join(dir, 'index.html');
      const { atime, mtime } = fs.statSync(page);
      fs.writeFileSync(page, '<!doctype html><title>Campfire</title><body>fireflies</body>');
      fs.utimesSync(page, atime, mtime);
      assert.match(await runSave('.orb/save', dir), /1 files, 1 changed/);
      assert.equal(await textOf(server.saves[0].tree, 'index.html'), '<!doctype html><title>Campfire</title><body>fireflies</body>');
      assert.match(await runSave('.orb/save', dir), /1 files, 1 changed/, 'saves count from the download');
    } finally {
      server.close();
    }
  });

  test('a save sends only the changes and the list of files; the rest comes from the downloaded tree', async () => {
    const big = 'x'.repeat(300_000);
    const base = await treeOf({ 'index.html': '<!doctype html><title>Hi</title>', 'src/main.js': 'console.log(1)\n', 'assets/big.txt': big, 'old.js': 'gone soon\n', [LONG]: 'deep\n' });
    const server = await saveServer(base);
    try {
      const dir = await unpack(sync.packWorld(db, base, links(server.url)));
      fs.writeFileSync(path.join(dir, 'src/main.js'), 'console.log(2)\n');
      fs.writeFileSync(path.join(dir, 'src/new.js'), 'export {};\n');
      fs.writeFileSync(path.join(dir, '.orb/plan.md'), '- done: colors\n');
      fs.rmSync(path.join(dir, 'old.js'));
      for (const junk of ['node_modules/x/index.js', '.git/config']) {
        fs.mkdirSync(path.dirname(path.join(dir, junk)), { recursive: true });
        fs.writeFileSync(path.join(dir, junk), 'junk');
      }
      // Run from elsewhere, as an agent might.
      const said = await runSave(path.join(dir, '.orb/save'), os.tmpdir());
      assert.match(said, /Saved to Orb \(6 files, 3 changed\)/);
      const [save] = server.saves;
      assert.deepEqual(Object.keys(save.tree).sort(), ['.orb/plan.md', 'assets/big.txt', 'index.html', LONG, 'src/main.js', 'src/new.js'].sort());
      assert.equal(await textOf(save.tree, 'src/main.js'), 'console.log(2)\n');
      assert.equal(save.tree['assets/big.txt'], base['assets/big.txt']);
      assert.equal(save.tree[LONG], base[LONG]);
      assert.ok(save.bytes < 4000, `small request (${save.bytes} bytes) for a world of ${big.length} bytes`);
      assert.ok(save.entry);

      // Saves keep counting from the download: the next one still carries the earlier changes.
      fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Hello</title>');
      assert.match(await runSave('.orb/save', dir), /6 files, 4 changed/);
      assert.equal(await textOf(server.saves[1].tree, 'src/main.js'), 'console.log(2)\n');
    } finally {
      server.close();
    }
  });

  test('a new world: everything the agent writes is sent', async () => {
    const server = await saveServer({});
    try {
      const dir = await unpack(sync.packWorld(db, {}, links(server.url)));
      fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>New</title>');
      assert.match(await runSave('.orb/save', dir), /1 files, 1 changed/);
    } finally {
      server.close();
    }
  });

  test('without .orb/files a save is the whole world; contents Orb never got are named', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-sync-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
    const whole = execFileSync('tar', ['-czf', '-', 'index.html'], { cwd: dir });
    const saved = await sync.readSave(db, new Response(whole).body, {});
    assert.deepEqual(Object.keys((await files.getTree(db, saved.tree)) ?? {}), ['index.html']);

    fs.mkdirSync(path.join(dir, '.orb'));
    fs.writeFileSync(path.join(dir, '.orb/files'), 'index.html\nghost.js\n');
    const partial = execFileSync('tar', ['-czf', '-', 'index.html', '.orb/files'], { cwd: dir });
    await assert.rejects(sync.readSave(db, new Response(partial).body, {}), /ghost\.js — touch it and save again/);
    await assert.rejects(sync.readSave(db, new Response('not a tarball').body, {}), /isn't a \.tar\.gz/);
  });
});

describe('looking at the world (.orb/look)', () => {
  /** A download whose scripts look at `lookAt` (and save to `saveTo`, when given). */
  const download = (base, lookAt, saveTo = 'http://127.0.0.1:9/files?t=x') => unpack(sync.packWorld(db, base, { save: saveTo, look: lookAt }));
  const seen = (dir) => fs.readdirSync(path.join(dir, '.orb/seen')).sort();

  test('sends the files as they are with what to do first, and unpacks the report and the screenshots', async () => {
    const base = await treeOf({ 'index.html': '<!doctype html><title>Campfire</title>', 'src/main.js': 'console.log(1)\n', 'assets/big.txt': 'x'.repeat(200_000) });
    const server = await lookServer(base, () => look.seenFiles('look-1', SEEN, 0, 120));
    try {
      const dir = await download(base, server.url);
      fs.writeFileSync(path.join(dir, 'src/main.js'), 'console.log(2)\n');
      const said = await runSave('.orb/look', dir);
      const [sent] = server.looks;
      assert.equal(await textOf(sent.tree, 'src/main.js'), 'console.log(2)\n', 'the look runs the files as they are now');
      assert.equal(sent.tree['assets/big.txt'], base['assets/big.txt'], 'unchanged files come from the download');
      assert.ok(sent.entry);
      assert.equal(sent.request, '', 'nothing to do first');
      assert.ok(!Object.keys(sent.tree).some((p) => p.startsWith('.orb/')), 'Orb’s own files are not the world’s');
      assert.match(said, /^The world in the person's browser: 390×844 px \(phone-sized, 3× pixel density\)/);
      assert.match(said, /Frame rate: 57 fps\./);
      assert.match(said, /\[button\] "Tap to add a log"/);
      assert.match(said, /Open each screenshot to see it: \.orb\/seen\/1-walking-up\.png, \.orb\/seen\/2-end\.png/);
      assert.deepEqual(seen(dir), ['1-walking-up.png', '2-end.png', 'report.txt'], 'only what the look saw is left in .orb/seen/');
      assert.deepEqual(fs.readFileSync(path.join(dir, '.orb/seen/2-end.png')), PNG, 'the screenshot is the picture the page took');
    } finally {
      server.close();
    }
  });

  test('what to do first comes as JSON in the argument, or in a file named there', async () => {
    const base = await treeOf({ 'index.html': '<!doctype html><title>Hi</title>' });
    const server = await lookServer(base, () => 'Nobody has the world open right now, so you can’t see it run.');
    try {
      const dir = await download(base, server.url);
      const actions = '{"actions":[{"type":"key","key":"w","ms":800},{"type":"type","text":"it\\u0027s me"}],"viewport":"phone"}';
      const said = await promisify(execFile)('sh', ['.orb/look', actions], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
      assert.equal(said.stdout, 'Nobody has the world open right now, so you can’t see it run.\n', 'Orb’s words are printed as they are');
      assert.equal(server.looks[0].request, actions);
      assert.deepEqual(seen(dir), [], 'an answer in words leaves nothing behind');
      const file = path.join(os.tmpdir(), `orb-look-${process.pid}.json`);
      fs.writeFileSync(file, '[{"type":"click","x":0.5,"y":0.5}]\n');
      await promisify(execFile)('sh', ['.orb/look', file], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
      fs.rmSync(file);
      assert.equal(server.looks[1].request, '[{"type":"click","x":0.5,"y":0.5}]');
      assert.deepEqual(Object.keys(server.looks[1].tree), ['index.html']);
    } finally {
      server.close();
    }
  });

  test('what a look leaves behind is never saved', async () => {
    const base = await treeOf({ 'index.html': '<!doctype html><title>Hi</title>' });
    const lookAt = await lookServer(base, () => look.seenFiles('look-2', SEEN, 0, 2));
    const saveTo = await saveServer(base);
    try {
      const dir = await download(base, lookAt.url, saveTo.url);
      const said = await runSave('.orb/look', dir);
      assert.match(said, /\(2 looks left in this build: keep one for a last check and one on a phone\.\)/);
      fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Hello</title>');
      assert.match(await runSave('.orb/save', dir), /Saved to Orb \(1 files, 1 changed\)/);
      assert.deepEqual(Object.keys(saveTo.saves[0].tree), ['index.html']);
      // Even sent by hand, Orb's own files and what a look saw stay out of the world.
      const all = execFileSync('tar', ['-czf', '-', 'index.html', '.orb/look', '.orb/save', '.orb/seen/report.txt', '.orb/seen/2-end.png'], { cwd: dir });
      assert.deepEqual(Object.keys((await files.getTree(db, (await sync.readSave(db, new Response(all).body, {})).tree)) ?? {}), ['index.html']);
    } finally {
      lookAt.close();
      saveTo.close();
    }
  });

  test('a look Orb can’t read is named, like a save', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-sync-'));
    fs.mkdirSync(path.join(dir, '.orb/seen'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(dir, '.orb/seen/files'), 'index.html\nghost.js\n');
    fs.writeFileSync(path.join(dir, '.orb/seen/request'), '{}');
    const partial = execFileSync('tar', ['-czf', '-', 'index.html', '.orb/seen/files', '.orb/seen/request'], { cwd: dir });
    await assert.rejects(sync.readSave(db, new Response(partial).body, {}, { look: true }), /ghost\.js — touch it and look again/);
  });
});
