'use client';
// Runs a build and yields its output as it streams. Every build is an agent job on Orb's server
// (POST /api/agent/jobs): it works on the world's files with Orb's AI or the person's own key
// (held encrypted only while the job runs), saves versions of the world itself and goes on
// without the page. The page follows its output, can reconnect to it (even days later) and stop it.
import type { BuildHandle, BuildRequest, BuildStep, ModelProvider, ModelSettings, ProbeAction, ProbeResult, ProbeUnavailable } from '../types';
import { deviceHeaders } from '../api';
import { cleanProbeActions } from '../probe';
import { KEY_DEFAULT_MODELS } from './prompt';

export type BuildErrorCode = 'rate_limited' | 'ai_unavailable' | 'out_of_credits' | 'bad_key' | 'network' | 'aborted' | 'unknown';

export class BuildError extends Error {
  readonly code: BuildErrorCode;
  /** Seconds until another build is allowed (rate limits). */
  readonly retryAfter?: number;
  /** The HTTP status Orb's server answered with, when it did. */
  readonly status?: number;
  constructor(code: BuildErrorCode, message: string, retryAfter?: number, status?: number) {
    super(message);
    this.name = 'BuildError';
    this.code = code;
    this.retryAfter = retryAfter;
    this.status = status;
  }
}

export const DEFAULT_MODELS: Record<'anthropic' | 'openrouter' | 'openai' | 'cursor', string> = { cursor: 'claude-sonnet-5-5', ...KEY_DEFAULT_MODELS };

/** Abort reason for "stop listening" (unmount) as opposed to the user pressing Stop. */
export const DETACH = 'orb:detach';

const PROVIDER_NAMES: Record<Exclude<ModelProvider, 'free'>, string> = {
  cursor: 'Cursor',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
};

export interface AgentVersion {
  worldId: string;
  version: number;
  tree: string;
  name?: string;
}

/** The agent wants to see the world run with these files (and played with these actions). */
export interface AgentLook {
  /** The agent job, where the answer goes. */
  job: string;
  id: string;
  tree: string;
  actions: ProbeAction[];
  /** Longest side of the screenshots. */
  size: number;
  shots: number;
  viewport?: 'phone';
}

/** Answer one of an agent job's looks (what the world showed, or why it can't be seen). */
export async function sendLookAnswer(job: string, id: string, answer: { result: ProbeResult } | ProbeUnavailable): Promise<void> {
  const res = await fetch(`/api/agent/jobs/${encodeURIComponent(job)}/look`, {
    method: 'POST',
    headers: deviceHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ id, ...answer }),
  });
  if (!res.ok && res.status !== 409) console.warn('[orb] could not send what the world looked like', res.status);
}

export interface BuildHooks {
  /** The chat message this build answers: the traces of its rounds are grouped by it (src/server/traces.ts). */
  traceGroup?: string;
  /** The build runs on Orb's server and can be reconnected to (after a reload) through this. */
  onHandle?(handle: BuildHandle): void;
  /** The AI is thinking before it writes (shown as "Thinking…"). */
  onStatus?(thought?: string): void;
  /** A file change started, got its label, or finished. */
  onStep?(step: BuildStep): void;
  /** The files changed (a new tree to preview). */
  onTree?(tree: string): void;
  /** The server saved a new version of the world. */
  onVersion?(v: AgentVersion): void;
  /** The agent asks to see the world run (answered by the page showing it). */
  onLook?(look: AgentLook): void;
  /** That look is over (a page replaying the output must not answer it). */
  onLooked?(id: string): void;
}

/** Which AI the job runs on: Orb's (no headers), or the person's own key and model. */
function agentHeaders(settings: ModelSettings): Record<string, string> {
  const provider = settings.provider;
  if (provider === 'free') return {};
  const apiKey = settings.apiKey?.trim();
  if (!apiKey) throw new BuildError('bad_key', `Add your ${PROVIDER_NAMES[provider]} key in You → Model.`);
  if (provider === 'cursor') {
    return {
      'x-orb-agent-provider': 'cursor',
      'x-orb-agent-key': apiKey,
      'x-orb-agent-model': settings.model?.trim() || DEFAULT_MODELS.cursor,
      ...(settings.params ? { 'x-orb-cursor-params': JSON.stringify(settings.params) } : {}),
    };
  }
  return {
    'x-orb-agent-provider': provider,
    'x-orb-agent-key': apiKey,
    ...(settings.model?.trim() ? { 'x-orb-agent-model': settings.model.trim() } : {}),
    ...(settings.params?.effort ? { 'x-orb-agent-effort': settings.params.effort } : {}),
  };
}

const entryCache = new Map<string, Promise<string>>();

/** The page (index.html) of a file tree. */
export function loadTreeEntry(tree: string): Promise<string> {
  let p = entryCache.get(tree);
  if (!p) {
    p = fetch(`/api/tree/${tree}/index.html`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`tree ${r.status}`))));
    p.catch(() => entryCache.delete(tree));
    entryCache.set(tree, p);
    if (entryCache.size > 40) entryCache.delete(entryCache.keys().next().value!);
  }
  return p;
}

