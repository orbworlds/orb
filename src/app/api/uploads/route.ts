// POST /api/uploads — a video attached to a chat message, its bytes as the body (Content-Type
// video/mp4, video/webm or video/quicktime; at most 4 MB) → { sha, type }, which the build request
// names (`videos[].file`) to put it in the world. 413 too_big, 415 unsupported_type; 30 an hour (60 from one address).

import { getViewer } from '@/server/auth';
import { clientIp, fail, handle, json } from '@/server/http';
import { ready } from '@/server/schema';
import { uploadVideo, VIDEO_FILE_MAX } from '@/server/uploads';
import { actorKey, limitOrThrow } from '@/server/worlds';

export const POST = handle(async (req: Request) => {
  const viewer = getViewer(req);
  if (Number(req.headers.get('content-length') || 0) > VIDEO_FILE_MAX) fail(413, 'too_big', `A video can go in a world up to ${VIDEO_FILE_MAX / 1e6} MB.`);
  const db = await ready();
  const busy = 'That’s a lot of videos at once — try again in a while.';
  await limitOrThrow(db, `upload:${actorKey(viewer, clientIp(req))}`, 30, 3600, busy);
  await limitOrThrow(db, `upload:ip:${clientIp(req)}`, 60, 3600, busy);
  const bytes = new Uint8Array(await req.arrayBuffer());
  return json(await uploadVideo(db, viewer, bytes, req.headers.get('content-type') ?? ''));
});
