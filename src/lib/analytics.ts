'use client';
// Product analytics for Orb's own dashboard (/lab/<key>/analytics). `track(name, props)` queues an
// event (a snake_case name and a few short values) and the queue goes to POST /api/events a few
// seconds later — at once when the tab is hidden or the page goes away, through
// navigator.sendBeacon (which can't set headers, so the device key rides in the body there).
// Every event carries the tab's visit (a session id in sessionStorage, new after 30 idle minutes),
// the path without its query string or fragment (prompts and sign-in tokens ride there) and,
// unless it names one in `world_id`, the world on screen. Page views: see trackPageView.
// Does nothing during SSR or on the secret pages (/lab, /dev), and never throws.

import { onPhone } from './keyboard';
import { getDeviceKey } from './local';

type Value = string | number | boolean | null;
export type TrackProps = Record<string, Value | undefined>;

interface Queued {
  name: string;
  t: number;
  session: string;
  path: string;
  world?: string;
  props?: Record<string, Value>;
  ref?: string;
}

const ENDPOINT = '/api/events';
const FLUSH_MS = 4000;
const IDLE_MS = 30 * 60_000;
const MAX_QUEUE = 200;
const MAX_BATCH = 50;
/** A page's pending keepalive requests may carry 64 KB in all. */
const MAX_BATCH_CHARS = 30_000;
const MAX_PROPS_CHARS = 2000;
const VISIT_KEY = 'orb:visit';
const NAME = /^[a-z][a-z0-9_]{1,39}$/;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const SECRET = /^\/(lab|dev)(\/|$)/;
const UTM = ['utm_source', 'utm_medium', 'utm_campaign'] as const;

let queue: Queued[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let installed = false;
let visit: { id: string; last: number } | null = null;
/** Path of the last page view, and whether this page load had its first one. */
let viewed: string | null = null;
let landed = false;
let worldOnScreen: () => string | null = () => null;
const leaving = new Set<() => void>();

/** Record an event (see the list in SPEC.md §6 "Analytics"). */
export function track(name: string, props?: TrackProps): void {
  record(name, props);
}

/**
 * Count a page view of the current address, unless it's the page counted last. The first one of a
 * page load says where the visitor came from: another site's referrer and any utm_ parameters.
 * Called on load, on in-app navigations (history.pushState) and on the browser's back/forward.
 */
export function trackPageView(): void {
  try {
    if (typeof window === 'undefined' || location.pathname === viewed) return;
    viewed = location.pathname;
    if (SECRET.test(viewed)) return;
    if (landed) return record('page_view');
    landed = true;
    const props: TrackProps = { landing: true };
    const params = new URLSearchParams(location.search);
    for (const k of UTM) props[k] = params.get(k)?.slice(0, 100) || undefined;
    record('page_view', props, externalReferrer());
  } catch {
    /* analytics never get in the way */
  }
}

/** The address changed within the same page (history.replaceState): not a new page view. */
export function sameView(): void {
  if (typeof window !== 'undefined') viewed = location.pathname;
}

/** Events other than page views carry this world unless they name one. */
export function setWorldContext(get: () => string | null): void {
  worldOnScreen = get;
}

/** Run `fn` when the tab is hidden or the page goes away, just before the queue is sent. */
export function onLeave(fn: () => void): () => void {
  leaving.add(fn);
  install();
  return () => leaving.delete(fn);
}

/** Send what's queued now (`beacon`: the page may be going away). */
export function flush(beacon = false): void {
  try {
    if (timer) clearTimeout(timer);
    timer = null;
    while (queue.length) {
      const batch: Queued[] = [];
      let chars = 0;
      while (queue.length && batch.length < MAX_BATCH) {
        const size = JSON.stringify(queue[0]).length;
        if (batch.length && chars + size > MAX_BATCH_CHARS) break;
        batch.push(queue.shift()!);
        chars += size;
      }
      send(batch, beacon);
    }
  } catch {
    queue = [];
  }
}

function record(name: string, props?: TrackProps, ref?: string): void {
  try {
    if (typeof window === 'undefined' || !NAME.test(name) || SECRET.test(location.pathname)) return;
    const now = Date.now();
    const { world_id, ...rest } = props ?? {};
    const world = world_id !== undefined ? world_id : name === 'page_view' ? null : worldOnScreen();
    const e: Queued = { name, t: now, session: session(now), path: location.pathname.slice(0, 200) };
    if (typeof world === 'string' && world) e.world = world.slice(0, 64);
    const clean = cleanProps(rest);
    if (clean) e.props = clean;
    if (ref) e.ref = ref;
    install();
    queue.push(e);
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    if (queue.length >= MAX_BATCH) flush();
    else if (!timer) timer = setTimeout(() => flush(), FLUSH_MS);
  } catch {
    /* analytics never get in the way */
  }
}

function cleanProps(props: TrackProps): Record<string, Value> | null {
  const out: Record<string, Value> = {};
  let n = 0;
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || !KEY.test(k) || (typeof v === 'object' && v !== null)) continue;
    out[k] = typeof v === 'string' ? v.slice(0, 300) : typeof v === 'number' && !Number.isFinite(v) ? null : v;
    n++;
  }
  return n && JSON.stringify(out).length <= MAX_PROPS_CHARS ? out : null;
}

/** The tab's visit: kept across reloads, a new one after 30 minutes without events. */
function session(now: number): string {
  if (!visit) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(VISIT_KEY) || 'null') as { id?: unknown; last?: unknown } | null;
      if (saved && typeof saved.id === 'string' && typeof saved.last === 'number') visit = { id: saved.id, last: saved.last };
    } catch {
      /* no sessionStorage: the visit lasts as long as the page */
    }
  }
  if (!visit || !(now - visit.last <= IDLE_MS)) visit = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 10)}`, last: now };
  visit.last = now;
  saveVisit();
  return visit.id;
}

function saveVisit(): void {
  try {
    sessionStorage.setItem(VISIT_KEY, JSON.stringify(visit));
  } catch {
    /* ignore */
  }
}

function externalReferrer(): string | undefined {
  try {
    const r = document.referrer ? new URL(document.referrer) : null;
    return r && r.origin !== location.origin ? `${r.origin}${r.pathname}`.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

function send(events: Queued[], beacon: boolean): void {
  const device = getDeviceKey();
  if (!device) return;
  const body = { sent: Date.now(), mobile: onPhone(), events };
  if (beacon && typeof navigator.sendBeacon === 'function') {
    try {
      if (navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify({ ...body, device })], { type: 'application/json' }))) return;
    } catch {
      /* fall back to fetch */
    }
  }
  void fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orb-device': device },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const leave = () => {
    for (const fn of leaving) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    flush(true);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') leave();
  });
  window.addEventListener('pagehide', leave);
  window.addEventListener('popstate', () => trackPageView());
  // A tab in view stays one visit, however long nothing is clicked (a world being played).
  setInterval(() => {
    if (visit && document.visibilityState === 'visible') {
      visit.last = Date.now();
      saveVisit();
    }
  }, 60_000);
}