/** Stream a build. Throws BuildError for every failure (including 'aborted' when `signal` fires). */
export async function* runBuild(req: BuildRequest, settings: ModelSettings, signal: AbortSignal, hooks: BuildHooks = {}): AsyncGenerator<string> {
  if (signal.aborted) throw new BuildError('aborted', 'Stopped.');
  const group: Record<string, string> = hooks.traceGroup ? { 'x-orb-trace-group': hooks.traceGroup } : {};
  const headers = agentHeaders(settings);
  yield* runServer(
    () =>
      checked(
        () =>
          fetch('/api/agent/jobs', {
            method: 'POST',
            headers: deviceHeaders({ 'content-type': 'application/json', ...headers, ...group }),
            body: JSON.stringify(req),
            cache: 'no-store',
            signal,
          }),
        signal,
      ),
    signal,
    hooks,
  );
}

/**
 * Reconnect to a build that is still running on the server (the page reloaded mid-build) and
 * stream its output from the very beginning, then live.
 */
export async function* resumeBuild(handle: BuildHandle, settings: ModelSettings, signal: AbortSignal, hooks: BuildHooks = {}): AsyncGenerator<string> {
  if (signal.aborted) throw new BuildError('aborted', 'Stopped.');
  hooks.onHandle?.(handle);
  yield* runServer(() => reconnect(handle.id, 0, signal), signal, hooks, handle);
}

function isAbort(e: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError'));
}

/** Control frames in a build stream (keep-alives, handles, resume tickets) start with this. */
const CONTROL = '\u001e';
/** Reconnect attempts after the connection drops mid-build (≈ 1 minute in total). */
const RECONNECTS = [1000, 2000, 3000, 5000, 8000, 10000, 15000, 15000];

/** Where to continue a job's output (the server hands one over when a request ends before the job). */
type Ticket = { id: string; from: number };

function reconnect(id: string, from: number, signal: AbortSignal): Promise<Response> {
  return checked(() => fetch(`/api/agent/jobs/${encodeURIComponent(id)}?from=${from}`, { headers: deviceHeaders(), cache: 'no-store', signal }), signal);
}

/** Tell the server the user pressed Stop (a closed page doesn't stop a build; this does). */
function cancelOnServer(handle: BuildHandle): void {
  void fetch(`/api/agent/jobs/${encodeURIComponent(handle.id)}/cancel`, { method: 'POST', headers: deviceHeaders({ 'content-type': 'application/json' }), keepalive: true }).catch(() => {});
}

/**
 * Stream a build that runs on Orb's server: follow resume tickets across requests, reconnect when
 * the connection drops (the build keeps going on the server meanwhile), and cancel it on Stop.
 */
async function* runServer(open: () => Promise<Response>, signal: AbortSignal, hooks: BuildHooks, known: BuildHandle | null = null): AsyncGenerator<string> {
  let handle = known;
  let received = 0;
  // Stop (not a page that merely stops listening) ends the build on the server too.
  const onStop = () => handle && signal.reason !== DETACH && cancelOnServer(handle);
  signal.addEventListener('abort', onStop, { once: true });
  try {
    let res = await open();
    let drops = 0;
    for (;;) {
      const stream = readBuildStream(res, signal, (h) => {
        handle = h;
        hooks.onHandle?.(h);
      }, hooks);
      let ticket: Ticket | null = null;
      try {
        for (;;) {
          const r = await stream.next();
          if (r.done) {
            ticket = r.value;
            break;
          }
          received += r.value.length;
          drops = 0;
          yield r.value;
        }
      } catch (e) {
        // The connection dropped. The build goes on on the server: reconnect and continue.
        if (!(e instanceof BuildError) || e.code !== 'network' || !handle || signal.aborted || drops >= RECONNECTS.length) throw e;
        await waitForRetry(RECONNECTS[drops++], signal);
        res = await reconnect(handle.id, received, signal);
        continue;
      }
      if (!ticket) return;
      // A long build outlives one request: continue where the last one stopped, for as long as the
      // AI keeps working (the server ends builds that stop making progress).
      res = await reconnect(ticket.id, ticket.from, signal);
    }
  } finally {
    signal.removeEventListener('abort', onStop);
  }
}

/** Wait `ms` (and until the browser is back online), unless stopped. */
async function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
  for (let i = 0; i < 60 && typeof navigator !== 'undefined' && navigator.onLine === false && !signal.aborted; i++) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (signal.aborted) throw new BuildError('aborted', 'Stopped.');
}

