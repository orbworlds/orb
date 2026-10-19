// Orb on GitHub, for the scripts that change the orbworlds org (sync-org.mjs, game-shots.mjs): its
// GitHub App (ORB_APP_ID, and its private key as ORB_APP_KEY), so whatever they make or push there
// is by the app's bot and no person's account appears. git is given the token as a header, never in
// a URL or .git/config.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const API = 'https://api.github.com';

/** A private key as PEM, also from a secret holding only its base64 body (or its newlines as `\n`). */
function pemKey(key) {
  const k = key.trim().replace(/\\n/g, '\n');
  if (k.includes('-----BEGIN')) return `${k}\n`;
  return `-----BEGIN RSA PRIVATE KEY-----\n${k.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').trim()}\n-----END RSA PRIVATE KEY-----\n`;
}

/** The app's installation token for the org (an hour), its id and its bot's commit identity. */
export async function appLogin(org, appId = process.env.ORB_APP_ID, key = process.env.ORB_APP_KEY) {
  if (!appId || !key) throw new Error('Needs ORB_APP_ID and ORB_APP_KEY (the org’s GitHub App).');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const jwt = `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), pemKey(key)).toString('base64url')}`;
  const call = async (method, url) => {
    const res = await fetch(`${API}${url}`, { method, headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GitHub App ${method} ${url}: ${res.status} ${data.message ?? ''}`);
    return data;
  };
  const app = await call('GET', '/app');
  const installation = await call('GET', `/orgs/${org}/installation`);
  const { token } = await call('POST', `/app/installations/${installation.id}/access_tokens`);
  const bot = await fetch(`${API}/users/${encodeURIComponent(`${app.slug}[bot]`)}`).then((r) => r.json());
  return { token, appId: Number(appId), identity: { name: `${app.slug}[bot]`, email: `${bot.id}+${app.slug}[bot]@users.noreply.github.com` } };
}

/** The REST API with that token: { status, data } (404 isn't an error). */
export function api(token) {
  return async (method, url, body) => {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok && res.status !== 404) throw new Error(`GitHub ${method} ${url}: ${res.status} ${data?.message ?? text.slice(0, 200)}`);
    return { status: res.status, data };
  };
}

/** git as the app: clone, commit (as its bot) and push. */
export function gitAs({ token, identity }) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` };
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
  return {
    git,
    clone: (repo, dir) => git(process.cwd(), 'clone', '--quiet', `https://github.com/${repo}.git`, dir),
    commit: (cwd, message) => git(cwd, '-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '--quiet', '-m', message),
  };
}
