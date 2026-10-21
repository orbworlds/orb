#!/usr/bin/env node
// The orb command: dev, test, share, push, login, logout (usage at the end; README → Commands).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, serve } from '../lib/server.mjs';

const SITE = 'https://orbworlds.com';
const [cmd = 'dev', ...rest] = process.argv.slice(2);

/** The value after `name` in the arguments (both taken out of them), else `fallback`. */
const flag = (name, fallback) => {
  const i = rest.indexOf(name);
  return i < 0 ? fallback : rest.splice(i, 2)[1];
};

const orbJson = (dir) => readJson(path.join(dir, 'orb.json')) ?? {};

/** The folder to serve: the world itself, or for a project its package (tools/package.mjs <out>). */
function worldDir(dir) {
  const tool = path.join(dir, 'tools/package.mjs');
  if (!fs.existsSync(tool)) return dir;
  const out = path.join(dir, '.orb');
  execFileSync(process.execPath, [tool, out], { stdio: 'inherit' });
  return out;
}

/** Where to push: ORB_SITE, else orb.json's world page's site, else Orb. */
function siteOf(dir) {
  if (process.env.ORB_SITE) return process.env.ORB_SITE.replace(/\/$/, '');
  const meta = orbJson(dir);
  try {
    return meta.url ? new URL(meta.url).origin : SITE;
  } catch {
    return SITE;
  }
}

/** owner/repo of the git remote `origin` on GitHub, or null. */
function githubRepo() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

if (cmd === 'dev') {
  const port = Number(flag('--port', process.env.PORT || 4242));
  const host = flag('--host', '127.0.0.1');
  try {
    await serve({ dir: worldDir(rest[0] || '.'), port, host });
  } catch (e) {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is taken: try --port ${port + 1}` : e.message);
    process.exit(1);
  }
} else if (cmd === 'test') {
  const shot = flag('--shot', null);
  const { smoke } = await import('../lib/smoke.mjs');
  const problems = await smoke(worldDir(rest[0] || '.'), { shot });
  for (const p of problems) console.log(`✗ ${p}`);
  console.log(problems.length ? `\n${problems.length} problem${problems.length === 1 ? '' : 's'}` : '✓ it loads, draws, and nothing throws');
  process.exit(problems.length ? 1 : 0);
} else if (cmd === 'share') {
  const meta = orbJson('.');
  const site = meta.url ? new URL(meta.url).origin : SITE;
  const repo = githubRepo();
  if (!repo) {
    console.log('Push this folder to a GitHub repository first (git remote "origin").');
    process.exit(1);
  }
  const upstream = meta.repo && meta.repo.toLowerCase() === repo.toLowerCase();
  console.log(`\n  ${meta.name || 'This world'} on Orb\n`);
  if (meta.url) console.log(`  Play the original:     ${meta.url}`);
  if (meta.url) console.log(`  Remix it on Orb:       ${meta.url}?remix`);
  if (!upstream) {
    console.log(`  Play your version:     ${site}/?import=${encodeURIComponent(`github.com/${repo}`)}`);
    console.log('\n  Your version opens as a world of your own on Orb, credited as a remix of the original,');
    console.log('  and follows your repository from then on. Push your changes first: Orb reads what is on GitHub.');
  }
  console.log('');
} else if (cmd === 'push') {
  const message = flag('-m', flag('--message', null));
  const fresh = rest.includes('--new');
  const shot = !rest.includes('--no-shot');
  const folder = rest.find((a) => !a.startsWith('--')) || '.';
  const { push } = await import('../lib/push.mjs');
  try {
    const res = await push({ dir: worldDir(folder), project: folder, site: siteOf(folder), message, fresh, shot });
    if (!res) process.exit(2);
    const said = { created: 'Made a new world on Orb', remixed: 'Made your remix on Orb', updated: `Pushed version ${res.world.version}`, unchanged: 'Nothing changed since the last push' }[res.outcome];
    console.log(`✓ ${said}: ${res.world.name}
  ${res.url}`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
} else if (cmd === 'login') {
  const { signIn } = await import('../lib/push.mjs');
  try {
    const token = await signIn(siteOf('.'));
    if (!token) process.exit(2);
    console.log('✓ This computer can push to Orb.');
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
} else if (cmd === 'logout') {
  const { signOut } = await import('../lib/push.mjs');
  console.log(signOut(siteOf('.')) ? '✓ Signed out: this computer no longer pushes to Orb.' : 'This computer wasn’t signed in.');
} else {
  console.log('Usage:\n  orb dev [folder] [--port 4242] [--host 127.0.0.1]   play a world locally (two tabs: two players)\n  orb test [folder] [--shot file.png]                run it headless: it has to draw, and nothing may throw\n  orb share                                          links that open this repository on Orb\n  orb push [folder] [-m message] [--new] [--no-shot]  put it on Orb as you (signs in the first time)\n  orb login | orb logout                             sign this computer in or out');
  process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1);
}
