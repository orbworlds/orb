// Cursor's Cloud Agents API (https://api.cursor.com): Cursor API keys (crsr_…) drive agents, not a
// chat-completions endpoint. Starting an agent, following and cancelling its runs, and the model
// catalog — for Cursor builds (./agent/cursor.ts): the free builder on Orb's own key, and people's
// own Cursor keys.

import { withDeadline } from './signals';

export const BASE = process.env.ORB_CURSOR_API || 'https://api.cursor.com'; // overridable for tests
const TERMINAL = new Set(['FINISHED', 'COMPLETED', 'ERROR', 'FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'STOPPED']);

export const DEFAULT_CURSOR_MODEL = process.env.ORB_CURSOR_MODEL || 'claude-opus-5-5';

export class CursorError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function authHeaders(apiKey: string): Record<string, string> {
  // Cursor documents Basic auth with the key as the username (curl -u KEY:). An empty key sends no
  // Authorization header (for environments whose egress proxy injects the credential).
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) h.Authorization = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  return h;
}

export async function call<T>(apiKey: string, method: string, path: string, body: unknown, signal: AbortSignal, timeoutMs = 30000): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: authHeaders(apiKey),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: withDeadline(signal, timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      const m = j.message ?? j.error ?? j;
      msg = typeof m === 'string' ? m : JSON.stringify(m).slice(0, 300);
    } catch {}
    throw new CursorError(res.status, `Cursor API ${res.status} (${method} ${path.split('?')[0]}): ${msg}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    }, { once: true });
  });

interface AgentInfo {
  id: string;
  name?: string;
  latestRunId?: string;
}
interface RunInfo {
  id: string;
  status: string;
  result?: string;
  error?: string | { message?: string };
}

export interface CursorRequest {
  apiKey: string;
  /** The whole instruction (agents take a single prompt). */
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  model?: string;
  /** Model options as Cursor lists them per model (e.g. effort, fast, thinking). */
  modelParams?: Array<{ id: string; value: string }>;
  signal: AbortSignal;
  /** Upper bound for the whole run. */
  maxWaitMs?: number;
}

/** A started agent run. */
export interface CursorRun {
  agentId: string;
  runId: string;
}

/**
 * Create a Cursor Cloud Agent for this prompt and return its
 * run. Resolves once Cursor accepted the agent (bad keys / models fail here, before it works).
 */
export async function startCursorAgent(req: CursorRequest): Promise<CursorRun> {
  const name = `orb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const body: Record<string, unknown> = {
    name,
    prompt: { text: req.text, ...(req.images?.length ? { images: req.images.slice(0, 5).map((i) => ({ data: i.data, mimeType: i.mimeType })) } : {}) },
    model: { id: req.model || DEFAULT_CURSOR_MODEL, ...(req.modelParams?.length ? { params: req.modelParams } : {}) },
  };
  const deadline = Date.now() + (req.maxWaitMs ?? 280000);

  // The create call can take a long time to answer (it may wait for the agent to boot, and
  // proxies may give up first), but the agent and its run exist much sooner. So race it against a
  // lookup by the agent's unique name, and stream as soon as either knows the run.
  const local = new AbortController();
  const signal = AbortSignal.any([req.signal, local.signal]);
  let createFailed: unknown = null;
  const created = call<{ agent?: AgentInfo; run?: RunInfo; id?: string; latestRunId?: string }>(req.apiKey, 'POST', '/v1/agents', body, signal, 90000).then(
    (c) => {
      const agent = c.agent ?? (c.id ? (c as AgentInfo) : null);
      const runId = c.run?.id ?? agent?.latestRunId;
      return agent && runId ? { agentId: agent.id, runId } : null;
    },
    (e: unknown) => {
      // 4xx = a real rejection (bad key, bad model): fail fast. Timeouts and gateway errors fall
      // through to the name lookup.
      if (e instanceof CursorError && e.status < 500) createFailed = e;
      return null;
    },
  );
  const lookup = async (): Promise<{ agentId: string; runId: string } | null> => {
    await sleep(1500, signal);
    for (;;) {
      if (createFailed) throw createFailed;
      if (Date.now() > deadline) throw new CursorError(504, 'Cursor agent did not start in time');
      const list = await call<{ items?: AgentInfo[] }>(req.apiKey, 'GET', '/v1/agents?limit=20', undefined, signal).catch((e: unknown) => {
        if (e instanceof CursorError && (e.status === 401 || e.status === 403)) throw e;
        return null;
      });
      const found = list?.items?.find((a) => a.name === name);
      if (found?.latestRunId) return { agentId: found.id, runId: found.latestRunId };
      await sleep(1500, signal);
    }
  };
  try {
    const first = await Promise.race([created.then((r) => r ?? (createFailed ? Promise.reject(createFailed) : lookup())), lookup()]);
    if (!first) throw new CursorError(502, 'Cursor agent did not start');
    return first;
  } finally {
    // Stop the loser (the create request itself has already been received by Cursor).
    local.abort();
  }
}

export const runPath = (run: CursorRun) => `/v1/agents/${encodeURIComponent(run.agentId)}/runs/${encodeURIComponent(run.runId)}`;

export interface SseEvent {
  id?: string;
  event: string;
  data: string;
}

/** Minimal Server-Sent Events reader. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      let i: number;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev: SseEvent = { event: 'message', data: '' };
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (!line || line.startsWith(':')) continue;
          const c = line.indexOf(':');
          const field = c === -1 ? line : line.slice(0, c);
          const val = c === -1 ? '' : line.slice(c + 1).replace(/^ /, '');
          if (field === 'event') ev.event = val;
          else if (field === 'data') data.push(val);
          else if (field === 'id') ev.id = val;
        }
        ev.data = data.join('\n');
        yield ev;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Wait (until `until`) for a run to reach a terminal state; null if it is still running. */
export async function waitForRun(apiKey: string, run: CursorRun, signal: AbortSignal, until: number): Promise<(RunInfo & { durationMs?: number }) | null> {
  let delay = 1200;
  while (Date.now() < until) {
    try {
      const info = await call<RunInfo & { durationMs?: number }>(apiKey, 'GET', runPath(run), undefined, signal);
      if (TERMINAL.has(String(info.status || '').toUpperCase())) return info;
    } catch (e) {
      if (signal.aborted || (e instanceof CursorError && e.status < 500)) throw e;
    }
    await sleep(delay, signal);
    delay = Math.min(delay + 300, 3000);
  }
  return null;
}

/** The user pressed Stop: end the run on Cursor. */
export async function cancelCursorRun(apiKey: string, run: CursorRun): Promise<void> {
  await call(apiKey, 'POST', `${runPath(run)}/cancel`, {}, AbortSignal.timeout(10000), 10000).catch(() => undefined);
}

/** A Cursor failure in the person's words, with the HTTP answer it maps to (bad key, out of usage, …). */
export function describeCursorError(e: unknown): { status: number; code: 'bad_key' | 'rate_limited' | 'bad_request' | 'ai_unavailable'; message: string } {
  const status = e instanceof CursorError ? e.status : 0;
  const raw = e instanceof Error ? e.message : String(e);
  // "Cursor API 403 (POST /v1/agents): <Cursor's words>" → Cursor's words
  const why = raw.replace(/^Cursor API \d+ \([^)]*\):\s*/, '').slice(0, 240);
  const usage = /usage|credit|quota|billing|spend|payment|plan|limit exceeded|insufficient/i.test(why);
  if (status === 402 || (usage && (status === 403 || status === 429)))
    return { status: 503, code: 'ai_unavailable', message: `Cursor says your account is out of usage (${why}). Check your plan at cursor.com/dashboard, or switch to another AI in You → Model.` };
  if (status === 429) return { status: 429, code: 'rate_limited', message: `Cursor is asking us to slow down (${why}). Try again in a minute.` };
  if (status === 401 || status === 403) return { status: 401, code: 'bad_key', message: `Cursor didn't accept that API key (${why}). Check it in You → Model.` };
  if (status === 400 || status === 404 || status === 422) return { status: 400, code: 'bad_request', message: `Cursor couldn't start this build: ${why}` };
  if (status === 504) return { status: 503, code: 'ai_unavailable', message: 'Cursor took too long to start the agent. Try again in a moment.' };
  return { status: 503, code: 'ai_unavailable', message: `Cursor couldn't finish this build: ${why}` };
}

