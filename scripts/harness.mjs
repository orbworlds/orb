// What Orb's test scripts share: a tiny test framework (check, skip, section, finish), a `next dev`
// of their own (startNext, stopNext), requests as a device or an account (client), and passkeys in
// a page (addAuthenticator, inPage). The browser itself is the kit's (kit/lib/browser.mjs).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- checks ----------------------------------------------------------------------------------

const results = [];
/** `details: true` prints what a check saw when it passes too, not only when it fails. */
export const options = { details: false };

export function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  const shown = detail !== undefined && (!ok || options.details);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${shown ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

export function skip(name, why) {
  console.log(`  - ${name} (skipped: ${why})`);
}

// ORB_TEST_ONLY=<substring> runs only the sections whose title contains it.
const ONLY = (process.env.ORB_TEST_ONLY || '').toLowerCase();
export async function section(title, fn) {
  if (ONLY && !title.toLowerCase().includes(ONLY)) return;
  console.log(`\n${title}`);
  try {
    await fn();
  } catch (e) {
    check(`${title}: unexpected exception`, false, e?.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
  }
}

/** Say how many checks passed and which failed (then `onFail()`), and exit: 0 when all passed. */
export function finish({ onFail } = {}) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log(`Failed:\n${failed.map((f) => `  - ${f.name}`).join('\n')}`);
    onFail?.();
  }
  process.exit(failed.length ? 1 : 0);
}

// ---- next dev ----------------------------------------------------------------------------------

/**
 * `next dev -p <port>` of the test's own: this process's environment without `unset` and never a
 * real database (POSTGRES_URL, DATABASE_URL), with `env` over it. Ready once `ready` (a path that
 * answers OK, or an async check) says so; gives up with the end of its log if it exits early or
 * isn't ready in 3 minutes. `echo` writes its stderr through.
 */
export async function startNext({ port, env = {}, unset = [], ready = '/api/config', echo = false }) {
  const childEnv = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
  for (const k of ['POSTGRES_URL', 'DATABASE_URL', ...unset]) delete childEnv[k];
  Object.assign(childEnv, env);
  const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '-p', String(port)], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  const keep = (d) => (log = (log + d).slice(-20_000));
  child.stdout.on('data', keep);
  child.stderr.on('data', (d) => {
    keep(d);
    if (echo) process.stderr.write(d);
  });
  const server = { child, log: () => log };
  const isReady = typeof ready === 'function' ? ready : async () => (await fetch(`http://localhost:${port}${ready}`, { signal: AbortSignal.timeout(90_000) })).ok;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next dev exited early:\n${log.slice(-2000)}`);
    if (await isReady().catch(() => false)) return server;
    await sleep(1000);
  }
  await stopNext(server);
  throw new Error(`next dev did not become ready:\n${log.slice(-2000)}`);
}

/** Stop a server from startNext (null: one this test didn't start) and wait for it to go. */
export async function stopNext(server) {
  const child = server?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  await Promise.race([exited, sleep(15_000)]);
}

// ---- requests ------------------------------------------------------------------------------------

/** A fresh device key. */
export const device = (label) => `test-${label}-${crypto.randomBytes(8).toString('hex')}`;
/** The fake Cursor's newest agent (scripts/fake-cursor-github.mjs). */
export const newest = (fake) => [...fake.agents.values()].at(-1);

const BLANK = '<!doctype html><html><head><title>world</title></head><body>hi</body></html>';

/** Requests to the server at `base` as a device (`dev`) and/or an account (`cookie`). */
export function client(base) {
  /** → { status, text, json, headers, cookie }: `body` goes as JSON, `raw` as is; `cookie` is a new session's. */
  async function request(method, urlPath, { dev, body, cookie, headers: extra, raw } = {}) {
    const headers = { ...(dev ? { 'x-orb-device': dev } : {}), ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...extra };
    const res = await fetch(base + urlPath, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined), redirect: 'manual', signal: AbortSignal.timeout(120_000) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, text, json, headers: res.headers, cookie: /orb_session=[^;]+/.exec(res.headers.get('set-cookie') || '')?.[0] ?? null };
  }
  return {
    request,
    build: (dev, worldId, content, opts = {}) => request('POST', '/api/agent/jobs', { dev, ...opts, body: { worldId, messages: [{ role: 'user', content }], mode: 'build', code: '' } }),
    newWorld: async (dev, cookie) => (await request('POST', '/api/worlds', { dev, cookie, body: { name: 'Untitled world', code: BLANK } })).json.world,
  };
}

// ---- passkeys in a page ------------------------------------------------------------------------

/** Chrome's virtual authenticator for `page` (ctap2, internal, resident keys, the person verified). */
export async function addAuthenticator(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

/** Run `fn(arg)` in the page → { ok, value } or { ok: false, error }. */
export function inPage(page, fn, arg) {
  return page.evaluate(
    async ({ src, arg }) => {
      try {
        return { ok: true, value: await new Function('arg', `return (${src})(arg)`)(arg) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    { src: fn.toString(), arg },
  );
}
