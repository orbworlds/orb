// Multi-file worlds: content-addressed storage.
//
// - A blob is a file's bytes, keyed by sha256 (orb_blobs). Identical files are stored once. The
//   bytes of a game imported from a public GitHub repository (and its remixes) can stay there:
//   `source` names the file at the commit it came from, it is read from GitHub (checked against
//   its sha) and the database keeps no copy (./ghfiles.ts moves them).
// - Files and trees nothing points at any more (a build's steps, an upload that never went in a
//   world) can be forgotten two days on (pruneFiles, from the lab); storing one again makes it new.
// - A tree is a manifest { "path/to/file.js": blobSha } keyed by the sha256 of its canonical JSON
//   (orb_trees). Trees and blobs are immutable, so they cache forever.
// - A world with files points at its current tree (orb_worlds.tree; each version keeps its own),
//   and `orb_worlds.code` mirrors the tree's index.html (the page the world frame runs, with a
//   <base> pointing at /api/tree/<sha>/ so relative modules and assets load from the tree).
//
// A tree sha is a read capability (it can't be guessed without knowing every file), which is how
// private worlds' files stay private while still loading inside the opaque-origin world frame.

import { createHash } from 'node:crypto';
import { SITE } from '../lib/site';
import type { Db } from './db';

export const ENTRY = 'index.html';

export const FILE_LIMITS = {
  /** One file (big ones stream out of /api/tree, past Vercel's 4.5 MB response cap). */
  file: 10_000_000,
  /** All files of a world (open-source games with their models, like Long Wind's 130 MB). */
  total: 200_000_000,
  files: 5000,
  path: 300,
} as const;

export type Tree = Record<string, string>;

const SHA_RE = /^[a-f0-9]{64}$/;
export const isSha = (s: unknown): s is string => typeof s === 'string' && SHA_RE.test(s);

export const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

const enc = new TextEncoder();
const toBytes = (data: Uint8Array | string): Uint8Array => (typeof data === 'string' ? enc.encode(data) : data);

// -- paths ------------------------------------------------------------------------------------

const SEGMENT_RE = /^[\w@+~()\-. ]+$/;

/** Normalize a relative file path ("./src//a.js" → "src/a.js"); null if it isn't a safe one. */
export function cleanPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.trim().replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
  if (!p || p.length > FILE_LIMITS.path) return null;
  const parts = p.split('/');
  if (parts.length > 24) return null;
  for (const s of parts) {
    if (s === '.' || s === '..' || !SEGMENT_RE.test(s) || s.trim() !== s) return null;
  }
  return p;
}

// -- content types ----------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  ktx2: 'image/ktx2',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'text/plain; charset=utf-8',
  mtl: 'text/plain; charset=utf-8',
  hdr: 'application/octet-stream',
  glsl: 'text/plain; charset=utf-8',
  vert: 'text/plain; charset=utf-8',
  frag: 'text/plain; charset=utf-8',
  wgsl: 'text/plain; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
  jsx: 'text/plain; charset=utf-8',
};

export function contentType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return TYPES[ext] ?? 'application/octet-stream';
}

/** Whether bytes are text: no NUL in the first 8 KB, and valid UTF-8. */
export function isText(data: Uint8Array): boolean {
  const head = data.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head.length < data.length ? head.subarray(0, lastBoundary(head)) : head);
    return true;
  } catch {
    return false;
  }
}

/** Index up to which a byte slice ends on a UTF-8 character boundary. */
function lastBoundary(b: Uint8Array): number {
  let i = b.length;
  for (let k = 0; k < 4 && i > 0; k++) {
    const c = b[i - 1];
    if ((c & 0xc0) !== 0x80) {
      // c starts a character: is it complete?
      const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
      return b.length - (i - 1) >= need ? b.length : i - 1;
    }
    i--;
  }
  return b.length;
}

// -- caches (trees and blobs never change) ------------------------------------------------------

class Lru<V> {
  private readonly map = new Map<string, { v: V; size: number }>();
  private total = 0;
  private readonly maxSize: number;
  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }
  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }
  set(k: string, v: V, size = 1): void {
    if (size > this.maxSize / 4) return;
    const old = this.map.get(k);
    if (old) {
      this.total -= old.size;
      this.map.delete(k);
    }
    this.map.set(k, { v, size });
    this.total += size;
    for (const [key, e] of this.map) {
      if (this.total <= this.maxSize) break;
      this.map.delete(key);
      this.total -= e.size;
    }
  }
}

const treeCache = new Lru<Tree>(400);
const blobCache = new Lru<Uint8Array>(48_000_000);

