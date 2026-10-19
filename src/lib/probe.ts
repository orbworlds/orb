// Probes: Orb's builder plays a world and looks at it (the runtime side is in runtime/sdk.ts).
// Shared by the page (which runs them in the world frame) and the server (the agent's `look` tool).

import type { ProbeAction, ProbeResult, ProbeZoom } from './types';

export const PROBE_LIMITS = {
  actions: 30,
  /** Longest single wait or key hold. */
  ms: 10_000,
  /** All the actions of one look together. */
  totalMs: 40_000,
  text: 300,
  js: 4000,
  shots: 4,
  /** Characters of one screenshot data URL. */
  shotChars: 2_500_000,
} as const;

// Probe results come from world code (and, on the server, from any page): keep only
// well-formed, bounded fields.

const LOG_LEVELS = new Set(['log', 'info', 'warn', 'debug', 'error']);
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const clipStr = (v: unknown, n: number): string => (typeof v === 'string' ? v.slice(0, n) : '');
const finite = (v: unknown, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);
const SHOT_RE = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+=*$/;

/** The data URL holds the image it says (a provider rejects the whole request for a broken one). */
function realImage(url: string): boolean {
  const m = /^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/]{16})/.exec(url);
  if (!m || !SHOT_RE.test(url)) return false;
  const head = atob(m[2]);
  if (m[1] === 'png') return head.slice(0, 4) === '\x89PNG';
  if (m[1] === 'jpeg') return head.slice(0, 3) === '\xff\xd8\xff';
  return head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WEBP';
}

