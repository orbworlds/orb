// POST /api/worlds/import { url } — make a new world from a GitHub repository (its files become the
// world's files; see src/server/importer.ts). The new world belongs to the importer, links back to
// the repository and, imported from a branch, stays in sync with it (src/server/reposync.ts). With
// the importer's GitHub token kept on Orb, their private repositories can be imported too.

import { getViewer } from '@/server/auth';
import { FileError } from '@/server/files';
import { clientIp, fail, handle, json, readJson } from '@/server/http';
import { importRepo, parseRepoUrl } from '@/server/importer';
import { linkRepo, remoteHead, SyncError, tokenOf } from '@/server/reposync';
import { ready } from '@/server/schema';
import { actorKey, createRemixFromTree, createWorldFromTree, limitOrThrow } from '@/server/worlds';

export const maxDuration = 120;

export const POST = handle(async (req: Request) => {
  const body = await readJson<{ url?: unknown }>(req, 4000);
  const ref = typeof body?.url === 'string' ? parseRepoUrl(body.url) : null;
  if (!ref) fail(400, 'bad_request', 'Paste a link to a GitHub repository, like https://github.com/owner/repo.');
  const viewer = getViewer(req);
  const db = await ready();
  await limitOrThrow(db, `import:${actorKey(viewer, clientIp(req))}`, 12, 3600, "You've imported a lot this hour — try again a bit later.");
  try {
    const token = await tokenOf(db, viewer.userId, viewer.deviceHash);
    const full = `${ref.owner}/${ref.repo}`;
    // the branch's head, so the world can follow it (a tag or a commit is imported once, without a link)
    const head = await remoteHead(full, ref.ref, token).catch(() => null);
    const imp = await importRepo(db, head ? { ...ref, ref: head.sha } : ref, { token });
    const sourceUrl = `https://github.com/${full}${ref.ref ? `/tree/${ref.ref}${ref.dir ? `/${ref.dir}` : ''}` : ''}`;
    const opts = { name: imp.name, description: imp.description, sourceUrl, prompt: `Imported from ${sourceUrl}`, license: imp.license };
    const world = imp.remixOf ? await createRemixFromTree(db, viewer, imp.tree, imp.remixOf, opts) : await createWorldFromTree(db, viewer, imp.tree, opts);
    if (head) await linkRepo(db, world.id, { repo: full, branch: head.branch, root: imp.root, sha: head.sha, tree: imp.tree });
    // Without a license nobody may copy the code, so the world can't be remixed (unless its owner adds one).
    const noLicense = imp.license ? '' : 'This project has no license, so others can’t remix it. If it’s yours, add a LICENSE file to the repository and import it again.';
    const warning = [imp.warning, noLicense].filter(Boolean).join(' ');
    return json({ world: { ...world, repo: head ? { repo: full, branch: head.branch, state: 'ok', note: null, pulledAt: new Date().toISOString(), pushedAt: null, push: !!token } : null }, files: imp.files, ...(warning ? { warning } : {}) });
  } catch (e) {
    if (e instanceof FileError || e instanceof SyncError) fail(400, 'import_failed', e.message);
    throw e;
  }
});
