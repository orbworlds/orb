// Cursor agents (the free builder on Orb's own Cursor key, see ../ai.ts, or a person's own key): the
// agent's workspace is the world. It downloads the world's files from Orb and saves its work back
// over HTTPS, through a link that works for this one job only, and only while the job runs
// (/api/agent/jobs/:id/files):
// - GET: the files as a .tar.gz, plus .orb/save — a little shell script the agent runs after each
//   visible improvement (only when the job may change the world) — and .orb/sums, the files'
//   sha256 as downloaded (Cursor's file tools keep a file's modification time, so changes are
//   found by content);
// - PUT (what .orb/save sends): the files whose contents changed since the download plus the list
//   of all files (.orb/files). With the downloaded tree's unchanged files that makes the world's
//   new tree, so big worlds save in small requests. It lands in orb_agent_jobs.inbox, and the
//   job's tick takes it from there like a push to GitHub: a live preview, then a saved version.
// - POST …/files/look (what .orb/look sends): the files the same way, and what to do first, to see
//   them run in the person's browser without saving them (./look.ts). The answer — a report and
//   the screenshots — lands in .orb/seen/.

import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createGunzip, createGzip, gzipSync } from 'node:zlib';
import { isJobId } from '../buildjobs';
import type { Db } from '../db';
import { cleanPath, FILE_LIMITS, FileError, getBlob, putBlob, putTree, type Tree } from '../files';
import { SKIP_DIR, untar } from '../importer';
import { ready } from '../schema';
import { SEEN_DIR } from './look';
import { checkJobToken, jobToken } from './secrets';

/** The job's files link (saving adds the tree the download came from). */
export const filesUrl = (origin: string, id: string): string => `${origin}/api/agent/jobs/${encodeURIComponent(id)}/files?t=${jobToken('files', id)}`;
/** Where the job's agent looks at the world (with the tree the download came from, like a save). */
export const lookUrl = (origin: string, id: string): string => `${origin}/api/agent/jobs/${encodeURIComponent(id)}/files/look?t=${jobToken('files', id)}`;

