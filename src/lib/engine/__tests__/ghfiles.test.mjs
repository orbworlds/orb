// World files read from GitHub (src/server/ghfiles.ts, src/server/files.ts): a game imported from a
// public repository keeps only what GitHub doesn't serve exactly as stored, a moved file is read
// back from GitHub and checked, and files nothing uses are forgotten after two days unless stored
// again — against an in-memory PGlite with the app's own schema and a stand-in GitHub (fetch).
import { register } from 'node:module';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { DDL } from '../../../server/ddl.mjs';

register('./resolve-hooks.mjs', import.meta.url);

const F = await import('../../../server/files.ts');
const G = await import('../../../server/ghfiles.ts');

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function tarGz(top, files) {
  const blocks = [];
  for (const [path, data] of files) {
    const h = Buffer.alloc(512);
    h.write(`${top}/${path}`.slice(0, 99), 0);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

const COMMIT = 'c0ffee'.padEnd(40, '0');
const BIG = Buffer.alloc(70_000, 1); // GitHub serves it as stored
const OTHER = Buffer.alloc(70_000, 2); // GitHub serves something else (say, a Git LFS pointer)
const PAGE = Buffer.concat([Buffer.from('<!doctype html>'), Buffer.alloc(70_000, 32)]);
const SMALL = Buffer.from('a small file stays');
const RAW = `https://raw.githubusercontent.com/o/r/${COMMIT}`;
const CDN = `https://cdn.jsdelivr.net/gh/o/r@${COMMIT}`;

/** What the stand-in GitHub answers, by address. */
let site = {};
const realFetch = globalThis.fetch;
const asked = [];

describe('world files on GitHub', () => {
  let pg;
  let db;
  const old = (table, sha) => db.query(`update ${table} set created_at = now() - interval '3 days' where sha = $1`, [sha]);

  before(async () => {
    pg = new PGlite();
    await pg.waitReady;
    await pg.exec(DDL);
    db = { kind: 'pglite', query: async (text, params = []) => (await pg.query(text, params)).rows };
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      const v = site[String(url)];
      return v === undefined ? new Response('Not found', { status: 404 }) : new Response(v, { status: 200 });
    };
    site = {
      'https://github.com/o/r.git/info/refs?service=git-upload-pack': `001e# service=git-upload-pack\n00000155${COMMIT} HEAD\0multi_ack thin-pack symref=HEAD:refs/heads/main\n003f${COMMIT} refs/heads/main\n0000`,
      [`https://codeload.github.com/o/r/tar.gz/${COMMIT}`]: tarGz(`r-${COMMIT}`, [['assets/big.bin', BIG], ['assets/other.bin', OTHER], ['index.html', PAGE], ['small.txt', SMALL]]),
      [`${RAW}/assets/big.bin`]: BIG,
      [`${RAW}/assets/other.bin`]: Buffer.from('version https://git-lfs.github.com/spec/v1'),
      [`${CDN}/assets/other.bin`]: Buffer.from('version https://git-lfs.github.com/spec/v1'),
    };
    const tree = {};
    for (const [p, b] of [['assets/big.bin', BIG], ['assets/other.bin', OTHER], ['index.html', PAGE], ['small.txt', SMALL]]) tree[p] = (await F.putBlob(db, b)).sha;
    await db.query(`insert into orb_worlds (id, name, source_url, tree) values ('aw-game', 'Game', 'https://github.com/o/r', $1)`, [await F.putTree(db, tree)]);
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await pg?.close();
  });

  test('the commit a ref names, from GitHub’s git endpoint', async () => {
    assert.equal(await G.commitOf('o', 'r', null), COMMIT);
    assert.equal(await G.commitOf('o', 'r', 'main'), COMMIT);
    assert.equal(await G.commitOf('o', 'r', 'mai'), null, 'a ref that only starts the same');
    assert.equal(await G.commitOf('o', 'r', COMMIT), COMMIT, 'a commit is itself');
  });

  test('moves what GitHub serves exactly as stored; pages, small files and the rest stay', async () => {
    const moved = await G.moveToGitHub(db, 'aw-game');
    assert.deepEqual(moved, { world: 'aw-game', commit: COMMIT, files: 1, bytes: BIG.length, kept: 1 });
    const rows = await db.query(`select sha, source, octet_length(data)::int as n from orb_blobs`);
    const row = (b) => rows.find((r) => r.sha === sha256(b));
    assert.deepEqual(row(BIG), { sha: sha256(BIG), source: `o/r@${COMMIT}/assets/big.bin`, n: 0 });
    assert.equal(row(OTHER).source, null);
    assert.equal(row(OTHER).n, OTHER.length);
    assert.equal(row(PAGE).source, null);
    assert.equal(row(SMALL).source, null);
    assert.deepEqual(await G.moveToGitHub(db, 'aw-game'), { world: 'aw-game', commit: COMMIT, files: 0, bytes: 0, kept: 1 }, 'again: nothing more moves');
  });

  test('a world from no GitHub repository moves nothing', async () => {
    await db.query(`insert into orb_worlds (id, name) values ('mine', 'Mine')`);
    assert.deepEqual(await G.moveToGitHub(db, 'mine'), { world: 'mine', commit: null, files: 0, bytes: 0, kept: 0 });
  });

  test('a moved file is read from GitHub and checked: GitHub’s host, then jsDelivr; neither as stored → an error, not a wrong file', async () => {
    const data = Buffer.alloc(80_000, 7);
    const sha = sha256(data);
    await db.query(`insert into orb_blobs (sha, data, size, source) values ($1, ''::bytea, $2, $3)`, [sha, data.length, `o/r@${COMMIT}/models/a b.glb`]);
    site[`${RAW}/models/a%20b.glb`] = Buffer.from('changed');
    site[`${CDN}/models/a%20b.glb`] = data;
    assert.deepEqual(Buffer.from(await F.getBlob(db, sha)), data);
    assert.deepEqual(asked.slice(-2), [`${RAW}/models/a%20b.glb`, `${CDN}/models/a%20b.glb`]);

    const other = Buffer.alloc(80_000, 8);
    await db.query(`insert into orb_blobs (sha, data, size, source) values ($1, ''::bytea, $2, $3)`, [sha256(other), other.length, `o/r@${COMMIT}/gone.bin`]);
    await assert.rejects(() => F.getBlob(db, sha256(other)), /GitHub didn't send/);
  });

  test('files and trees nothing uses are forgotten two days on; what a world uses, or was stored lately, stays', async () => {
    const put = async (data, age) => {
      const sha = sha256(data);
      await db.query(`insert into orb_blobs (sha, data, size, created_at) values ($1, $2, $3, now() - $4::interval)`, [sha, data, data.length, age]);
      return sha;
    };
    const tree = async (files, age) => {
      const json = JSON.stringify(files);
      const sha = sha256(json);
      await db.query(`insert into orb_trees (sha, files, created_at) values ($1, $2::jsonb, now() - $3::interval)`, [sha, json, age]);
      return sha;
    };
    const stepFile = await put(Buffer.from('a build step'), '3 days');
    const step = await tree({ 'step.js': stepFile }, '3 days');
    const keptFile = await put(Buffer.from('in a world'), '3 days');
    const kept = await tree({ 'main.js': keptFile }, '3 days');
    await db.query(`insert into orb_worlds (id, name, tree) values ('kept', 'Kept', $1)`, [kept]);
    const orphan = await put(Buffer.from('an upload that never went in a world'), '3 days');
    const fresh = await put(Buffer.from('an upload a minute ago'), '1 minute');
    const again = Buffer.from('stored again today');
    const againSha = await put(again, '3 days');
    await F.putBlob(db, again);

    const pruned = await F.pruneFiles(db);
    assert.equal(pruned.trees, 1);
    const left = new Set((await db.query(`select sha from orb_blobs`)).map((r) => r.sha));
    assert.ok(!left.has(stepFile) && !left.has(orphan), 'the step’s file and the orphan are gone');
    assert.ok(left.has(keptFile) && left.has(fresh) && left.has(againSha), 'what a world uses, a fresh upload and a file stored again stay');
    assert.ok(!(await db.query(`select 1 from orb_trees where sha = $1`, [step])).length);
    assert.ok((await db.query(`select 1 from orb_trees where sha = $1`, [kept])).length);
    assert.deepEqual(await F.pruneFiles(db), { trees: 0, blobs: 0, bytes: 0 }, 'nothing more');
  });

  test('a tree stored again counts as new again', async () => {
    const file = (await F.putBlob(db, Buffer.from('tree again'))).sha;
    const sha = await F.putTree(db, { 'a.js': file });
    await old('orb_trees', sha);
    await old('orb_blobs', file);
    // This process stored it a moment ago, so it trusts that for an hour: a new process stores it again.
    const fresh = await import(`../../../server/files.ts?again=${Date.now()}`);
    assert.equal(await fresh.putTree(db, { 'a.js': file }), sha);
    assert.equal((await F.pruneFiles(db)).trees, 0);
    assert.ok((await db.query(`select 1 from orb_blobs where sha = $1`, [file])).length, 'its file stays with it');
  });
});
