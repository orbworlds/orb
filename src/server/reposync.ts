// Worlds kept in sync with a GitHub repository, both ways (SPEC §2 "GitHub sync"). A link ties a
// world to a branch and remembers the commit and the world's tree both sides last agreed on:
//
// - GitHub → Orb: when someone opens the world (at most once a minute), when its owner asks, and
//   every few minutes for every linked world (/api/cron/github), Orb reads the branch's head. A new
//   commit comes in as a new version: what changed on GitHub since the last agreement is applied
//   on top of the world as it is now, so changes made on Orb meanwhile stay (a file both changed
//   takes GitHub's version; Orb's is the version before, in the world's history).
// - Orb → GitHub: every new version (a build, a hand edit) is committed to the branch, with only
//   the files that changed since the last agreement (so files Orb never imported, like
//   node_modules, orb-kit/ or very big ones, are left alone). This needs the owner's GitHub token
//   (orb_github_tokens, the only place Orb keeps one): without one, the repository leads and Orb
//   only follows. With "keep every world on GitHub" (`auto`), a world of theirs that isn't linked
//   yet gets a new private repository at its next save, whichever builder made it.
//
// Orb keeps every world and its versions itself either way: a link only adds a copy on GitHub, and
// unlinking, or the repository going away, never touches the world.
//
// Public repositories are read without any token: their head through git's own ref list (not
// GitHub's API, whose anonymous quota Vercel's shared addresses would use up) and their files from
// codeload, like an import.

import type { Viewer } from './auth';
import type { Db } from './db';
import { entryOf, getBlob, getTree, mergeTrees, putTree, type Tree } from './files';
import { importRepo, LICENSE_FILE } from './importer';
import { createSign } from 'node:crypto';
import { openKey, sealKey } from './agent/secrets';
import { ORG } from './originals';
import { BRANCH, ensureRepo, gh, pushTree } from './github';
import { commitTree, worldTree } from './worlds';
import { SITE } from '../lib/site';

const WEB = process.env.ORB_GITHUB_WEB || 'https://github.com';
const CHECK_EVERY_S = 60;
const SWEEP_EVERY_S = 600;
const REPO_RE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const BRANCH_RE = /^[\w./-]{1,200}$/;

interface RepoLink {
  world_id: string;
  repo: string;
  branch: string;
  root: string;
  synced_sha: string | null;
  synced_tree: string | null;
  checked_at: string | null;
  pulled_at: string | null;
  pushed_at: string | null;
  state: string;
  note: string | null;
}

export class SyncError extends Error {}

// ---------------------------------------------------------------------------------------------
// Tokens

const keyOf = (userId: string | null, deviceHash: string | null): string[] => [...(userId ? [`u:${userId}`] : []), ...(deviceHash ? [`d:${deviceHash}`] : [])];

interface GitHubConnection {
  login: string;
  /** Every world of theirs is kept on GitHub (a new private repository at its next save). */
  auto: boolean;
}

/** Keep a person's GitHub token (checked with GitHub first), so Orb can sync their worlds without a tab open. */
export async function saveToken(db: Db, viewer: Viewer, token: string): Promise<GitHubConnection> {
  const owner = keyOf(viewer.userId, viewer.deviceHash)[0];
  if (!owner) throw new SyncError('Missing device key.');
  const me = await gh<{ login?: string }>(token, 'GET', '/user');
  if (me.status !== 200 || !me.data.login) throw new SyncError(me.status === 401 ? 'GitHub says that token is not valid.' : `GitHub didn't accept that token (${me.status}).`);
  const rows = await db.query<{ auto: boolean }>(
    `insert into orb_github_tokens (owner, login, token_enc) values ($1, $2, $3)
     on conflict (owner) do update set login = excluded.login, token_enc = excluded.token_enc, updated_at = now()
     returning auto`,
    [owner, me.data.login, sealKey(token)],
  );
  return { login: me.data.login, auto: !!rows[0]?.auto };
}