/** Run a fetch and turn every failure into a BuildError with a friendly message. */
async function checked(run: () => Promise<Response>, signal: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await run();
  } catch (e) {
    if (isAbort(e, signal)) throw new BuildError('aborted', 'Stopped.');
    throw new BuildError('network', "Couldn't reach Orb — check your connection and try again.");
  }
  if (res.ok) return res;

  let body: { error?: string; message?: string; retryAfter?: number } = {};
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  if (res.status === 429 || body.error === 'rate_limited') {
    const header = Number(res.headers.get('retry-after'));
    const retryAfter = Number.isFinite(body.retryAfter) && body.retryAfter! > 0 ? body.retryAfter! : Number.isFinite(header) && header > 0 ? header : 60;
    throw new BuildError('rate_limited', body.message || 'Orb needs a little break — try again soon.', Math.ceil(retryAfter), res.status);
  }
  if (res.status === 402 || body.error === 'out_of_credits') {
    throw new BuildError('out_of_credits', body.message || "You're out of credits for now.", undefined, res.status);
  }
  if (res.status === 401 || body.error === 'bad_key') {
    throw new BuildError('bad_key', body.message || 'That key was rejected — check it in You → Model.', undefined, res.status);
  }
  if (res.status === 503 || body.error === 'ai_unavailable') {
    throw new BuildError('ai_unavailable', body.message || 'The free builder is unavailable right now.', undefined, res.status);
  }
  if (!body.message && (res.status === 504 || res.status === 502)) {
    throw new BuildError('ai_unavailable', 'The AI took too long to answer and the connection timed out. Try again — or a faster model or lower effort in You → Model.', undefined, res.status);
  }
  throw new BuildError('unknown', body.message || `Something went wrong on Orb's side (error ${res.status}). Please try again.`, undefined, res.status);
}

/** Yield the text of a build stream; returns a resume ticket if the server handed one over. */
async function* readBuildStream(res: Response, signal: AbortSignal, onHandle: (h: BuildHandle) => void, hooks: BuildHooks = {}): AsyncGenerator<string, Ticket | null> {
  if (!res.body) throw new BuildError('network', 'The build stream was empty.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let finished = false;
  let pending = '';
  let ticket: Ticket | null = null;
  const frame = (json: string) => {
    try {
      const f = JSON.parse(json) as Record<string, unknown>;
      const str = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : '');
      if (f.t === 'handle' && f.kind === 'agent' && str('id')) onHandle({ kind: 'agent', id: str('id') });
      else if (f.t === 'resume' && f.kind === 'agent' && str('id')) ticket = { id: str('id'), from: Number(f.from) || 0 };
      else if (f.t === 'step' && str('id') && (f.status === 'pending' || f.status === 'done' || f.status === 'failed'))
        hooks.onStep?.({ id: str('id'), kind: f.kind === 'write' ? 'write' : 'edit', label: str('label').slice(0, 80) || 'A change', status: f.status, ...(str('error') ? { error: str('error').slice(0, 200) } : {}) });
      else if (f.t === 'tree' && /^[a-f0-9]{64}$/.test(str('tree'))) hooks.onTree?.(str('tree'));
      else if (f.t === 'version' && str('worldId') && /^[a-f0-9]{64}$/.test(str('tree')) && Number.isInteger(f.version))
        hooks.onVersion?.({ worldId: str('worldId'), version: Number(f.version), tree: str('tree'), ...(str('name') ? { name: str('name').slice(0, 120) } : {}) });
      else if (f.t === 'status' && f.phase === 'thinking') hooks.onStatus?.(str('text').slice(0, 200) || undefined);
      else if (f.t === 'look' && /^[\w-]{6,40}$/.test(str('id')) && /^[\w-]{10,64}$/.test(str('job')) && /^[a-f0-9]{64}$/.test(str('tree')))
        hooks.onLook?.({
          job: str('job'),
          id: str('id'),
          tree: str('tree'),
          actions: cleanProbeActions(f.actions).actions,
          size: Math.min(1600, Math.max(256, Number(f.size) || 1024)),
          shots: Math.min(6, Math.max(1, Math.floor(Number(f.shots) || 4))),
          ...(f.viewport === 'phone' ? { viewport: 'phone' as const } : {}),
        });
      else if (f.t === 'looked' && str('id')) hooks.onLooked?.(str('id'));
    } catch {
      /* malformed frame: ignore */
    }
  };
  // Split control frames (CONTROL + JSON + "\n") out of the text, in order: the text before a frame
  // is handed on before the frame is (a frame may span chunks).
  function* take(chunk: string): Generator<string> {
    let text = pending + chunk;
    pending = '';
    for (;;) {
      const i = text.indexOf(CONTROL);
      if (i === -1) {
        if (text) yield text;
        return;
      }
      if (i > 0) yield text.slice(0, i);
      const nl = text.indexOf('\n', i);
      if (nl === -1) {
        pending = text.slice(i);
        return;
      }
      frame(text.slice(i + 1, nl));
      text = text.slice(nl + 1);
    }
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      yield* take(decoder.decode(value, { stream: true }));
    }
    finished = true;
    yield* take(decoder.decode());
  } catch (e) {
    if (isAbort(e, signal)) throw new BuildError('aborted', 'Stopped.');
    throw new BuildError('network', 'The connection dropped while building — try again.');
  } finally {
    // Consumer stopped early (or we failed): release the connection.
    if (!finished) reader.cancel().catch(() => {});
  }
  return ticket;
}
