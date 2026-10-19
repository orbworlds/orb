#!/usr/bin/env node
// In sandboxes, run with NODE_USE_ENV_PROXY=1 so fetch honours HTTPS_PROXY (see package.json "deploy").
// Deploy the current git-tracked tree to Vercel via the REST API (remote build).
// Usage: node scripts/deploy.mjs [--prod] [--include-untracked]
// Auth: api.vercel.com credentials are injected by the environment's proxy (or set VERCEL_TOKEN).

import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT = process.env.VERCEL_PROJECT || 'orb';
const API = 'https://api.vercel.com';
const prod = process.argv.includes('--prod');
const includeUntracked = process.argv.includes('--include-untracked');
const headers = process.env.VERCEL_TOKEN ? { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` } : {};

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const list = execSync(`git ls-files ${includeUntracked ? '--others --exclude-standard --cached' : ''}`, { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => !f.startsWith('.data/') && !f.startsWith('worlds/') && fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile());

async function api(method, url, body, extra = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(API + url, { method, headers: { ...headers, ...extra }, body });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
      if (!res.ok && res.status >= 500) throw new Error(`${res.status} ${text.slice(0, 200)}`);
      return { status: res.status, json };
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}

const files = list.map((f) => {
  const buf = fs.readFileSync(path.join(root, f));
  return { file: f, sha: crypto.createHash('sha1').update(buf).digest('hex'), size: buf.length };
});

/** Upload these files (Vercel keeps them by sha; the free plan allows 5000 uploads a day). */
async function upload(todo) {
  const queue = [...todo];
  async function worker() {
    while (queue.length) {
      const f = queue.shift();
      const buf = fs.readFileSync(path.join(root, f.file));
      const { status, json } = await api('POST', '/v2/files', buf, {
        'Content-Type': 'application/octet-stream',
        'x-vercel-digest': f.sha,
        'Content-Length': String(buf.length),
      });
      if (status >= 300) throw new Error(`upload ${f.file} failed: ${status} ${JSON.stringify(json).slice(0, 200)}`);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
}

let sha = '';
try {
  sha = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim();
} catch {}
const create = () =>
  api(
    'POST',
    '/v13/deployments?skipAutoDetectionConfirmation=1',
    JSON.stringify({
      name: PROJECT,
      project: PROJECT,
      files,
      target: prod ? 'production' : undefined,
      projectSettings: { framework: 'nextjs' },
      meta: { gitCommitSha: sha, source: 'orb-deploy-script' },
    }),
    { 'Content-Type': 'application/json' },
  );
// Ask first: Vercel answers with the shas it doesn't have yet, and only those are uploaded.
let { status, json: dep } = await create();
if (status === 400 && dep?.error?.code === 'missing_files') {
  const missing = new Set(dep.error.missing ?? []);
  const todo = [...new Map(files.filter((f) => missing.has(f.sha)).map((f) => [f.sha, f])).values()];
  console.log(`Uploading ${todo.length} of ${files.length} files (Vercel has the rest)…`);
  await upload(todo);
  ({ status, json: dep } = await create());
} else console.log(`Vercel had all ${files.length} files.`);
if (status >= 300) {
  console.error('Deployment create failed', status, JSON.stringify(dep).slice(0, 2000));
  process.exit(1);
}
console.log(`Deployment ${dep.id} (${dep.url}) — building…`);

let state = dep.readyState;
const started = Date.now();
while (!['READY', 'ERROR', 'CANCELED'].includes(state)) {
  await new Promise((r) => setTimeout(r, 6000));
  const { json } = await api('GET', `/v13/deployments/${dep.id}`);
  state = json.readyState;
  process.stdout.write(`  ${state} ${Math.round((Date.now() - started) / 1000)}s\n`);
  if (Date.now() - started > 15 * 60 * 1000) break;
}

const { json: events } = await api('GET', `/v3/deployments/${dep.id}/events?builds=1&limit=-1`);
const lines = (Array.isArray(events) ? events : []).map((e) => (e.payload && e.payload.text) || e.text || '').filter(Boolean);
const logPath = path.join(root, '.data', `deploy-${dep.id}.log`);
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, lines.join('\n'));
if (state !== 'READY') {
  console.error(`\nDeployment ${state}. Last log lines:\n` + lines.slice(-60).join('\n'));
  process.exit(1);
}
console.log(`\nREADY: https://${dep.url}${prod ? '  (production → https://orbworld.vercel.app)' : ''}\nBuild log: ${logPath}`);
