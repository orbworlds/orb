// Three-way merge of text, line by line (as git does): what one side changed since `base`, put onto
// what the other side changed meanwhile. Builds of a world made together save this way
// (./agent/runner.ts: a build's changes go onto the world as it is now, whoever else changed it),
// and undoing one build takes back only its own changes (./worlds.ts undoBuild).
// Where both changed the same lines, `ours` wins; lines both added at the same place are all kept.

import type { Db } from './db';
import { getBlob, isText, mergeTrees, putBlob, type Tree } from './files';

/** Past this many changed lines, two versions are too different to merge line by line. */
const MAX_EDITS = 1000;

/** The text's lines, each with its line ending (joined, they are the text again). */
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/**
 * For each line of `a`, the line of `b` it stays as (-1: none) — the longest run of lines they
 * share, found with Myers' diff — or null when they differ in more than MAX_EDITS lines.
 */
function matched(a: readonly string[], b: readonly string[]): Int32Array | null {
  const out = new Int32Array(a.length).fill(-1);
  // The same start and end need no searching.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) out[start] = start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) out[--endA] = --endB;
  const n = endA - start;
  const m = endB - start;
  if (!n || !m) return out;
  const max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  // v[k + off]: how far along `a` the furthest path on diagonal k (x - y) has come.
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[k - 1 + off] < v[k + 1 + off]) ? v[k + 1 + off] : v[k - 1 + off] + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++;
        y++;
      }
      v[k + off] = x;
      if (x < n || y < m) continue;
      // The end: walk the path back, keeping the lines it goes along unchanged.
      for (let back = d; back >= 0; back--) {
        const was = trace[back];
        const kk = x - y;
        const prevK = kk === -back || (kk !== back && was[kk - 1 + off] < was[kk + 1 + off]) ? kk + 1 : kk - 1;
        const prevX = was[prevK + off];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) out[start + --x] = start + --y;
        x = prevX;
        y = prevY;
      }
      return out;
    }
  }
  return null;
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((s, i) => s === b[i]);

/**
 * `ours` and `theirs`, both changed from `base`, as one text: each side's changes kept, `ours` where
 * both changed the same lines (`conflicts` counts those places). Null when a side changed too much
 * to merge line by line.
 */
export function merge3(base: string, ours: string, theirs: string): { text: string; conflicts: number } | null {
  if (ours === theirs || theirs === base) return { text: ours, conflicts: 0 };
  if (ours === base) return { text: theirs, conflicts: 0 };
  const o = lines(base);
  const a = lines(ours);
  const b = lines(theirs);
  const toA = matched(o, a);
  const toB = matched(o, b);
  if (!toA || !toB) return null;
  const out: string[] = [];
  let conflicts = 0;
  let io = 0;
  let ia = 0;
  let ib = 0;
  for (;;) {
    // Lines neither side changed.
    while (io < o.length && toA[io] === ia && toB[io] === ib) {
      out.push(o[io++]);
      ia++;
      ib++;
    }
    // Up to the next line both kept: what each side made of the lines between.
    let j = io;
    while (j < o.length && (toA[j] < 0 || toB[j] < 0)) j++;
    const ja = j < o.length ? toA[j] : a.length;
    const jb = j < o.length ? toB[j] : b.length;
    const was = o.slice(io, j);
    const mine = a.slice(ia, ja);
    const theirsNow = b.slice(ib, jb);
    if (same(mine, was)) out.push(...theirsNow);
    else if (same(theirsNow, was) || same(mine, theirsNow)) out.push(...mine);
    else if (!was.length) out.push(...theirsNow, ...mine);
    else {
      out.push(...mine);
      conflicts++;
    }
    if (j >= o.length) break;
    io = j;
    ia = ja;
    ib = jb;
  }
  return { text: out.join(''), conflicts };
}

/** Text files bigger than this (the three versions together) are merged by file: ours wins. */
const MERGE_BYTES = 3_000_000;

/** mergeTrees (./files.ts), with each text file both sides changed merged line by line (merge3). */
export async function mergeWorldTrees(db: Db, base: Tree, ours: Tree, theirs: Tree): Promise<Tree> {
  const out = mergeTrees(base, ours, theirs);
  const both = Object.keys(ours).filter((p) => base[p] && theirs[p] && ours[p] !== base[p] && theirs[p] !== base[p] && ours[p] !== theirs[p]);
  await Promise.all(
    both.map(async (p) => {
      const [b, o, t] = await Promise.all([getBlob(db, base[p]), getBlob(db, ours[p]), getBlob(db, theirs[p])]);
      if (!b || !o || !t || b.length + o.length + t.length > MERGE_BYTES || ![b, o, t].every(isText)) return;
      const text = new TextDecoder();
      const merged = merge3(text.decode(b), text.decode(o), text.decode(t));
      if (merged) out[p] = (await putBlob(db, merged.text)).sha;
    }),
  );
  return out;
}
