// POST /api/uploads/model — a 3D model attached to a chat message (a .glb, .gltf, .fbx, .obj or .stl
// of up to 10 MB), sent in parts: each part's bytes as the body (application/octet-stream, at most
// 4 MB) → { sha, size }; then { parts: [sha, …], name } as JSON → the model { sha, name, type, size },
// which the build request names (`models`) to put it in the world as models/<name> (src/server/uploads.ts).
// 400 missing_part, 413 too_big, 415 unsupported_type or gltf_files; 90 requests an hour (180 from one address).

import { getViewer } from '@/server/auth';
import { isSha } from '@/server/files';
import { clientIp, fail, handle, json } from '@/server/http';
import { ready } from '@/server/schema';
import { joinModel, MODEL_FILE_MAX, UPLOAD_PART_MAX, uploadPart } from '@/server/uploads';
import { actorKey, limitOrThrow } from '@/server/worlds';

export const POST = handle(async (req: Request) => {
  const viewer = getViewer(req);
  const db = await ready();
  const busy = 'That’s a lot of uploads at once — try again in a while.';
  await limitOrThrow(db, `upload-model:${actorKey(viewer, clientIp(req))}`, 90, 3600, busy);
  await limitOrThrow(db, `upload-model:ip:${clientIp(req)}`, 180, 3600, busy);
  if (/^application\/json/i.test(req.headers.get('content-type') ?? '')) {
    const body = (await req.json().catch(() => null)) as { parts?: unknown; name?: unknown } | null;
    const parts = body?.parts;
    if (!Array.isArray(parts) || !parts.length || parts.length > Math.ceil(MODEL_FILE_MAX / UPLOAD_PART_MAX) || !parts.every(isSha) || typeof body?.name !== 'string')
      fail(400, 'bad_request', 'Expected { parts: [sha, …], name }.');
    return json(await joinModel(db, viewer, parts as string[], body.name as string));
  }
  if (Number(req.headers.get('content-length') || 0) > UPLOAD_PART_MAX) fail(413, 'too_big', `A part can be up to ${UPLOAD_PART_MAX / 1e6} MB.`);
  return json(await uploadPart(db, viewer, new Uint8Array(await req.arrayBuffer())));
});
