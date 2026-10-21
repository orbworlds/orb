#!/usr/bin/env node
// The one-time setup of Orb's GitHub App (the orbworlds org's), with an org owner's token
// (ORB_GITHUB_TOKEN: Secrets and Variables, read and write, on the org's repositories) and, for Orb's
// server, a Vercel token. Only settings nobody sees in the public repositories, so the owner stays
// out of them.
//
//   ORB_GITHUB_TOKEN=… ORB_APP_ID=… ORB_APP_KEY=… [VERCEL_TOKEN=…] node scripts/setup-org.mjs
//
//   - orbworlds/orb-private's Actions: the variable ORB_APP_ID and the secret ORB_APP_KEY, for the
//     Public workflow (.github/workflows/public.yml, scripts/publish-public.mjs);
//   - with VERCEL_TOKEN, Orb's production environment: ORB_APP_ID and ORB_APP_KEY, which Orb's
//     server uses to read its Originals' repositories while they're private (src/server/reposync.ts).
//   ORB_APP_KEY may be the key file's text or only its base64 body; it is stored as the PEM.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pemKey } from './org-app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORG = JSON.parse(fs.readFileSync(path.join(root, 'src/data/originals.json'), 'utf8')).org;
const token = process.env.ORB_GITHUB_TOKEN ?? '';
const appId = process.env.ORB_APP_ID ?? '';
const appKey = (process.env.ORB_APP_KEY ?? '').trim() ? pemKey(process.env.ORB_APP_KEY) : '';
const vercelToken = process.env.VERCEL_TOKEN || process.env.ORB_VERCEL_TOKEN || '';
if (!token || !appId || !appKey) {
  console.error('Needs ORB_GITHUB_TOKEN (an org owner’s), ORB_APP_ID and ORB_APP_KEY (Orb’s GitHub App).');
  process.exit(1);
}

async function gh(method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data };
}
const ok = (r, what) => {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.data?.message ?? ''}`);
  return r.data;
};

/** An Actions secret, sealed with the repository's public key (libsodium's sealed box, as GitHub asks). */
async function setSecret(repo, name, value) {
  const { default: sodium } = await import('libsodium-wrappers');
  await sodium.ready;
  const key = ok(await gh('GET', `/repos/${ORG}/${repo}/actions/secrets/public-key`), 'public key');
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL));
  ok(await gh('PUT', `/repos/${ORG}/${repo}/actions/secrets/${name}`, { encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL), key_id: key.key_id }), `secret ${name}`);
  console.log(`  ${ORG}/${repo}: secret ${name}`);
}

async function setVariable(repo, name, value) {
  const made = await gh('POST', `/repos/${ORG}/${repo}/actions/variables`, { name, value });
  if (made.status === 409) ok(await gh('PATCH', `/repos/${ORG}/${repo}/actions/variables/${name}`, { name, value }), `variable ${name}`);
  else ok(made, `variable ${name}`);
  console.log(`  ${ORG}/${repo}: variable ${name}`);
}

console.log(`${ORG}/orb-private (the Public workflow)`);
await setVariable('orb-private', 'ORB_APP_ID', appId);
await setSecret('orb-private', 'ORB_APP_KEY', appKey);

if (vercelToken) {
  // Orb's server: production's ORB_APP_ID and ORB_APP_KEY (sensitive), replaced if they're there
  const V = 'https://api.vercel.com', project = process.env.VERCEL_PROJECT || 'orb';
  const vh = { authorization: `Bearer ${vercelToken}`, 'content-type': 'application/json' };
  const team = process.env.VERCEL_TEAM_ID ? `teamId=${process.env.VERCEL_TEAM_ID}` : '';
  const proj = await fetch(`${V}/v9/projects/${project}?${team}`, { headers: vh }).then((r) => r.json());
  const q = `teamId=${proj.accountId}`;
  const envs = (await fetch(`${V}/v9/projects/${project}/env?${q}`, { headers: vh }).then((r) => r.json())).envs ?? [];
  for (const [key, value] of [['ORB_APP_ID', appId], ['ORB_APP_KEY', appKey]]) {
    for (const e of envs.filter((x) => x.key === key)) await fetch(`${V}/v9/projects/${project}/env/${e.id}?${q}`, { method: 'DELETE', headers: vh });
    const r = await fetch(`${V}/v10/projects/${project}/env?${q}`, { method: 'POST', headers: vh, body: JSON.stringify({ key, value, type: 'sensitive', target: ['production'] }) });
    if (!r.ok) throw new Error(`Vercel ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    console.log(`  Vercel ${project} (production): ${key}`);
  }
} else console.log('  no VERCEL_TOKEN: Orb’s server reads only its Originals’ public repositories');
