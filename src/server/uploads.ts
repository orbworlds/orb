// A video attached to a chat message is too big to travel in the build request: the page sends it
// first (POST /api/uploads) and the request names it, so a build can put it in the world's files
// (./agent/photos.ts). Only when it's small: one request takes at most Vercel's 4.5 MB.

import { VIDEO_TYPES } from '@/lib/engine/prompt';
import type { Viewer } from './auth';
import type { Db } from './db';
import { putBlob } from './files';
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