/** Turn "keep every world on GitHub" on or off (null when they haven't connected GitHub). */
export async function setAuto(db: Db, viewer: Viewer, auto: boolean): Promise<GitHubConnection | null> {
  const keys = keyOf(viewer.userId, viewer.deviceHash);
  if (!keys.length) return null;
  await db.query(`update orb_github_tokens set auto = $2 where owner = any($1::text[])`, [keys, auto]);
  return connection(db, viewer);
}

export async function dropToken(db: Db, viewer: Viewer): Promise<void> {
  const keys = keyOf(viewer.userId, viewer.deviceHash);
  if (keys.length) await db.query(`delete from orb_github_tokens where owner = any($1::text[])`, [keys]);
}

export async function connection(db: Db, viewer: Viewer): Promise<GitHubConnection | null> {
  const keys = keyOf(viewer.userId, viewer.deviceHash);
  if (!keys.length) return null;
  const rows = await db.query<{ login: string; auto: boolean }>(`select login, auto from orb_github_tokens where owner = any($1::text[]) order by owner limit 1`, [keys]);
  return rows[0] ? { login: rows[0].login, auto: !!rows[0].auto } : null;
}

/** The token of whoever is asking, or of a world's owner (their account's first, then their device's). */
export async function tokenOf(db: Db, userId: string | null, deviceHash: string | null): Promise<string | null> {
  const keys = keyOf(userId, deviceHash);
  if (!keys.length) return null;
  const rows = await db.query<{ owner: string; token_enc: string }>(`select owner, token_enc from orb_github_tokens where owner = any($1::text[])`, [keys]);
  for (const k of keys) {
    const t = openKey(rows.find((r) => r.owner === k)?.token_enc);
    if (t) return t;
  }
  return null;
}

/**
 * Orb's own repositories (its Originals') are read as the org's GitHub App (ORB_APP_ID, ORB_APP_KEY):
 * an installation token that can only read contents, minted for an hour and reused. Null without the app.
 */
let orgCache: { token: string; until: number } | null = null;
async function orgToken(): Promise<string | null> {
  const id = process.env.ORB_APP_ID, key = process.env.ORB_APP_KEY;
  if (!id || !key) return null;
  if (orgCache && orgCache.until > Date.now()) return orgCache.token;
  const pem = key.includes('-----BEGIN') ? key.replace(/\\n/g, '\n') : `-----BEGIN RSA PRIVATE KEY-----\n${key.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').trim()}\n-----END RSA PRIVATE KEY-----\n`;
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: id })}`;
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(pem).toString('base64url')}`;
  const inst = await gh<{ id?: number }>(jwt, 'GET', `/orgs/${ORG}/installation`);
  if (!inst.data?.id) return null;
  const t = await gh<{ token?: string }>(jwt, 'POST', `/app/installations/${inst.data.id}/access_tokens`, { permissions: { contents: 'read' } });
  if (!t.data?.token) return null;
  orgCache = { token: t.data.token, until: Date.now() + 50 * 60_000 };
  return t.data.token;
}

/** How Orb reads a linked repository: its owner's token, or for Orb's own worlds the org's app. */
async function readToken(db: Db, w: WorldOwner, repo: string): Promise<string | null> {
  if (isOrbs(w)) return repo.toLowerCase().startsWith(`${ORG.toLowerCase()}/`) ? orgToken().catch(() => null) : null;
  return tokenOf(db, w.owner_user, w.owner_device);
}

// ---------------------------------------------------------------------------------------------
// GitHub's side