// --- model catalog ---------------------------------------------------------------------------

export interface CursorModelOption {
  id: string;
  name: string;
  values: Array<{ value: string; label: string }>;
  /** Cursor's default for this option (from the model's default variant), if any. */
  default?: string;
}
export interface CursorModel {
  id: string;
  name: string;
  options: CursorModelOption[];
}

interface RawModel {
  id: string;
  displayName?: string;
  parameters?: Array<{ id: string; displayName?: string; values?: Array<{ value: string; displayName?: string }> }>;
  variants?: Array<{ params?: Array<{ id: string; value: string }>; isDefault?: boolean }>;
}

/** Reasoning effort of builds on Orb's own key (ORB_CURSOR_EFFORT). */
const SERVER_EFFORT = (process.env.ORB_CURSOR_EFFORT || 'low').trim();
let catalog: { at: number; items: RawModel[] } | null = null;

/**
 * Options for a build on Orb's own Cursor key: ORB_CURSOR_EFFORT, the smaller context window and
 * thinking on — each only where the model has it, so ORB_CURSOR_MODEL can be any model. Without
 * the catalog, Cursor's defaults for the model apply.
 */
export async function serverCursorParams(apiKey: string, model: string, signal: AbortSignal): Promise<Array<{ id: string; value: string }> | undefined> {
  try {
    if (!catalog || Date.now() - catalog.at > 3_600_000) {
      const raw = await call<{ items?: RawModel[] }>(apiKey, 'GET', '/v1/models', undefined, signal, 10_000);
      catalog = { at: Date.now(), items: raw.items ?? [] };
    }
  } catch (e) {
    console.error('[orb] Cursor model catalog unavailable', e instanceof Error ? e.message : e);
    return undefined;
  }
  const out: Array<{ id: string; value: string }> = [];
  for (const p of catalog.items.find((m) => m.id === model)?.parameters ?? []) {
    const values = (p.values ?? []).map((v) => v.value);
    const want = p.id === 'reasoning_effort' || p.id === 'effort' ? SERVER_EFFORT : p.id === 'context' ? values[0] : p.id === 'thinking' ? 'true' : undefined;
    if (want && values.includes(want)) out.push({ id: p.id, value: want });
  }
  return out.length ? out : undefined;
}

/** The models a Cursor key can use, with their options, simplified for Orb's settings UI. */
export async function listCursorModels(apiKey: string, signal: AbortSignal): Promise<CursorModel[]> {
  const raw = await call<{ items?: RawModel[] }>(apiKey, 'GET', '/v1/models', undefined, signal, 20000);
  return (raw.items ?? [])
    .filter((m) => m.id && m.id !== 'default')
    .map((m) => {
      const def = m.variants?.find((v) => v.isDefault)?.params ?? [];
      return {
        id: m.id,
        name: m.displayName || m.id,
        options: (m.parameters ?? [])
          .filter((p) => p.id !== 'context' && (p.values?.length ?? 0) > 1) // worlds are small: no 1M-context upsell
          .map((p) => ({
            id: p.id,
            name: p.displayName || p.id,
            values: (p.values ?? []).map((v) => ({ value: v.value, label: v.displayName || (v.value === 'true' ? 'On' : v.value === 'false' ? 'Off' : v.value) })),
            default: def.find((d) => d.id === p.id)?.value,
          })),
      };
    });
}