/** Orb's answer for the agent's terminal, in plain words. */
export const sayText = (status: number, text: string): Response =>
  new Response(`${text}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

export interface LinkedJob {
  status: string;
  mode: string;
  tree: string | null;
  inbox: string | null;
}

/** The running job a files link (`t`: its token) is for — or what to answer instead. */
export async function linkedJob(req: Request, id: string): Promise<{ answer: Response } | { db: Db; job: LinkedJob }> {
  if (!isJobId(id) || !checkJobToken('files', id, new URL(req.url).searchParams.get('t'))) return { answer: sayText(404, 'No such build.') };
  const db = await ready();
  const job = (await db.query<LinkedJob>(`select status, mode, tree, inbox from orb_agent_jobs where id = $1`, [id]))[0];
  if (!job) return { answer: sayText(404, 'No such build.') };
  if (job.status !== 'running') return { answer: sayText(410, 'This build is over: nothing more is saved.') };
  return { db, job };
}

// -- download -----------------------------------------------------------------------------------

/** Every file in a download gets this date (2000-01-01), so the same files make the same archive. */
const FILE_TIME = 946_684_800;
/** The save and look mechanism's own files: never part of the world. */
const OWN = new Set(['.orb/save', '.orb/look', '.orb/sums', '.orb/files', '.orb/changed']);
export const isSaveFile = (path: string) => OWN.has(path) || path.startsWith(`${SEEN_DIR}/`);
/** What the scripts leave out of the world (grep -E): git, node_modules and the files above. */
const SKIP = `(^|/)(\\.git|node_modules)/|^\\.orb/(save|look|sums|files|changed)$|^${SEEN_DIR.replaceAll('.', '\\.')}/`;

const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);

function header(name: string, size: number, mode: number, mtime: number, type = '0'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write(`${mtime.toString(8).padStart(11, '0')}\0`, 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

function* tarEntry(path: string, data: Buffer, mode: number, mtime: number): Generator<Buffer> {
  const name = Buffer.from(path, 'utf8');
  if (name.length >= 100) {
    // GNU long name: the real path comes first, as its own entry.
    yield header('././@LongLink', name.length + 1, 0o644, 0, 'L');
    yield Buffer.concat([name, Buffer.alloc(1)]);
    yield pad(name.length + 1);
  }
  yield header(path.slice(0, 99), data.length, mode, mtime);
  yield data;
  yield pad(data.length);
}

/**
 * .orb/save: sends the files whose sha256 isn't in .orb/sums (changed or new) and the list of all
 * files; prints Orb's answer. Without .orb/sums everything counts as changed.
 */
export function saveScript(url: string): string {
  return `#!/bin/sh
# Saves this world to Orb: run "sh .orb/save" in the world's folder after each visible improvement.
# It sends the files changed since the download plus the list of all files, and prints Orb's answer.
cd "$(dirname "$0")/.." || exit 1
sleep 1 # file edits made in parallel with this land first
[ -f .orb/sums ] || : > .orb/sums
skip() { grep -v -E '${SKIP}'; }
find . -type f | sed 's|^\\./||' | skip | sort > .orb/files
tr '\\n' '\\0' < .orb/files | xargs -0 -r sha256sum | grep -v -x -F -f .orb/sums | sed 's/^[0-9a-f]*  //' > .orb/changed
tar -czf - -T .orb/changed .orb/files | curl -sS --retry 2 --max-time 120 -X PUT -H 'content-type: application/gzip' --data-binary @- -w '\\n' '${url}'
`;
}

/** Inside a look's upload: the list of all files, and what to do first (JSON). */
export const LOOK_LIST = `${SEEN_DIR}/files`;
export const LOOK_REQUEST = `${SEEN_DIR}/request`;

/**
 * .orb/look: sends the files the way .orb/save does, with what to do first (its argument: JSON, or
 * a file holding it), for Orb to run in the person's browser — without saving them. It unpacks the
 * answer in .orb/seen/ (report.txt and the screenshots) and prints the report, or Orb's few words.
 */
export function lookScript(url: string): string {
  return `#!/bin/sh
# Shows you the world in the person's browser, running the files in this folder (without saving them):
#   sh .orb/look                                        how it looks right now
#   sh .orb/look '{"actions":[…],"viewport":"phone"}'   play it first (or give a file with that JSON)
# It prints what the browser saw and puts the screenshots in ${SEEN_DIR}/ — open them to see them.
cd "$(dirname "$0")/.." || exit 1
sleep 1 # file edits made in parallel with this land first
request=$(if [ -n "$1" ] && [ -f "$1" ]; then cat "$1"; else printf '%s' "$*"; fi)
rm -rf ${SEEN_DIR} && mkdir -p ${SEEN_DIR} || exit 1
printf '%s' "$request" > ${LOOK_REQUEST}
[ -f .orb/sums ] || : > .orb/sums
skip() { grep -v -E '${SKIP}'; }
find . -type f | sed 's|^\\./||' | skip | sort > ${LOOK_LIST}
tr '\\n' '\\0' < ${LOOK_LIST} | xargs -0 -r sha256sum | grep -v -x -F -f .orb/sums | sed 's/^[0-9a-f]*  //' > ${SEEN_DIR}/changed
type=$(tar -czf - -T ${SEEN_DIR}/changed ${LOOK_LIST} ${LOOK_REQUEST} | curl -sS --max-time 180 -X POST -H 'content-type: application/gzip' --data-binary @- -o ${SEEN_DIR}/answer -w '%{content_type}' '${url}') || exit 1
cd ${SEEN_DIR} && rm -f files changed request
if [ "$type" = application/gzip ]; then tar -xzf answer && rm answer && cat report.txt; else cat answer && rm answer; fi
`;
}

/** The world's files as a .tar.gz for the agent's workspace, with .orb/save and .orb/look when it may change the world. */
export function packWorld(db: Db, files: Tree, links: { save: string; look: string } | null): ReadableStream<Uint8Array> {
  async function* entries(): AsyncGenerator<Buffer> {
    const sums: string[] = [];
    for (const path of Object.keys(files).sort()) {
      if (isSaveFile(path)) continue;
      const bytes = await getBlob(db, files[path]);
      if (!bytes) continue;
      yield* tarEntry(path, Buffer.from(bytes), 0o644, FILE_TIME);
      sums.push(`${files[path]}  ${path}\n`); // a blob's sha is the sha256 of its bytes, as sha256sum prints it
    }
    if (links) {
      yield* tarEntry('.orb/sums', Buffer.from(sums.join('')), 0o644, FILE_TIME);
      yield* tarEntry('.orb/save', Buffer.from(saveScript(links.save)), 0o755, FILE_TIME);
      yield* tarEntry('.orb/look', Buffer.from(lookScript(links.look)), 0o755, FILE_TIME);
    }
    yield Buffer.alloc(1024);
  }
  return Readable.toWeb(Readable.from(entries()).pipe(createGzip())) as unknown as ReadableStream<Uint8Array>;
}

/** What a look saw (./look.ts seenFiles), as a .tar.gz the agent unpacks in .orb/seen/. */
export function packSeen(files: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) parts.push(...tarEntry(f.name, f.data, 0o644, FILE_TIME));
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

// -- save ---------------------------------------------------------------------------------------

/** Compressed bytes of one save (the hosting platform's own request limit is lower). */
const MAX_SAVE = 40_000_000;
/** Characters of what a look is asked to do first (30 actions with a little JavaScript fit easily). */
const MAX_REQUEST = 200_000;

/** A path of the world (not .git, node_modules or the save mechanism), cleaned; null otherwise. */
function worldPath(raw: string): string | null {
  const p = cleanPath(raw);
  return p && !isSaveFile(p) && !SKIP_DIR.test(p) ? p : null;
}

export interface Saved {
  tree: string;
  files: number;
  /** Files whose contents came with this save. */
  changed: number;
  /** Whether the world has its page (index.html). */
  entry: boolean;
  /** A look's: what to do first, as sent. */
  request?: string;
}

/**
 * A save (a .tar.gz from .orb/save: changed files + .orb/files, or simply all the files) on top of
 * the tree the agent downloaded → the world's new tree. A look's upload (`look`) has its list of
 * files and its request in .orb/seen/ instead.
 */
export async function readSave(db: Db, body: ReadableStream<Uint8Array>, base: Tree, opts: { look?: boolean } = {}): Promise<Saved> {
  const listName = opts.look ? LOOK_LIST : '.orb/files';
  let request: string | undefined;
  let size = 0;
  const gz = createGunzip();
  const raw = Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>);
  raw
    .on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_SAVE) raw.destroy(new FileError('That save is too big.'));
    })
    .on('error', (e) => gz.destroy(e))
    .pipe(gz);
  const uploaded = new Map<string, Buffer>();
  let list: string[] | null = null;
  let total = 0;
  try {
    for await (const e of untar(gz)) {
      const name = e.path.replace(/^(\.\/)+/, '');
      if (name === listName) {
        list = e.data.toString('utf8').split('\n');
        continue;
      }
      if (opts.look && name === LOOK_REQUEST) {
        request = e.data.toString('utf8').slice(0, MAX_REQUEST);
        continue;
      }
      const p = worldPath(name);
      if (!p) continue;
      if (e.data.length > FILE_LIMITS.file) throw new FileError(`${p} is too big (over ${FILE_LIMITS.file / 1e6} MB).`);
      total += e.data.length;
      if (total > FILE_LIMITS.total) throw new FileError(`The world would be too big (over ${FILE_LIMITS.total / 1e6} MB of files).`);
      uploaded.set(p, e.data);
    }
  } catch (e) {
    if (e instanceof FileError) throw e;
    throw new FileError("That isn't a .tar.gz of the world's files.");
  }
  const paths = list ? list.map(worldPath).filter((p): p is string => !!p) : [...uploaded.keys()];
  const tree: Tree = {};
  const missing: string[] = [];
  let changed = 0;
  for (const p of paths) {
    if (tree[p]) continue;
    const bytes = uploaded.get(p);
    if (bytes) {
      tree[p] = (await putBlob(db, bytes)).sha;
      changed++;
    } else if (base[p]) tree[p] = base[p];
    else missing.push(p);
  }
  if (missing.length) {
    const them = missing.length > 1 ? 'them' : 'it';
    throw new FileError(`Orb didn't get the contents of ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' and more' : ''} — touch ${them} and ${opts.look ? 'look' : 'save'} again.`);
  }
  return { tree: await putTree(db, tree), files: Object.keys(tree).length, changed, entry: 'index.html' in tree, ...(request !== undefined ? { request } : {}) };
}
