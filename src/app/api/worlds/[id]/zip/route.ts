// GET /api/worlds/:id/zip — the world's files as a zip, for its owner, or anyone when it can be
// remixed (the same people the Share sheet and the world's menu offer it to). Single-file worlds
// are their index.html.

import { getViewer } from '@/server/auth';
import { getBlob, getTree } from '@/server/files';
import { fail, handle } from '@/server/http';
import { slugify } from '@/server/paths';
import { ready } from '@/server/schema';
import { getWorldForViewer, worldIdParam, type IdContext } from '@/server/worlds';
import { zip } from '@/server/zip';

export const GET = handle(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const db = await ready();
  const world = await getWorldForViewer(db, getViewer(req), id);
  if (!world || world.kind !== 'native' || (!world.canEdit && !world.forkable)) fail(404, 'not_found', 'This world can’t be downloaded.');
  const files: Array<{ path: string; data: Uint8Array }> = [];
  const tree = world.tree ? await getTree(db, world.tree) : null;
  if (tree) {
    const paths = Object.keys(tree).sort();
    for (let i = 0; i < paths.length; i += 24) {
      const batch = await Promise.all(paths.slice(i, i + 24).map(async (path) => ({ path, data: await getBlob(db, tree[path]) })));
      for (const f of batch) if (f.data) files.push({ path: f.path, data: f.data });
    }
  } else if (world.code) files.push({ path: 'index.html', data: new TextEncoder().encode(world.code) });
  if (!files.length) fail(404, 'not_found', 'This world has no files yet.');
  return new Response(new Blob([zip(files) as BlobPart]), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${slugify(world.name)}.zip"`,
      'cache-control': 'private, no-store',
    },
  });
});