export function cleanProbeResult(raw: unknown): ProbeResult {
  const r = obj(raw);
  const size = obj(r.size);
  const canvas = r.canvas ? obj(r.canvas) : null;
  return {
    size: { w: Math.round(finite(size.w, 0, 20000)), h: Math.round(finite(size.h, 0, 20000)), dpr: finite(size.dpr, 0, 8) || 1 },
    title: clipStr(r.title, 120),
    uptime: Math.round(finite(r.uptime, 0, 1e10)),
    fps: Math.round(finite(r.fps, 0, 1000)),
    ...(r.software === true ? { software: true } : {}),
    errors: arr(r.errors, 20).map((x) => {
      const e = obj(x);
      const line = Math.floor(finite(e.line, 0, 1e7));
      const source = clipStr(e.source, 300);
      return { message: clipStr(e.message, 500) || 'Unknown error', ...(line ? { line } : {}), ...(source ? { source } : {}), t: Math.round(finite(e.t, 0, 1e10)), during: e.during === true };
    }),
    logs: arr(r.logs, 30).map((x) => {
      const l = obj(x);
      const level = (LOG_LEVELS.has(l.level as string) ? l.level : 'log') as ProbeResult['logs'][number]['level'];
      return { level, text: clipStr(l.text, 300), t: Math.round(finite(l.t, 0, 1e10)) };
    }),
    dropped: Math.round(finite(r.dropped, 0, 1e9)),
    ui: arr(r.ui, 60).map((x) => {
      const u = obj(x);
      return { text: clipStr(u.text, 80), x: finite(u.x, -1, 2), y: finite(u.y, -1, 2), w: finite(u.w, 0, 3), h: finite(u.h, 0, 3), tag: clipStr(u.tag, 12), click: u.click === true };
    }),
    canvas: canvas ? { w: Math.round(finite(canvas.w, 0, 1e5)), h: Math.round(finite(canvas.h, 0, 1e5)), type: clipStr(canvas.type, 24), cover: finite(canvas.cover, 0, 1) } : null,
    focus: clipStr(r.focus, 80),
    locked: r.locked === true,
    shots: arr(r.shots, PROBE_LIMITS.shots + 2).map((x) => {
      const s = obj(x);
      const url = typeof s.dataUrl === 'string' && s.dataUrl.length < PROBE_LIMITS.shotChars && realImage(s.dataUrl) ? s.dataUrl : null;
      const zoom = s.zoom ? cleanZoom(s.zoom) : null;
      return { label: clipStr(s.label, 60), t: Math.round(finite(s.t, 0, 1e10)), dataUrl: url, ...(s.flat === true ? { flat: true } : {}), ...(zoom ? { zoom } : {}) };
    }),
    evals: arr(r.evals, 12).map((x) => {
      const e = obj(x);
      return { js: clipStr(e.js, 200), result: clipStr(e.result, 2000), ...(e.error === true ? { error: true } : {}) };
    }),
    notes: arr(r.notes, 12)
      .map((n) => clipStr(n, 200))
      .filter(Boolean),
  };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const pos = (v: unknown): number => Math.min(1, Math.max(0, num(v) ?? 0.5));
const ms = (v: unknown, def: number): number => Math.min(PROBE_LIMITS.ms, Math.max(0, num(v) ?? def));
const str = (v: unknown, n: number): string => (typeof v === 'string' ? v.slice(0, n) : '');
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** A part of the screen to zoom into (fractions), at least 5% of it on each side; null for the whole screen. */
export function cleanZoom(v: unknown): ProbeZoom | null {
  if (!v || typeof v !== 'object') return null;
  const z = v as Record<string, unknown>;
  const w = Math.min(1, Math.max(0.05, num(z.w) ?? 1));
  const h = Math.min(1, Math.max(0.05, num(z.h) ?? 1));
  if (w >= 1 && h >= 1) return null;
  const x = Math.min(1 - w, Math.max(0, num(z.x) ?? 0));
  const y = Math.min(1 - h, Math.max(0, num(z.y) ?? 0));
  return { x: round3(x), y: round3(y), w: round3(w), h: round3(h) };
}

/**
 * Actions as the model wrote them → well-formed ones (unknown kinds dropped, numbers clamped).
 * `skipped` counts what was dropped so the model can be told.
 */
export function cleanProbeActions(raw: unknown): { actions: ProbeAction[]; skipped: number } {
  const list = Array.isArray(raw) ? raw : [];
  const actions: ProbeAction[] = [];
  let skipped = 0;
  for (const item of list) {
    if (actions.length >= PROBE_LIMITS.actions) {
      skipped++;
      continue;
    }
    const a = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    switch (a.type) {
      case 'wait':
        actions.push({ type: 'wait', ms: ms(a.ms, 500) });
        break;
      case 'key': {
        const key = str(a.key, 40);
        if (!key) {
          skipped++;
          break;
        }
        const times = Math.min(30, Math.max(1, Math.floor(num(a.times) ?? 1)));
        actions.push({ type: 'key', key, ms: ms(a.ms, 120), ...(times > 1 ? { times } : {}) });
        break;
      }
      case 'type': {
        const text = str(a.text, PROBE_LIMITS.text);
        if (text) actions.push({ type: 'type', text });
        else skipped++;
        break;
      }
      case 'click':
        actions.push({ type: 'click', x: pos(a.x), y: pos(a.y), ...(a.button === 'right' ? { button: 'right' as const } : {}), ...(a.double === true ? { double: true } : {}), ...(a.touch === true ? { touch: true } : {}) });
        break;
      case 'move': {
        const dx = num(a.dx);
        const dy = num(a.dy);
        if (dx !== null || dy !== null) actions.push({ type: 'move', dx: Math.max(-5000, Math.min(5000, dx ?? 0)), dy: Math.max(-5000, Math.min(5000, dy ?? 0)), ms: ms(a.ms, 0) });
        else actions.push({ type: 'move', x: pos(a.x), y: pos(a.y), ms: ms(a.ms, 0) });
        break;
      }
      case 'drag':
        actions.push({ type: 'drag', x: pos(a.x), y: pos(a.y), to_x: pos(a.to_x), to_y: pos(a.to_y), ms: ms(a.ms, 400), ...(a.touch === true ? { touch: true } : {}) });
        break;
      case 'scroll':
        actions.push({ type: 'scroll', dy: Math.max(-5000, Math.min(5000, num(a.dy) ?? 100)), ...(a.x !== undefined ? { x: pos(a.x) } : {}), ...(a.y !== undefined ? { y: pos(a.y) } : {}) });
        break;
      case 'screenshot': {
        const zoom = cleanZoom(a.zoom);
        actions.push({ type: 'screenshot', ...(str(a.label, 60) ? { label: str(a.label, 60) } : {}), ...(zoom ? { zoom } : {}) });
        break;
      }
      case 'eval': {
        const js = str(a.js, PROBE_LIMITS.js);
        if (js.trim()) actions.push({ type: 'eval', js });
        else skipped++;
        break;
      }
      default:
        skipped++;
    }
  }
  // Keep the whole play-test within its time budget.
  let total = 0;
  const kept: ProbeAction[] = [];
  for (const a of actions) {
    if (total + actionMs(a) > PROBE_LIMITS.totalMs) {
      skipped++;
      continue;
    }
    total += actionMs(a);
    kept.push(a);
  }
  return { actions: kept, skipped };
}

/** About how long an action takes to play (ms). */
function actionMs(a: ProbeAction): number {
  switch (a.type) {
    case 'wait':
      return a.ms;
    case 'key':
      return ((a.ms ?? 120) + 60) * (a.times ?? 1);
    case 'type':
      return a.text.length * 20;
    case 'move':
    case 'drag':
      return (a.ms ?? 0) + 50;
    case 'eval':
      return 300;
    default:
      return 150;
  }
}

/** About how long a probe with these actions takes, including start-up and screenshots (ms). */
export function probeDuration(actions: ProbeAction[]): number {
  return 1500 + actions.reduce((sum, a) => sum + actionMs(a), 0);
}