/** Trees and blobs this process stored (or found stored) in the last hour: not written again. Older ones are, as pruneFiles may have forgotten them since. */
const storedAt = new Map<string, number>();
const STORED_FOR = 3_600_000;
const storedLately = (key: string): boolean => Date.now() - (storedAt.get(key) ?? 0) < STORED_FOR;
function markStored(key: string): void {
  storedAt.delete(key);
  storedAt.set(key, Date.now());
  if (storedAt.size > 50_000) for (const k of storedAt.keys()) if (storedAt.delete(k) && storedAt.size <= 40_000) break;
}

// -- blobs --------------------------------------------------------------------------------------

/** Store bytes (or text) and return their sha. A file stored before counts as new again (pruneFiles keeps it). */
export async function putBlob(db: Db, data: Uint8Array | string): Promise<{ sha: string; size: number }> {
  const bytes = toBytes(data);
  if (bytes.length > FILE_LIMITS.file) throw new FileError(`That file is too big (over ${Math.round(FILE_LIMITS.file / 1e6)} MB).`);
  const sha = sha256(bytes);
  if (!storedLately(`b:${sha}`)) {
    // A big file already stored (an import tried again) isn't sent to the database again.
    const kept = bytes.length > 256_000 ? (await db.query(`update orb_blobs set created_at = now() where sha = $1 returning sha`, [sha])).length > 0 : false;
    if (!kept) {
      await db.query(
        `insert into orb_blobs (sha, data, size) values ($1, $2, $3)
         on conflict (sha) do update set created_at = now() where orb_blobs.created_at < now() - interval '1 day'`,
        [sha, Buffer.from(bytes), bytes.length],
      );
    }
    markStored(`b:${sha}`);
    blobCache.set(sha, bytes, bytes.length);
  }
  return { sha, size: bytes.length };
}

export async function getBlob(db: Db, sha: string): Promise<Uint8Array | null> {
  const hit = blobCache.get(sha);
  if (hit) return hit;
  const rows = await db.query<{ data: Uint8Array; source: string | null }>(`select data, source from orb_blobs where sha = $1`, [sha]);
  if (!rows[0]) return null;
  const bytes = rows[0].source ? await sourceBytes(rows[0].source, sha) : rows[0].data;
  if (!bytes) throw new Error(`GitHub didn't send ${rows[0].source}`);
  blobCache.set(sha, bytes, bytes.length);
  return bytes;
}

const GITHUB_RAW = process.env.ORB_GITHUB_RAW || 'https://raw.githubusercontent.com'; // overridable for tests
const JSDELIVR = process.env.ORB_JSDELIVR || 'https://cdn.jsdelivr.net/gh';
const SOURCE_RE = /^([\w.-]+)\/([\w.-]+)@([0-9a-f]{40})\/(.+)$/;

/** Where a file of a public GitHub repository can be read: "owner/repo@commit/path" → GitHub's own file host, then jsDelivr's. */
export function sourceUrls(source: string): string[] {
  const m = SOURCE_RE.exec(source);
  if (!m) return [];
  const [, owner, repo, commit, path] = m;
  const p = path.split('/').map(encodeURIComponent).join('/');
  return [`${GITHUB_RAW}/${owner}/${repo}/${commit}/${p}`, `${JSDELIVR}/${owner}/${repo}@${commit}/${p}`];
}

/** A file's bytes from GitHub, exactly as stored (its sha), or null when neither host has them so. */
export async function sourceBytes(source: string, sha: string): Promise<Uint8Array | null> {
  for (const url of sourceUrls(source)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'user-agent': `Orb (+${SITE})` } });
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (sha256(bytes) === sha) return bytes;
    } catch {
      /* the next host */
    }
  }
  return null;
}

export async function getText(db: Db, sha: string): Promise<string | null> {
  const b = await getBlob(db, sha);
  return b ? new TextDecoder().decode(b) : null;
}

export async function blobSizes(db: Db, shas: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(shas)];
  for (let i = 0; i < unique.length; i += 1000) {
    const rows = await db.query<{ sha: string; size: number }>(`select sha, size from orb_blobs where sha = any($1::text[])`, [unique.slice(i, i + 1000)]);
    for (const r of rows) out.set(r.sha, Number(r.size));
  }
  return out;
}

// -- trees --------------------------------------------------------------------------------------

export class FileError extends Error {}

function canonical(tree: Tree): string {
  const sorted: Tree = {};
  for (const k of Object.keys(tree).sort()) sorted[k] = tree[k];
  return JSON.stringify(sorted);
}