/** The branch's head commit (and, for no branch, the default branch's). Null if there's no such repository or branch. */
export async function remoteHead(repo: string, branch: string | null, token: string | null): Promise<{ sha: string; branch: string; message: string } | null> {
  if (!REPO_RE.test(repo)) return null;
  if (token) {
    let b = branch;
    if (!b) {
      const r = await gh<{ default_branch?: string }>(token, 'GET', `/repos/${repo}`);
      if (r.status === 404) return null;
      if (r.status !== 200 || !r.data.default_branch) throw new SyncError(`GitHub couldn't show ${repo} (${r.status}).`);
      b = r.data.default_branch;
    }
    const c = await gh<{ sha?: string; commit?: { message?: string } }>(token, 'GET', `/repos/${repo}/commits/${encodeURIComponent(b)}`);
    if (c.status === 404 || c.status === 422 || c.status === 409) return null;
    if (c.status === 401) throw new SyncError('Your GitHub token stopped working: connect GitHub again in You → GitHub.');
    if (c.status !== 200 || !c.data.sha) throw new SyncError(`GitHub couldn't show ${repo} (${c.status}).`);
    return { sha: c.data.sha, branch: b, message: (c.data.commit?.message ?? '').split('\n')[0] };
  }
  // git's smart HTTP ref list: pkt-lines of "<sha> <ref>", the first one HEAD with symref=HEAD:refs/heads/<default>
  const res = await fetch(`${WEB}/${repo}.git/info/refs?service=git-upload-pack`, { headers: { 'user-agent': `git/2.45 (Orb +${SITE})` }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404 || res.status === 401) return null;
  if (!res.ok) throw new SyncError(`GitHub didn't answer for ${repo} (${res.status}).`);
  const text = await res.text();
  const b = branch ?? /symref=HEAD:refs\/heads\/([^\s\0]+)/.exec(text)?.[1];
  if (!b) return null;
  for (const m of text.matchAll(/([0-9a-f]{40}) refs\/heads\/([^\s\0]+)/g)) if (m[2] === b) return { sha: m[1], branch: b, message: '' };
  return null;
}

/** Commit the files that changed (path → blob sha in Orb, or null to delete) on top of `parent`. Null when the branch moved meanwhile. */
async function commitChanges(db: Db, token: string, link: RepoLink, parent: string, changes: Map<string, string | null>, message: string): Promise<string | null> {
  const c = await gh<{ tree?: { sha?: string } }>(token, 'GET', `/repos/${link.repo}/git/commits/${parent}`);
  if (c.status !== 200 || !c.data.tree?.sha) throw new SyncError(`GitHub couldn't show ${link.repo}'s last commit (${c.status}).`);
  const entries: Array<{ path: string; mode: string; type: string; sha: string | null }> = [];
  for (const [path, sha] of changes) {
    const where = link.root ? `${link.root}/${path}` : path;
    if (sha === null) {
      entries.push({ path: where, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const bytes = await getBlob(db, sha);
    if (!bytes) continue;
    const b = await gh<{ sha?: string }>(token, 'POST', `/repos/${link.repo}/git/blobs`, { content: Buffer.from(bytes).toString('base64'), encoding: 'base64' });
    if (b.status === 403 || b.status === 404) throw new SyncError(`readonly:Your GitHub token can't change ${link.repo}.`);
    if (b.status !== 201 || !b.data.sha) throw new SyncError(`GitHub didn't take a file (${b.status}).`);
    entries.push({ path: where, mode: '100644', type: 'blob', sha: b.data.sha });
  }
  if (!entries.length) return parent;
  const tree = await gh<{ sha?: string }>(token, 'POST', `/repos/${link.repo}/git/trees`, { base_tree: c.data.tree.sha, tree: entries });
  if (tree.status !== 201 || !tree.data.sha) throw new SyncError(`GitHub didn't take the files (${tree.status}).`);
  const commit = await gh<{ sha?: string }>(token, 'POST', `/repos/${link.repo}/git/commits`, { message, tree: tree.data.sha, parents: [parent] });
  if (commit.status !== 201 || !commit.data.sha) throw new SyncError(`GitHub didn't take the commit (${commit.status}).`);
  const ref = await gh(token, 'PATCH', `/repos/${link.repo}/git/refs/heads/${link.branch}`, { sha: commit.data.sha, force: false });
  if (ref.status === 422 || ref.status === 409) return null; // someone pushed meanwhile: the next pull merges it
  if (ref.status === 403 || ref.status === 404) throw new SyncError(`readonly:Your GitHub token can't push to ${link.repo} (or ${link.branch} is protected).`);
  if (ref.status !== 200) throw new SyncError(`GitHub didn't move ${link.branch} (${ref.status}).`);
  return commit.data.sha;
}

// ---------------------------------------------------------------------------------------------
// Links

export async function getLink(db: Db, worldId: string): Promise<RepoLink | null> {
  const rows = await db.query<RepoLink>(`select * from orb_world_repos where world_id = $1`, [worldId]);
  return rows[0] ?? null;
}

export async function linkRepo(db: Db, worldId: string, l: { repo: string; branch: string; root: string; sha: string; tree: string }): Promise<void> {
  if (!REPO_RE.test(l.repo) || !BRANCH_RE.test(l.branch)) throw new SyncError('That is not a GitHub repository and branch.');
  await db.query(
    `insert into orb_world_repos (world_id, repo, branch, root, synced_sha, synced_tree, checked_at, pulled_at, state, note)
     values ($1, $2, $3, $4, $5, $6, now(), now(), 'ok', null)
     on conflict (world_id) do update set repo = excluded.repo, branch = excluded.branch, root = excluded.root, synced_sha = excluded.synced_sha,
       synced_tree = excluded.synced_tree, checked_at = now(), pulled_at = now(), pushed_at = null, state = 'ok', note = null`,
    [worldId, l.repo, l.branch, l.root, l.sha, l.tree],
  );
}

/** Put a world in a new private repository of its owner's GitHub account (the token's), its files as the first commit, and link it. */
export async function keepOnGitHub(db: Db, worldId: string, token: string): Promise<string> {
  const now = await worldTree(db, worldId);
  if (!now) throw new SyncError('This world does not exist.');
  const repo = await ensureRepo(token, { id: worldId, name: now.name });
  const sha = await pushTree(db, token, repo, now.files, `${now.name}, from Orb\n\nVersion ${now.version} on Orb: ${SITE}/w/${worldId}`);
  await linkRepo(db, worldId, { repo, branch: BRANCH, root: '', sha, tree: now.tree });
  return repo;
}

export async function unlinkRepo(db: Db, worldId: string): Promise<void> {
  await db.query(`delete from orb_world_repos where world_id = $1`, [worldId]);
}

interface WorldOwner {
  owner_user: string | null;
  owner_device: string | null;
  kind: string;
}
const ownerViewer = (w: WorldOwner): Viewer => ({ deviceHash: w.owner_device, userId: w.owner_user, deviceId: null });
/** One of Orb's own worlds (an Original): nobody owns it. */
const isOrbs = (w: WorldOwner) => !w.owner_user && !w.owner_device;

async function setState(db: Db, worldId: string, state: string, note: string | null): Promise<void> {
  await db.query(`update orb_world_repos set state = $2, note = $3 where world_id = $1`, [worldId, state, note]);
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** A failure as the link's state: no push access makes it read-only (Orb still follows), anything else an error. */
async function recordFailure(db: Db, worldId: string, e: unknown): Promise<void> {
  const m = messageOf(e);
  if (m.startsWith('readonly:')) await setState(db, worldId, 'readonly', m.slice(9));
  else await setState(db, worldId, 'error', m);
}

// ---------------------------------------------------------------------------------------------
// GitHub → Orb

/**
 * Bring the branch's new commits into the world (as one new version), then send Orb's own changes
 * back if there are any and the owner's token can push. `force` skips the once-a-minute limit.
 * Returns the new version's number, if one was saved.
 */
export async function pullRepo(db: Db, worldId: string, opts: { force?: boolean } = {}): Promise<number | null> {
  const claimed = await db.query<RepoLink>(
    `update orb_world_repos set checked_at = now()
     where world_id = $1 and ($2::boolean or checked_at is null or checked_at < now() - make_interval(secs => $3))
     returning *`,
    [worldId, !!opts.force, CHECK_EVERY_S],
  );
  const link = claimed[0];
  if (!link) return null;
  try {
    return await pullLinked(db, link);
  } catch (e) {
    await recordFailure(db, worldId, e);
    if (opts.force) throw e;
    return null;
  }
}

async function pullLinked(db: Db, link: RepoLink): Promise<number | null> {
  const [w] = await db.query<WorldOwner>(`select owner_user, owner_device, kind from orb_worlds where id = $1`, [link.world_id]);
  if (!w || w.kind !== 'native') return null;
  const orbs = isOrbs(w);
  const token = await readToken(db, w, link.repo);
  const head = await remoteHead(link.repo, link.branch, token);
  if (!head) throw new SyncError(`${link.repo} (${link.branch}) can't be found${token ? '' : ' — if it is private, connect GitHub in You → GitHub'}.`);
  if (head.sha === link.synced_sha) {
    if (token && !orbs) await pushLinked(db, link, token);
    else if (link.state === 'error') await setState(db, link.world_id, 'ok', null);
    return null;
  }
  if (!head.message) {
    // the ref list has no commit messages: one look per new commit (fine without a token; when refused, the version just says less)
    const c = await gh<{ commit?: { message?: string } }>(null, 'GET', `/repos/${link.repo}/commits/${head.sha}`).catch(() => null);
    head.message = (c?.status === 200 ? (c.data.commit?.message ?? '') : '').split('\n')[0];
  }
  const [owner, repo] = link.repo.split('/');
  const imp = await importRepo(db, { owner, repo, ref: head.sha, dir: link.root }, { token });
  /** Both sides agree on the head commit and the files now. */
  const markPulled = () => db.query(`update orb_world_repos set synced_sha = $2, synced_tree = $3, pulled_at = now(), state = 'ok', note = null where world_id = $1`, [link.world_id, head.sha, imp.tree]);
  if (orbs) {
    // an Original is its repository: its files, in place (it has one version, kept in step)
    const [world] = await db.query<{ tree: string | null }>(`select tree from orb_worlds where id = $1`, [link.world_id]);
    if (world?.tree !== imp.tree) {
      const code = await entryOf(db, (await getTree(db, imp.tree)) ?? {});
      await db.query(`update orb_worlds set tree = $2, code = $3, updated_at = now() where id = $1`, [link.world_id, imp.tree, code]);
      await db.query(
        `insert into orb_world_versions (world_id, version, code, tree, prompt) values ($1, 1, $2, $3, 'Orb Original')
         on conflict (world_id, version) do update set code = excluded.code, tree = excluded.tree`,
        [link.world_id, code, imp.tree],
      );
    }
    await markPulled();
    return null;
  }
  const theirs = (await getTree(db, imp.tree)) ?? {};
  const base: Tree = (link.synced_tree && (await getTree(db, link.synced_tree))) || {};
  let version: number | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = await worldTree(db, link.world_id);
    if (!now) return null;
    // GitHub's changes since the last agreement, on top of the world as it is now (GitHub's file wins when both changed one)
    const target = now.tree === link.synced_tree || !link.synced_tree ? imp.tree : await putTree(db, mergeTrees(base, theirs, now.files));
    await markPulled();
    if (target === now.tree) break;
    const prompt = `From GitHub (${link.repo}@${head.sha.slice(0, 7)})${head.message ? `: ${head.message}` : ''}`;
    const res = await commitTree(db, ownerViewer(w), link.world_id, target, { prompt, expect: { tree: now.stored } });
    if (res) {
      version = res.version;
      break;
    }
  }
  if (token) {
    const fresh = await getLink(db, link.world_id);
    if (fresh) await pushLinked(db, fresh, token);
  }
  return version;
}

// ---------------------------------------------------------------------------------------------
// Orb → GitHub

/**
 * After a new version (any builder's, or a hand edit): send it to the world's repository; a world
 * without one gets one if its owner keeps every world on GitHub. Quietly does nothing otherwise.
 */
export async function pushRepo(db: Db, worldId: string): Promise<void> {
  const link = await getLink(db, worldId);
  const [w] = await db.query<WorldOwner>(`select owner_user, owner_device, kind from orb_worlds where id = $1`, [worldId]);
  if (!w || w.kind !== 'native' || isOrbs(w)) return;
  const token = await tokenOf(db, w.owner_user, w.owner_device);
  if (!token) return;
  try {
    if (link) await pushLinked(db, link, token);
    else if (await autoOf(db, w)) await keepOnGitHub(db, worldId, token);
  } catch (e) {
    if (link) await recordFailure(db, worldId, e);
    else console.error('[orb] keeping a world on GitHub failed', worldId, e instanceof Error ? e.message : e);
  }
}

async function autoOf(db: Db, w: WorldOwner): Promise<boolean> {
  const rows = await db.query<{ auto: boolean }>(`select auto from orb_github_tokens where owner = any($1::text[]) and auto`, [keyOf(w.owner_user, w.owner_device)]);
  return rows.length > 0;
}

async function pushLinked(db: Db, link: RepoLink, token: string): Promise<void> {
  const now = await worldTree(db, link.world_id);
  if (!now || now.tree === link.synced_tree) {
    if (link.state !== 'ok') await setState(db, link.world_id, 'ok', null);
    return;
  }
  const head = await remoteHead(link.repo, link.branch, token);
  if (!head) throw new SyncError(`${link.repo} (${link.branch}) can't be found.`);
  // GitHub moved since the last agreement: bring that in first (it pushes the merge back)
  if (head.sha !== link.synced_sha) {
    await pullLinked(db, link);
    return;
  }
  const base: Tree = (link.synced_tree && (await getTree(db, link.synced_tree))) || {};
  const changes = new Map<string, string | null>();
  for (const p of new Set([...Object.keys(base), ...Object.keys(now.files)])) {
    if (base[p] === now.files[p]) continue;
    // a license imported from the repository's top while the world lives in a subfolder stays where it is
    if (link.root && LICENSE_FILE.test(p)) continue;
    changes.set(p, now.files[p] ?? null);
  }
  const [v] = await db.query<{ prompt: string | null }>(`select prompt from orb_world_versions where world_id = $1 and version = $2`, [link.world_id, now.version]);
  const title = (v?.prompt ?? '').split('\n')[0].trim().slice(0, 72) || `Version ${now.version}`;
  const message = `${title}\n\nVersion ${now.version} of ${now.name} on Orb: ${SITE}/w/${link.world_id}`;
  const sha = await commitChanges(db, token, link, head.sha, changes, message);
  if (!sha) return;
  await db.query(`update orb_world_repos set synced_sha = $2, synced_tree = $3, pushed_at = now(), state = 'ok', note = null where world_id = $1`, [link.world_id, sha, now.tree]);
}

// ---------------------------------------------------------------------------------------------
// Everyone's links, now and then

/** Check the linked worlds not checked for a while (/api/cron/github). */
export async function sweepRepos(db: Db, limit = 8): Promise<number> {
  const due = await db.query<{ world_id: string }>(
    `select world_id from orb_world_repos where checked_at is null or checked_at < now() - make_interval(secs => $1) order by checked_at nulls first limit $2`,
    [SWEEP_EVERY_S, limit],
  );
  for (const d of due) await pullRepo(db, d.world_id).catch(() => null);
  return due.length;
}
