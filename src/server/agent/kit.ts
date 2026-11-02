// Orb's paint kit for worlds (public/kit/paint.js, bundled from src/data/paint-kit.json by
// scripts/paint-kit.mjs): a painted storybook look for three.js. Every build gets it at KIT_PATH,
// and a world keeps it only when it uses it (dropped on save like unused photos, ./photos.ts).

import kit from '@/data/paint-kit.json';
import type { Db } from '../db';
import { putBlob, type Tree } from '../files';

export const KIT_PATH = 'orb/paint.js';
/** The kit's opening comment, in lines: its documentation, which the builder reads. */
export const KIT_HEADER_LINES = kit.source.split('\n').findIndex((l) => !l.startsWith('//'));

let stored: string | null = null;

/** The kit for a build of a world with these files: its file, unless the world has one there already. */
export async function kitFiles(db: Db, world: Tree): Promise<Tree> {
  if (world[KIT_PATH]) return {};
  stored ??= (await putBlob(db, kit.source)).sha;
  return { [KIT_PATH]: stored };
}
