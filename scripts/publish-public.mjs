#!/usr/bin/env node
// Orb's public repository: this repository's files as they are on main, published by the org's
// GitHub App (its bot), so no person's account or address appears there. This repository keeps
// the history, the pull requests and the private workflows; the public one gets one commit per
// push to main, with the change's title (no PR numbers, no co-author lines).
//
//   ORB_APP_ID=… ORB_APP_KEY=… node scripts/publish-public.mjs [--dry] [--force]
//
// Left out: this workflow (.github/workflows/public.yml) and anything git ignores. The other
// workflows go along and run only there (each checks github.repository). ORB_PUBLIC_REPO names the public repository (orbworlds/orb); it is never
// the repository this runs from.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appLogin, api, gitAs } from './org-app.mjs';

const REPO = process.env.ORB_PUBLIC_REPO || 'orbworlds/orb';
const EXCLUDE = [/^\.github\/workflows\/public\.yml$/, /^\.cursor\//];
const dry = process.argv.includes('--dry');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const here = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

/** Lines that name people or sessions: trailers (Co-authored-by, Signed-off-by, Reviewed-by…), sessions. */
const TRAILER = /^([\w-]+-by|claude-session|cursor-session):/i;
/** Titles GitHub writes for merges, which name the branch's owner ("Merge pull request #3 from someone/branch"). */
const MERGE_TITLE = /^(Merge pull request #\d+ from \S+|Merge branch '[^']*'( of \S+)?( into \S+)?|Merge remote-tracking branch '[^']*')\s*$/i;

/** The change's title and body as the public repository tells it. */
export function publicMessage(raw) {
  let lines = raw
    .split('\n')
    .filter((l) => !TRAILER.test(l.trim()))
    .join('\n')
    .trim()
    .split('\n');
  // A GitHub merge's title names whose branch it was: the pull request's own title (the body's first line) instead.
  if (MERGE_TITLE.test(lines[0]?.trim() ?? '')) lines = lines.slice(1).join('\n').trim().split('\n');
  const title = (lines[0] || 'Update').replace(/^Merge PR #\d+:\s*/i, '').replace(/\s*\(#\d+\)$/, '').trim() || 'Update';
  const body = lines.slice(1).join('\n').replace(/\(#\d+\)/g, '').trim();
  return body ? `${title}\n\n${body}` : title;
}

/**
 * What must never be published: deployment addresses that name a Vercel team, session links, and
 * whatever ORB_PUBLISH_DENY lists (comma-separated, any case: names, handles, addresses — kept in
 * the workflow's secrets, never in this file).
 */
export function denied(text, deny = process.env.ORB_PUBLISH_DENY ?? '') {
  const words = deny
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 3);
  const lower = text.toLowerCase();
  const hit = words.find((w) => lower.includes(w));
  if (hit) return 'a denied word';
  if (/[\w-]+-projects\.vercel\.app/i.test(text)) return 'a Vercel team address';
  if (/claude\.ai\/code\/session_/i.test(text)) return 'a session link';
  return null;
}

const origin = (() => {
  try {
    return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(here('remote', 'get-url', 'origin'))?.[1] ?? '';
  } catch {
    return '';
  }
})();
for (const self of [process.env.GITHUB_REPOSITORY, origin]) {
  if (self && self.toLowerCase() === REPO.toLowerCase()) throw new Error(`${REPO} is the repository this runs from, not its public copy. Set ORB_PUBLIC_REPO.`);
}

const files = here('ls-files', '-z').split('\0').filter((f) => f && !EXCLUDE.some((re) => re.test(f)) && fs.existsSync(path.join(root, f)));
const message = publicMessage(here('log', '-1', '--format=%B'));
// Nothing goes public that names someone: the message and every text file are checked first.
const leaks = [];
const why = denied(message);
if (why) leaks.push(`the commit message has ${why}`);
for (const f of files) {
  const buf = fs.readFileSync(path.join(root, f));
  if (buf.length > 4 * 1024 * 1024 || buf.subarray(0, 8000).includes(0)) continue; // big or binary
  const hit = denied(buf.toString('utf8'));
  if (hit) leaks.push(`${f} has ${hit}`);
}
if (leaks.length) throw new Error(`Not published:\n- ${leaks.join('\n- ')}`);
if (dry) {
  console.log(`${files.length} files → ${REPO}\n\n${message}`);
  process.exit(0);
}

const app = await appLogin(REPO.split('/')[0]);
const gh = api(app.token);
const { git, commit } = gitAs(app);
const info = await gh('GET', `/repos/${REPO}`);
if (info.status === 404) throw new Error(`${REPO} doesn't exist (or the app can't see it).`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-public-'));
// GitHub answers an empty repository's commits with 409
const empty = !info.data.size && (await gh('GET', `/repos/${REPO}/commits?per_page=1`).catch(() => ({ status: 409 }))).status !== 200;
if (!empty && !process.argv.includes('--force')) {
  // a change merged there (a contributor's pull request) would be undone by publishing over it
  const head = (await gh('GET', `/repos/${REPO}/commits/main`)).data;
  if (!/orbworlds\[bot\]@users\.noreply\.github\.com$/.test(head?.commit?.author?.email ?? '')) {
    throw new Error(`${REPO} has a change that wasn't published from here (${head?.sha?.slice(0, 7)}: ${(head?.commit?.message ?? '').split('\n')[0]}). Bring it into this repository first, then publish again (--force publishes over it).`);
  }
}
if (empty) {
  git(dir, 'init', '--quiet', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`);
} else {
  git(os.tmpdir(), 'clone', '--quiet', '--depth', '1', `https://github.com/${REPO}.git`, dir);
}
for (const f of git(dir, 'ls-files', '-z').split('\0').filter(Boolean)) fs.rmSync(path.join(dir, f), { force: true });
for (const f of files) {
  fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
  fs.copyFileSync(path.join(root, f), path.join(dir, f));
}
git(dir, 'add', '-A');
if (!git(dir, 'status', '--porcelain')) {
  console.log(`${REPO} already has these files.`);
  process.exit(0);
}
commit(dir, empty ? 'Orb' : message);
git(dir, 'push', '--quiet', 'origin', 'HEAD:main');
console.log(`Published ${files.length} files to ${REPO}: ${empty ? 'Orb' : message.split('\n')[0]}`);
