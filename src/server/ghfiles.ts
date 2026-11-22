// World files read from GitHub instead of kept in the database: a game Orb imported from a public
// GitHub repository (the curated open-source games, see ./seed.ts) has the same files there, so
// those are read from the commit they came from (orb_blobs.source, see ./files.ts) and the
// database keeps none of their bytes. Only files GitHub serves exactly as stored move (each is
// fetched and checked first); what the importer rewrote (pages, modules, styles) and small files
// stay. Remixes share the files, so they read them from GitHub too.

import type { Db } from './db';
import { FILE_LIMITS, sha256, sourceBytes } from './files';
import { download, parseRepoUrl, untar } from './importer';

const WEB = process.env.ORB_GITHUB_WEB || 'https://github.com'; // overridable for tests
const CODELOAD = process.env.ORB_GITHUB_CODELOAD || 'https://codeload.github.com';

/** Smaller files stay in the database: they take little room and load fastest from there. */
export const MOVE_MIN = 64_000;

/** The commit a branch or tag names (the default branch without one), from GitHub's git endpoint (not its rate-limited API). */
export async function commitOf(owner: string, repo: string, ref: string | null): Promise<string | null> {
  if (ref && /^[0-9a-f]{40}$/.test(ref)) return ref;
  const res = await fetch(`${WEB}/${owner}/${repo}.git/info/refs?service=git-upload-pack`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const text = await res.text();
  // Lines are "<length><sha> <name>", the first one followed by a NUL and the server's capabilities.
  for (const name of ref ? [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`] : ['HEAD']) {
    for (let at = text.indexOf(` ${name}`); at >= 40; at = text.indexOf(` ${name}`, at + 1)) {
      const end = text[at + name.length + 1];
      const sha = text.slice(at - 40, at);
      if ((end === undefined || end === '\0' || end === '\n') && /^[0-9a-f]{40}$/.test(sha)) return sha;
    }
  }
  return null;
}

export interface Moved {
  world: string;
  commit: string | null;
  /** Files that now come from GitHub, and their bytes. */
  files: number;
  bytes: number;
  /** Files GitHub didn't serve as stored (they stay). */
  kept: number;
}

/** Move the files of a world imported from a public GitHub repository that GitHub serves exactly as Orb stores them. */
export async function moveToGitHub(db: Db, worldId: string): Promise<Moved> {
  const out: Moved = { world: worldId, commit: null, files: 0, bytes: 0, kept: 0 };
  const [w] = await db.query<{ source_url: string | null }>(`select source_url from orb_worlds where id = $1`, [worldId]);
  const ref = w?.source_url ? parseRepoUrl(w.source_url) : null;
  if (!ref) return out;
  const commit = await commitOf(ref.owner, ref.repo, ref.ref);
  if (!commit) return out;
  out.commit = commit;
  // The repository's files at that commit, by sha (its tarball's top folder dropped).
  const paths = new Map<string, string>();
  for await (const e of untar(await download(`${CODELOAD}/${ref.owner}/${ref.repo}/tar.gz/${commit}`))) {
    const path = e.path.split('/').slice(1).join('/');
    // Pages stay: the world's page is read from the database as text (orb_worlds.code).
    if (path && !/\.html?$/i.test(path) && e.data.length >= MOVE_MIN && e.data.length <= FILE_LIMITS.file) paths.set(sha256(e.data), path);
  }
  if (!paths.size) return out;
  const rows = await db.query<{ sha: string }>(`select sha from orb_blobs where sha = any($1::text[]) and source is null and size >= $2`, [[...paths.keys()], MOVE_MIN]);
  const queue = rows.map((r) => r.sha);
  const work = async () => {
    for (let sha = queue.shift(); sha; sha = queue.shift()) {
      const source = `${ref.owner}/${ref.repo}@${commit}/${paths.get(sha)}`;
      if (!(await sourceBytes(source, sha))) {
        out.kept++;
        continue;
      }
      const moved = await db.query<{ size: number }>(`update orb_blobs set source = $2, data = ''::bytea where sha = $1 and source is null returning size`, [sha, source]);
      if (moved[0]) {
        out.files++;
        out.bytes += Number(moved[0].size);
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, work));
  return out;
}