/** Store a manifest (its blobs must exist) and return its sha. Enforces the size limits. */
export async function putTree(db: Db, tree: Tree): Promise<string> {
  const paths = Object.keys(tree);
  if (paths.length > FILE_LIMITS.files) throw new FileError(`Too many files (max ${FILE_LIMITS.files}).`);
  const json = canonical(tree);
  const sha = sha256(json);
  if (storedLately(`t:${sha}`)) return sha;
  // Stored before: it counts as new again (pruneFiles keeps it).
  const exists = await db.query(`update orb_trees set created_at = now() where sha = $1 returning sha`, [sha]);
  if (!exists.length) {
    // One size per blob: a file at two paths is stored once.
    const sizes = await blobSizes(db, Object.values(tree));
    for (const [p, b] of Object.entries(tree)) if (!sizes.has(b)) throw new Error(`missing blob for ${p}`);
    const total = [...sizes.values()].reduce((n, size) => n + size, 0);
    if (total > FILE_LIMITS.total) throw new FileError(`This world would be too big (over ${Math.round(FILE_LIMITS.total / 1e6)} MB of files).`);
    await db.query(`insert into orb_trees (sha, files, size, count) values ($1, $2::jsonb, $3, $4) on conflict (sha) do update set created_at = now()`, [sha, json, total, paths.length]);
  }
  treeCache.set(sha, JSON.parse(json) as Tree, 1);
  markStored(`t:${sha}`);
  return sha;
}

/** What points at trees: worlds, their kept versions, builds and GitHub syncs. */
const LIVE_TREES = `select tree as sha from orb_worlds where tree is not null
  union select tree from orb_world_versions where tree is not null
  union select unnest(array[base_tree, tree, committed_tree, saved_tree]) from orb_agent_jobs
  union select synced_tree from orb_world_repos where synced_tree is not null`;

/**
 * Forget trees nothing points at and files no tree has, two days after they were last stored (a
 * build in progress points at its own; an upload goes in a world within minutes). At most `limit`
 * of each per call. The age is checked on the row itself, so one stored again meanwhile stays.
 */
export async function pruneFiles(db: Db, limit = 1000): Promise<{ trees: number; blobs: number; bytes: number }> {
  const trees = await db.query(
    `delete from orb_trees t where t.created_at < now() - interval '2 days' and t.sha in (
       select x.sha from orb_trees x where x.created_at < now() - interval '2 days' and not exists (select 1 from (${LIVE_TREES}) l where l.sha = x.sha) limit $1)
     returning t.sha`,
    [limit],
  );
  const blobs = await db.query<{ size: number }>(
    `with used as (select distinct f.value as sha from orb_trees t, jsonb_each_text(t.files) as f)
     delete from orb_blobs b where b.created_at < now() - interval '2 days' and b.sha in (
       select x.sha from orb_blobs x where x.created_at < now() - interval '2 days' and not exists (select 1 from used u where u.sha = x.sha) limit $1)
     returning b.size`,
    [limit],
  );
  return { trees: trees.length, blobs: blobs.length, bytes: blobs.reduce((n, r) => n + Number(r.size), 0) };
}

export async function getTree(db: Db, sha: string): Promise<Tree | null> {
  if (!isSha(sha)) return null;
  const hit = treeCache.get(sha);
  if (hit) return hit;
  const rows = await db.query<{ files: Tree }>(`select files from orb_trees where sha = $1`, [sha]);
  if (!rows[0]) return null;
  const files = rows[0].files;
  treeCache.set(sha, files, 1);
  return files;
}

/** A one-file tree holding a single-file world's page. */
export async function treeFromCode(db: Db, code: string): Promise<string> {
  const { sha } = await putBlob(db, code);
  return putTree(db, { [ENTRY]: sha });
}

/** The entry page of a tree (empty if it has none). */
export async function entryOf(db: Db, tree: Tree): Promise<string> {
  const sha = tree[ENTRY];
  return sha ? ((await getText(db, sha)) ?? '') : '';
}

/**
 * Three-way merge by file: the changes from `base` to `ours` applied on top of `theirs` (the
 * world's tree now, which may have moved on while an agent worked). A file both sides changed
 * takes our version.
 */
export function mergeTrees(base: Tree, ours: Tree, theirs: Tree): Tree {
  const out: Tree = { ...theirs };
  for (const p of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    if (base[p] === ours[p]) continue;
    if (ours[p] === undefined) delete out[p];
    else out[p] = ours[p];
  }
  return out;
}
