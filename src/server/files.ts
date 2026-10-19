// Multi-file worlds: content-addressed storage.
//
// - A blob is a file's bytes, keyed by sha256 (orb_blobs). Identical files are stored once.
// - A tree is a manifest { "path/to/file.js": blobSha } keyed by the sha256 of its canonical JSON
//   (orb_trees). Trees and blobs are immutable, so they cache forever.
// - A world with files points at its current tree (orb_worlds.tree; each version keeps its own),
//   and `orb_worlds.code` mirrors the tree's index.html (the page the world frame runs, with a
//   <base> pointing at /api/tree/<sha>/ so relative modules and assets load from the tree).
//
// A tree sha is a read capability (it can't be guessed without knowing every file), which is how
// private worlds' files stay private while still loading inside the opaque-origin world frame.

import { createHash } from 'node:crypto';
import type { Db } from './db';

export const ENTRY = 'index.html';

export const FILE_LIMITS = {
  /** One file. */
  file: 8_000_000,
  /** All files of a world. */
  total: 80_000_000,
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

const TEXT_EXT = /\.(html?|m?js|cjs|jsx?|tsx?|css|json|map|txt|md|csv|xml|svg|glsl|vert|frag|wgsl|obj|mtl|gltf|yml|yaml|toml|ini|sh|py|gitignore|license|vue|svelte)$/i;

/** Whether a file should be treated as editable text (by extension, else by sniffing). */
export function isText(path: string, data?: Uint8Array): boolean {
  if (TEXT_EXT.test(path) || !/\.[^/]+$/.test(path)) {
    if (!data) return true;
  } else if (!data) return false;
  // Sniff: no NUL bytes in the first 8 KB and valid UTF-8.
  const head = data!.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head.length < data!.length ? head.subarray(0, lastBoundary(head)) : head);
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

// -- blobs --------------------------------------------------------------------------------------

function asBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string' && v.startsWith('\\x')) return Uint8Array.from(Buffer.from(v.slice(2), 'hex'));
  throw new Error('unexpected blob value');
}

/** Store bytes (or text) and return their sha. */
export async function putBlob(db: Db, data: Uint8Array | string): Promise<{ sha: string; size: number }> {
  const bytes = toBytes(data);
  if (bytes.length > FILE_LIMITS.file) throw new FileError(`That file is too big (over ${Math.round(FILE_LIMITS.file / 1e6)} MB).`);
  const sha = sha256(bytes);
  if (!blobCache.get(sha)) {
    await db.query(`insert into orb_blobs (sha, data, size) values ($1, $2, $3) on conflict (sha) do nothing`, [sha, Buffer.from(bytes), bytes.length]);
    blobCache.set(sha, bytes, bytes.length);
  }
  return { sha, size: bytes.length };
}

export async function getBlob(db: Db, sha: string): Promise<Uint8Array | null> {
  const hit = blobCache.get(sha);
  if (hit) return hit;
  const rows = await db.query<{ data: unknown }>(`select data from orb_blobs where sha = $1`, [sha]);
  if (!rows[0]) return null;
  const bytes = asBytes(rows[0].data);
  blobCache.set(sha, bytes, bytes.length);
  return bytes;
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

/** The id a tree gets when stored (sha256 of its canonical manifest JSON). */
export const treeSha = (tree: Tree): string => sha256(canonical(tree));

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
  if (treeCache.get(sha)) return sha;
  const exists = await db.query(`select 1 from orb_trees where sha = $1`, [sha]);
  if (!exists.length) {
    const sizes = await blobSizes(db, Object.values(tree));
    let total = 0;
    for (const [p, b] of Object.entries(tree)) {
      const s = sizes.get(b);
      if (s === undefined) throw new Error(`missing blob for ${p}`);
      total += s;
    }
    if (total > FILE_LIMITS.total) throw new FileError(`This world would be too big (over ${Math.round(FILE_LIMITS.total / 1e6)} MB of files).`);
    await db.query(`insert into orb_trees (sha, files, size, count) values ($1, $2::jsonb, $3, $4) on conflict (sha) do nothing`, [sha, json, total, paths.length]);
  }
  treeCache.set(sha, JSON.parse(json) as Tree, 1);
  return sha;
}

export async function getTree(db: Db, sha: string): Promise<Tree | null> {
  if (!isSha(sha)) return null;
  const hit = treeCache.get(sha);
  if (hit) return hit;
  const rows = await db.query<{ files: Tree | string }>(`select files from orb_trees where sha = $1`, [sha]);
  if (!rows[0]) return null;
  const files = typeof rows[0].files === 'string' ? (JSON.parse(rows[0].files) as Tree) : rows[0].files;
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
