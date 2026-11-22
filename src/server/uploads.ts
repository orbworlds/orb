// A video attached to a chat message is too big to travel in the build request: the page sends it
// first (POST /api/uploads) and the request names it, so a build can put it in the world's files
// (./agent/photos.ts). Only when it's small: one request takes at most Vercel's 4.5 MB.
// A 3D model (a .glb, .gltf, .fbx, .obj or .stl, up to a world file's 10 MB) comes the same way, in
// parts of up to 4 MB that are put together once all have arrived (POST /api/uploads/model).

import { MODEL_TYPES, VIDEO_TYPES, type ModelType } from '@/lib/engine/prompt';
import type { BuildModel } from '@/lib/types';
import type { Viewer } from './auth';
import type { Db } from './db';
import { FILE_LIMITS, getBlob, isText, putBlob } from './files';
import { fail } from './http';

/** The biggest video a message brings into a world. */
export const VIDEO_FILE_MAX = 4_000_000;

/** Whether the bytes start as the type says: an MP4 or QuickTime `ftyp` box, or WebM's EBML header. */
function looksLike(bytes: Uint8Array, type: string): boolean {
  if (type === 'video/webm') return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  return bytes.length > 12 && String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === 'ftyp';
}

/** Keep a video on Orb → its sha (and type), for a build request to name. */
export async function uploadVideo(db: Db, viewer: Viewer, bytes: Uint8Array, contentType: string): Promise<{ sha: string; type: string }> {
  if (!viewer.deviceHash && !viewer.userId) fail(400, 'device_required', 'Missing device key.');
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (!(VIDEO_TYPES as readonly string[]).includes(type)) fail(415, 'unsupported_type', 'Only MP4, WebM and QuickTime videos can go in a world.');
  if (!bytes.length || bytes.length > VIDEO_FILE_MAX) fail(413, 'too_big', `A video can go in a world up to ${VIDEO_FILE_MAX / 1e6} MB.`);
  if (!looksLike(bytes, type)) fail(415, 'unsupported_type', 'That doesn’t look like a video.');
  const { sha } = await putBlob(db, bytes);
  return { sha, type };
}

// -- 3D models ---------------------------------------------------------------------------------------

/** The most a request carries of a file sent in parts. */
export const UPLOAD_PART_MAX = 4_000_000;
/** The biggest 3D model a message brings into a world: one world file. */
export const MODEL_FILE_MAX = FILE_LIMITS.file;

/** One part of a 3D model on its way → its sha (the parts are put together by joinModel). */
export async function uploadPart(db: Db, viewer: Viewer, bytes: Uint8Array): Promise<{ sha: string; size: number }> {
  if (!viewer.deviceHash && !viewer.userId) fail(400, 'device_required', 'Missing device key.');
  if (!bytes.length || bytes.length > UPLOAD_PART_MAX) fail(413, 'too_big', `A part can be up to ${UPLOAD_PART_MAX / 1e6} MB.`);
  return putBlob(db, bytes);
}

/** A model's file name as the world keeps it: letters, digits, - _ . and spaces, ending in its type (null: not a model's). */
export function modelName(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? '';
  const m = /^(.*)\.([A-Za-z]+)$/.exec(base.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''));
  if (!m || !(MODEL_TYPES as readonly string[]).includes(m[2].toLowerCase())) return null;
  const stem = m[1].replace(/[^\w\- .]+/g, '-').replace(/\s+/g, ' ').replace(/-{2,}/g, '-').replace(/^[\s.\-]+|[\s.\-]+$/g, '').slice(0, 80);
  return `${stem || 'model'}.${m[2].toLowerCase()}`;
}

const START = (bytes: Uint8Array, n = 64) => new TextDecoder('latin1').decode(bytes.subarray(0, n));

/** Which kind of 3D model the bytes are, as the name's extension says and their start agrees (null: they don't). */
export function modelType(name: string, bytes: Uint8Array): ModelType | null {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase() as ModelType;
  if (!(MODEL_TYPES as readonly string[]).includes(ext) || bytes.length < 12) return null;
  const head = START(bytes).replace(/^\uFEFF/, '').trimStart();
  switch (ext) {
    case 'glb':
      return head.startsWith('glTF') ? ext : null;
    case 'gltf':
      return head.startsWith('{') && isText(bytes) ? ext : null;
    case 'fbx':
      return head.startsWith('Kaydara FBX Binary') || head.startsWith('; FBX') ? ext : null;
    case 'obj':
      return isText(bytes) && /^\s*(v|vt|vn|f|o|g|mtllib|usemtl)\s/m.test(new TextDecoder().decode(bytes.subarray(0, 65_536))) ? ext : null;
    case 'stl':
      if (head.startsWith('solid') && isText(bytes)) return ext;
      return bytes.length >= 84 && bytes.length === 84 + 50 * new DataView(bytes.buffer, bytes.byteOffset + 80, 4).getUint32(0, true) ? ext : null;
  }
  return null;
}

/** A 3D model put together from its parts, in order → what the build request names. */
export async function joinModel(db: Db, viewer: Viewer, parts: string[], name: string): Promise<BuildModel & { size: number }> {
  if (!viewer.deviceHash && !viewer.userId) fail(400, 'device_required', 'Missing device key.');
  const clean = modelName(name);
  if (!clean) fail(415, 'unsupported_type', 'Orb takes 3D models as .glb, .gltf, .fbx, .obj or .stl files.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (const sha of parts) {
    const part = await getBlob(db, sha);
    if (!part) fail(400, 'missing_part', 'A part of that model didn’t arrive. Try again.');
    chunks.push(part);
    size += part.length;
    if (size > MODEL_FILE_MAX) fail(413, 'too_big', `A 3D model can go in a world up to ${MODEL_FILE_MAX / 1e6} MB.`);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  const type = modelType(clean, bytes);
  if (!type) fail(415, 'unsupported_type', `That doesn’t look like a .${clean.split('.').pop()} 3D model.`);
  if (type === 'gltf') {
    // One file: its buffers and pictures inside it (a .gltf naming other files can't load without them).
    let gltf: { asset?: unknown; buffers?: Array<{ uri?: string }>; images?: Array<{ uri?: string }> } | null = null;
    try {
      gltf = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      /* not JSON */
    }
    if (!gltf?.asset) fail(415, 'unsupported_type', 'That doesn’t look like a .gltf 3D model.');
    if ([...(gltf.buffers ?? []), ...(gltf.images ?? [])].some((x) => x.uri && !x.uri.startsWith('data:'))) fail(415, 'gltf_files', 'That .gltf needs other files next to it: export it as one .glb instead.');
  }
  const { sha } = await putBlob(db, bytes);
  return { sha, name: clean, type, size };
}
