// A new private repository of the person's GitHub account for a world, and its first commit (the
// world's files): how a world comes to be kept on GitHub (./reposync.ts keeps it in sync from then on).

import { createHash } from 'node:crypto';
import type { Db } from './db';
import { getBlob, type Tree } from './files';
import { SITE } from '../lib/site';

const API = process.env.ORB_GITHUB_API || 'https://api.github.com'; // overridable for tests
export const BRANCH = 'main';

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function gh<T>(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': `Orb (+${SITE})`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  let data: unknown = null;
  try {
    data = res.status === 204 ? null : await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, data: data as T };
}

function fail(status: number, data: unknown, what: string): never {
  const m = (data as { message?: string } | null)?.message ?? '';
  if (status === 401) throw new GitHubError(401, 'Your GitHub connection expired — reconnect GitHub in You → GitHub.');
  if (status === 403 && /rate limit/i.test(m)) throw new GitHubError(429, 'GitHub is busy right now — try again in a minute.');
  if (status === 403 || status === 404) throw new GitHubError(status, `GitHub refused to ${what} (${m || status}). Make sure your GitHub token can create and change private repositories.`);
  throw new GitHubError(status, `GitHub couldn't ${what} (${m || status}).`);
}

export const repoNameFor = (world: { id: string; name: string }): string => {
  const slug = world.name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  const short = world.id.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 6) || 'world';
  return slug ? `${slug}-${short}` : `orb-${short}`;
};

/** The world's repository: the one given (if it still exists and is ours), else a new private one. */
export async function ensureRepo(token: string, world: { id: string; name: string }, known: string | null, origin: string): Promise<string> {
  if (known && /^[\w.-]+\/[\w.-]+$/.test(known)) {
    const r = await gh<{ full_name?: string; permissions?: { push?: boolean } }>(token, 'GET', `/repos/${known}`);
    if (r.status === 200 && r.data.full_name && r.data.permissions?.push !== false) return r.data.full_name;
  }
  const me = await gh<{ login?: string }>(token, 'GET', '/user');
  if (me.status !== 200 || !me.data.login) fail(me.status, me.data, 'tell who you are');
  const base = repoNameFor(world);
  const description = `Made with Orb — ${origin}/w/${world.id}`;
  for (let i = 1; i <= 6; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    const r = await gh<{ full_name?: string; errors?: Array<{ message?: string }>; message?: string }>(token, 'POST', '/user/repos', {
      name,
      description,
      private: true,
      auto_init: true,
      has_issues: false,
      has_projects: false,
      has_wiki: false,
    });
    if (r.status === 201 && r.data.full_name) return r.data.full_name;
    const taken = r.status === 422 && /already exists/i.test(JSON.stringify(r.data));
    if (!taken) fail(r.status, r.data, 'create a repository for this world');
    // A repo we made for this same world before (this browser forgot it): use it again.
    const existing = await gh<{ full_name?: string; description?: string }>(token, 'GET', `/repos/${me.data.login}/${name}`);
    if (existing.status === 200 && existing.data.full_name && (existing.data.description ?? '').includes(`/w/${world.id}`)) return existing.data.full_name;
  }
  throw new GitHubError(409, "Couldn't pick a name for the world's GitHub repository. Try renaming the world.");
}

/** Commit sha at the tip of the branch (null if the repo is still empty). */
export async function headSha(token: string, repo: string): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await gh<{ object?: { sha?: string } }>(token, 'GET', `/repos/${repo}/git/ref/heads/${BRANCH}`);
    if (r.status === 200 && r.data.object?.sha) return r.data.object.sha;
    if (r.status !== 404 && r.status !== 409) fail(r.status, r.data, 'read the repository');
    await new Promise((res) => setTimeout(res, 1500)); // a brand-new repo takes a moment
  }
  return null;
}

/**
 * Make the branch hold exactly the world's files (one commit; files only in the repo are removed,
 * except .github and README.md). Returns the new head sha (or the old one if nothing changed).
 */
export async function pushTree(db: Db, token: string, repo: string, files: Tree, message: string): Promise<string> {
  const parent = await headSha(token, repo);
  let baseTree: string | null = null;
  const existing = new Map<string, string>(); // path → git blob sha
  if (parent) {
    const c = await gh<{ tree?: { sha?: string } }>(token, 'GET', `/repos/${repo}/git/commits/${parent}`);
    if (c.status !== 200 || !c.data.tree?.sha) fail(c.status, c.data, 'read the repository');
    baseTree = c.data.tree.sha;
    const t = await gh<{ tree?: Array<{ path: string; type: string; sha: string }> }>(token, 'GET', `/repos/${repo}/git/trees/${baseTree}?recursive=1`);
    for (const e of t.data.tree ?? []) if (e.type === 'blob') existing.set(e.path, e.sha);
  }
  const entries: Array<{ path: string; mode: string; type: string; sha: string | null }> = [];
  for (const [path, sha] of Object.entries(files)) {
    const bytes = await getBlob(db, sha);
    if (!bytes) continue;
    const gitSha = gitBlobSha(bytes);
    if (existing.get(path) === gitSha) continue;
    const b = await gh<{ sha?: string }>(token, 'POST', `/repos/${repo}/git/blobs`, { content: Buffer.from(bytes).toString('base64'), encoding: 'base64' });
    if (b.status !== 201 || !b.data.sha) fail(b.status, b.data, 'upload a file');
    entries.push({ path, mode: '100644', type: 'blob', sha: b.data.sha });
  }
  for (const path of existing.keys()) {
    if (!(path in files) && path !== 'README.md' && !path.startsWith('.github/')) entries.push({ path, mode: '100644', type: 'blob', sha: null });
  }
  if (!entries.length && parent) return parent;
  const tree = await gh<{ sha?: string }>(token, 'POST', `/repos/${repo}/git/trees`, { ...(baseTree ? { base_tree: baseTree } : {}), tree: entries });
  if (tree.status !== 201 || !tree.data.sha) fail(tree.status, tree.data, 'save the files');
  const commit = await gh<{ sha?: string }>(token, 'POST', `/repos/${repo}/git/commits`, { message, tree: tree.data.sha, parents: parent ? [parent] : [] });
  if (commit.status !== 201 || !commit.data.sha) fail(commit.status, commit.data, 'save the files');
  const ref = parent
    ? await gh(token, 'PATCH', `/repos/${repo}/git/refs/heads/${BRANCH}`, { sha: commit.data.sha, force: true })
    : await gh(token, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.data.sha });
  if (ref.status !== 200 && ref.status !== 201) fail(ref.status, ref.data, 'save the files');
  return commit.data.sha;
}

function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
