// Orb's kits for worlds (public/kit/*.js, bundled into src/data/kits.json by scripts/kits.mjs):
// ready-made looks for three.js — a painted storybook look (orb/paint.js) and nature with
// cinematic light (orb/nature.js). Every build gets them, and a world keeps a kit only when it uses
// it (dropped on save like unused photos, ./photos.ts).

import kits from '@/data/kits.json';
import type { Db } from '../db';
import { putBlob, type Tree } from '../files';

/** Each kit's path in a world, and its source. */
export const KITS: Readonly<Record<string, string>> = kits;

/** A kit's opening comment, in lines: its documentation, which the builder reads. */
export const kitHeaderLines = (path: string): number => (KITS[path] ?? '').split('\n').findIndex((l) => !l.startsWith('//'));

const stored = new Map<string, string>();

/** The kits for a build of a world with these files: each kit's file, unless the world has one there already. */
export async function kitFiles(db: Db, world: Tree): Promise<Tree> {
  const out: Tree = {};
  for (const [path, source] of Object.entries(KITS)) {
    if (world[path]) continue;
    if (!stored.has(path)) stored.set(path, (await putBlob(db, source)).sha);
    out[path] = stored.get(path)!;
  }
  return out;
}
