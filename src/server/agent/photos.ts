// Photos and a video a person attaches to a message (src/lib/photos.ts). The AI sees them (a video
// as a few of its frames: it can't watch one). In a build they are also among the world's files
// (photos/<id>.<ext>, videos/<id>.<ext> when the video was small enough to send, ../uploads.ts), for
// when the person wants one in the world — a picture on a wall, a poster, a texture, a video on a
// screen — and one the world doesn't use is left out whenever the build saves (./runner.ts), so
// what was only shown for reference never becomes part of the world.

import type { FilePart } from 'ai';
import { imagePart } from '@/lib/engine/prompt';
import type { BuildVideo } from '@/lib/types';
import type { Db } from '../db';
import { blobSizes, getBlob, getTree, isText, putBlob, putTree, type Tree } from '../files';

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
/** Text files bigger than this aren't searched for a photo's name. */
const SEARCH_MAX = 2_000_000;

export interface BuildPhotos {
  /** What the AI sees. */
  parts: FilePart[];
  /** Where they are in the world's files (builds only). */
  paths: string[];
  files: Tree;
}

/** The photos as the AI's image parts and, for a build, as world files. */
export async function buildPhotos(db: Db, dataUrls: string[], intoWorld: boolean): Promise<BuildPhotos> {
  const out: BuildPhotos = { parts: [], paths: [], files: {} };
  for (const url of dataUrls) {
    const part = imagePart(url);
    if (!part) continue;
    out.parts.push(part);
    if (!intoWorld) continue;
    const { sha } = await putBlob(db, Buffer.from(part.data as string, 'base64'));
    const path = `photos/${sha.slice(0, 10)}.${EXT[part.mediaType] ?? 'jpg'}`;
    if (out.files[path]) continue;
    out.files[path] = sha;
    out.paths.push(path);
  }
  return out;
}

/** What the request says about its photos, for the AI. */
export function photoNote(photos: BuildPhotos): string {
  const one = photos.parts.length === 1;
  const seen = `(I attached ${one ? 'a photo' : `${photos.parts.length} photos`}: you can see ${one ? 'it' : 'them'} here.`;
  if (!photos.paths.length) return `${seen})`;
  return `${seen} ${one ? 'It is' : 'They are'} also in the world's files: ${photos.paths.join(', ')}. Use ${one ? 'it' : 'them'} in the world, by that path, only when I ask for it (e.g. as a picture, a poster or a texture); a photo the world doesn't use is left out when it's saved.)`;
}

const VIDEO_EXT: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

/** A video as the AI's image parts (its frames) and, for a build, its file among the world's files. */
export async function buildVideo(db: Db, v: BuildVideo, intoWorld: boolean): Promise<BuildPhotos & { seconds: number }> {
  const out: BuildPhotos & { seconds: number } = { parts: [], paths: [], files: {}, seconds: v.seconds };
  for (const f of v.frames) {
    const part = imagePart(f);
    if (part) out.parts.push(part);
  }
  if (intoWorld && v.file && (await blobSizes(db, [v.file.sha])).has(v.file.sha)) {
    const path = `videos/${v.file.sha.slice(0, 10)}.${VIDEO_EXT[v.file.type] ?? 'mp4'}`;
    out.files[path] = v.file.sha;
    out.paths.push(path);
  }
  return out;
}

/** What the request says about its video, for the AI. */
export function videoNote(v: BuildPhotos & { seconds: number }): string {
  const s = Math.round(v.seconds);
  const long = s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
  const seen = `(I attached a video, ${long} long: you can see ${v.parts.length} frames from it here, from its start to its end, as I can't send the video itself.`;
  if (!v.paths.length) return `${seen})`;
  return `${seen} The video is also in the world's files: ${v.paths[0]}. Use it in the world, by that path, only when I ask for it (e.g. on a screen or as a background); a video the world doesn't use is left out when it's saved.)`;
}

/** The tree `sha` without those of `paths` that no text file in it names (by file name). */
export async function withoutUnusedPhotos(db: Db, sha: string, paths: readonly string[]): Promise<string> {
  if (!paths.length) return sha;
  const files = await getTree(db, sha);
  if (!files) return sha;
  const there = paths.filter((p) => files[p]);
  if (!there.length) return sha;
  const name = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  const unused = new Set(there.map(name));
  for (const [path, blob] of Object.entries(files)) {
    if (!unused.size) break;
    if (there.includes(path)) continue;
    const bytes = await getBlob(db, blob);
    if (!bytes || bytes.length > SEARCH_MAX || !isText(bytes)) continue;
    const text = new TextDecoder().decode(bytes);
    for (const n of [...unused]) if (text.includes(n)) unused.delete(n);
  }
  if (!unused.size) return sha;
  const kept: Tree = {};
  for (const [path, blob] of Object.entries(files)) if (!(there.includes(path) && unused.has(name(path)))) kept[path] = blob;
  return putTree(db, kept);
}
