'use client';
// Game progress that follows signed-in people to every device: each world's storage (what its
// localStorage holds, kept by src/lib/runtime/bridge.ts) goes up to the account a few seconds after
// it changes (at once when the page goes away), and a world being opened takes the account's copy
// when that is newer. People without an account keep their progress in this browser. Websites
// shown as worlds keep their own storage.
import { deviceHeaders } from './api';
import { getWorldStorage, getWorldStorageAt, listWorldStorage, onWorldStorageSaved } from './local';
import { flushWorldStorage, isDraftWorldId } from './runtime/bridge';

/** Set while this browser is signed in, so a world opened before /api/me answers can ask the account. */
const HINT = 'orb:saves-account';
/** Requests that outlive the page carry at most 64 KB. */
const KEEPALIVE_MAX = 60_000;

let signedIn = false;
let known = false;
let markKnown: () => void = () => {};
const knownYet = new Promise<void>((resolve) => (markKnown = resolve));
let unsubscribe: (() => void) | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let hooked = false;

function hinted(): boolean {
  try {
    return localStorage.getItem(HINT) === '1';
  } catch {
    return false;
  }
}

function hint(on: boolean): void {
  try {
    if (on) localStorage.setItem(HINT, '1');
    else localStorage.removeItem(HINT);
  } catch {
    /* storage blocked */
  }
}

async function push(worldId: string, leaving = false): Promise<void> {
  clearTimeout(timers.get(worldId));
  timers.delete(worldId);
  if (!signedIn || isDraftWorldId(worldId)) return;
  const body = JSON.stringify({ data: getWorldStorage(worldId), at: getWorldStorageAt(worldId) ?? Date.now() });
  await fetch(`/api/saves/${encodeURIComponent(worldId)}`, {
    method: 'PUT',
    headers: deviceHeaders({ 'content-type': 'application/json' }),
    body,
    keepalive: leaving && body.length <= KEEPALIVE_MAX,
  }).catch(() => {});
}

function schedule(worldId: string): void {
  if (!signedIn || isDraftWorldId(worldId)) return;
  clearTimeout(timers.get(worldId));
  timers.set(worldId, setTimeout(() => void push(worldId), 4000));
}

/** The page goes away: write what worlds hold, and send what hasn't gone up yet. */
function leave(): void {
  flushWorldStorage();
  for (const id of [...timers.keys()]) void push(id, true);
}

function hookPage(): void {
  if (hooked || typeof window === 'undefined') return;
  hooked = true;
  window.addEventListener('pagehide', leave);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && leave());
}

/**
 * The account's copy of a world's progress, if it is newer than this browser's (null otherwise,
 * or when it can't be had in time). This browser's own newer copy goes up instead.
 */
export async function pullSave(worldId: string, timeoutMs = 4000): Promise<{ data: Record<string, string>; at: number } | null> {
  if (isDraftWorldId(worldId)) return null;
  const started = Date.now();
  // Signed in last time: ask right away (the server checks the session). Else wait until it's known
  // (/api/me, right after the page starts).
  if (!known && !hinted()) await Promise.race([knownYet, new Promise((r) => setTimeout(r, timeoutMs))]);
  if (known ? !signedIn : !hinted()) return null;
  const local = getWorldStorageAt(worldId) ?? 0;
  try {
    const res = await fetch(`/api/saves/${encodeURIComponent(worldId)}?since=${local}`, {
      headers: deviceHeaders(),
      cache: 'no-store',
      signal: AbortSignal.timeout(Math.max(500, timeoutMs - (Date.now() - started))),
    });
    if (res.status === 200) {
      const save = (await res.json()) as { data?: Record<string, string>; at?: number };
      return save.data && typeof save.at === 'number' ? { data: save.data, at: save.at } : null;
    }
    if (res.status === 204 && local > (Number(res.headers.get('x-orb-save-at')) || 0) && Object.keys(getWorldStorage(worldId)).length) schedule(worldId);
  } catch {
    /* offline or slow: play on with this browser's copy */
  }
  return null;
}

/**
 * Call with the current sign-in state (on start, after sign-in/up, after sign-out). Signed in,
 * what this browser saved that the account doesn't have yet (or has older) goes up.
 */
export async function setSaveSync(isSignedIn: boolean): Promise<void> {
  signedIn = isSignedIn;
  known = true;
  markKnown();
  hint(isSignedIn);
  if (!isSignedIn) {
    unsubscribe?.();
    unsubscribe = null;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    return;
  }
  hookPage();
  unsubscribe ??= onWorldStorageSaved(schedule);
  try {
    const res = await fetch('/api/saves', { headers: deviceHeaders(), cache: 'no-store' });
    if (!res.ok) return;
    const { saves } = (await res.json()) as { saves: Array<{ worldId: string; at: number }> };
    const theirs = new Map(saves.map((s) => [s.worldId, s.at]));
    const newer = listWorldStorage().filter((s) => !isDraftWorldId(s.worldId) && (!theirs.has(s.worldId) || s.at > theirs.get(s.worldId)!));
    await Promise.all(newer.slice(0, 50).map((s) => push(s.worldId)));
  } catch {
    /* next start */
  }
}
