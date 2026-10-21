// Traces of AI builds — everything a build was asked, saw and did — kept to look back at how
// builds go: their quality, their cost, how they fail. Viewed and exported at /lab/<key>/traces.
//
// One trace per build run: an agent job (./agent/runner.ts; kind 'agent', or 'cursor' for a
// Cursor agent). Older traces may be 'build' (a single-shot /api/build request) or 'direct' (a
// round the browser ran with the person's own key), from before every build was an agent job.
// The rounds of one chat turn (a build and its repair round) share a group: the chat message's
// id, which the page sends as x-orb-trace-group.
//
// A trace is a row (orb_traces: who, which world and model, how it ended, token totals) and an
// append-only timeline (orb_trace_events). Each event has a small `summary` for SQL and its full
// payload as gzipped JSON. System prompts, world files and screenshots are content-addressed blobs
// (orb_trace_blobs), stored once and referenced from payloads as "orb-blob:<sha>".
//
// Recording never gets in a build's way: writes go on a queue per trace (in order, off the build's
// path), and failures are logged, never thrown. Builds await handOver() or end() only where their
// function may end (a tick handing over, a request finishing), and never for long.

import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { Db } from './db';
import { sha256 } from './files';

const zip = promisify(gzip);
const unzip = promisify(gunzip);

export type TraceKind = 'agent' | 'cursor' | 'build' | 'direct';
export type TraceStatus = 'running' | 'done' | 'failed' | 'cancelled';
const TRACE_KINDS: readonly string[] = ['agent', 'cursor', 'build', 'direct'];
const TRACE_STATUSES: readonly string[] = ['running', 'done', 'failed', 'cancelled'];

const BLOB_REF = 'orb-blob:';
const REF_RE = /^orb-blob:([a-f0-9]{64})$/;
/** The sha of an "orb-blob:<sha>" reference (null for anything else). */
export const blobSha = (s: unknown): string | null => (typeof s === 'string' ? (REF_RE.exec(s)?.[1] ?? null) : null);
export const isTraceId = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{6,120}$/.test(s);

/** Longest prompt kept on the trace row (the whole request is in its input event). */
const PROMPT_MAX = 12_000;
/** How long a build waits for its trace writes where its function may end. */
const FLUSH_MAX_MS = 8000;

/** The chat turn a build belongs to (x-orb-trace-group: the chat message's id). */
export function traceGroup(req: Request): string | null {
  const g = (req.headers.get('x-orb-trace-group') ?? '').trim();
  return /^[\w-]{6,64}$/.test(g) ? g : null;
}

// -- tokens -------------------------------------------------------------------------------------

/** Token counts as the AI SDK reports them (its LanguageModelUsage). */
export interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  outputTokenDetails?: { reasoningTokens?: number };
}

export interface Tokens {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

export function tokensOf(u: UsageLike | null | undefined): Tokens | undefined {
  if (!u) return undefined;
  return { in: count(u.inputTokens), out: count(u.outputTokens), cacheRead: count(u.inputTokenDetails?.cacheReadTokens), cacheWrite: count(u.inputTokenDetails?.cacheWriteTokens), reasoning: count(u.outputTokenDetails?.reasoningTokens) };
}

// -- blobs --------------------------------------------------------------------------------------

export interface TraceBlob {
  sha: string;
  data: Buffer;
  type: string | null;
}

/** A jsonb value as the driver gives it (parsed already, or as text). */
const json = <T>(v: unknown, fallback: T): T => (v == null ? fallback : typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));
const ref = (sha: string) => `${BLOB_REF}${sha}`;
const toBlob = (data: Buffer, type: string | null): TraceBlob => ({ sha: sha256(data), data, type });

// Shared by every bundle in the process (like ./db): one write queue per trace, and the blobs
// stored lately (not sent again; their used_at is fresh enough for pruning by days).
const shared = globalThis as typeof globalThis & { __orbTraces?: { queues: Map<string, Promise<void>>; stored: Map<string, number> } };
const state = (shared.__orbTraces ??= { queues: new Map(), stored: new Map() });
const STORED_FOR_MS = 6 * 3600_000;
const fresh = (sha: string) => (state.stored.get(sha) ?? 0) > Date.now() - STORED_FOR_MS;
function remember(sha: string): void {
  state.stored.delete(sha);
  state.stored.set(sha, Date.now());
  if (state.stored.size > 5000) state.stored.delete(state.stored.keys().next().value!);
}

async function putBlobs(db: Db, blobs: TraceBlob[]): Promise<void> {
  const seen = new Set<string>();
  for (const b of blobs) {
    if (seen.has(b.sha) || fresh(b.sha)) continue;
    seen.add(b.sha);
    await db.query(`insert into orb_trace_blobs (sha, data, size, media_type) values ($1, $2, $3, $4) on conflict (sha) do update set used_at = now()`, [b.sha, b.data, b.data.length, b.type]);
    remember(b.sha);
  }
}

const FILE_TYPES: Record<string, string> = { html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', md: 'text/markdown', txt: 'text/plain', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };
const fileType = (path: string): string | null => FILE_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? null;

/** A world's files (path → sha), their bytes copied from the world's own storage (orb_trees and orb_blobs, see ./files.ts). */
async function putTreeBlobs(db: Db, tree: string): Promise<Record<string, string> | null> {
  const rows = await db.query<{ files: unknown }>(`select files from orb_trees where sha = $1`, [tree]);
  if (!rows[0]) return null;
  const files = json<Record<string, string>>(rows[0].files, {});
  const types = new Map<string, string | null>();
  for (const [path, sha] of Object.entries(files)) if (!types.has(sha) && !fresh(sha)) types.set(sha, fileType(path));
  const shas = [...types.keys()];
  for (let i = 0; i < shas.length; i += 500) {
    const part = shas.slice(i, i + 500);
    const have = new Set((await db.query<{ sha: string }>(`update orb_trace_blobs set used_at = now() where sha = any($1::text[]) returning sha`, [part])).map((r) => r.sha));
    const missing = part.filter((s) => !have.has(s));
    if (missing.length) {
      await db.query(
        `insert into orb_trace_blobs (sha, data, size, media_type)
         select b.sha, b.data, b.size, m.type from orb_blobs b join unnest($1::text[], $2::text[]) as m(sha, type) on m.sha = b.sha
         on conflict (sha) do nothing`,
        [missing, missing.map((s) => types.get(s) ?? null)],
      );
    }
    part.forEach(remember);
  }
  return files;
}

const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+);base64,/;
const BASE64 = /^[A-Za-z0-9+/=\r\n]+$/;

/**
 * A JSON-ready copy of `v` with its bytes moved out to blobs: data URLs, base64 images of file
 * parts and byte arrays become "orb-blob:<sha>", and strings found in `refs` (a look's screenshot
 * references, see ./agent/look.ts) become the reference to their blob.
 */
export function stash(v: unknown, blobs: TraceBlob[], refs: Map<string, string> = new Map(), depth = 0): unknown {
  if (typeof v === 'string') {
    const known = refs.get(v);
    if (known) return known;
    const m = v.length > 64 ? DATA_URL.exec(v) : null;
    if (!m) return v;
    const b = toBlob(Buffer.from(v.slice(m[0].length), 'base64'), m[1]);
    blobs.push(b);
    return ref(b.sha);
  }
  if (v instanceof Uint8Array) {
    const b = toBlob(Buffer.from(v), null);
    blobs.push(b);
    return ref(b.sha);
  }
  if (Array.isArray(v)) return v.map((x) => stash(x, blobs, refs, depth + 1));
  if (!v || typeof v !== 'object' || depth > 60) return v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof URL) return v.href;
  if (v instanceof Error) return { name: v.name, message: v.message };
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) out[k] = stash(o[k], blobs, refs, depth + 1);
  // An image part's base64 text (AI SDK messages: `data` or `image`, or `data: { type: 'data', data }`).
  const type = typeof o.mediaType === 'string' ? o.mediaType : '';
  if (type.startsWith('image/')) {
    for (const key of ['data', 'image']) {
      const inner = out[key] && typeof out[key] === 'object' ? (out[key] as Record<string, unknown>) : null;
      const raw = inner ? inner.data : out[key];
      if (typeof raw !== 'string' || raw.length <= 64 || raw.startsWith(BLOB_REF) || !BASE64.test(raw.slice(0, 256))) continue;
      const b = toBlob(Buffer.from(raw, 'base64'), type);
      blobs.push(b);
      out[key] = inner ? { ...inner, data: ref(b.sha) } : ref(b.sha);
    }
  }
  return out;
}

/** `v` with every string passed through `fn` (deep). */
function mapStrings(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = mapStrings(x, fn);
  return out;
}

// -- what events say, in numbers ----------------------------------------------------------------

/** A step's messages in numbers: its tool calls (by name), failed tools, and characters of words and thinking. */
export function stepParts(messages: unknown[]): { tools: string[]; toolErrors: number; text: number; thinking: number } {
  const out = { tools: [] as string[], toolErrors: 0, text: 0, thinking: 0 };
  for (const m of messages as Array<{ role?: string; content?: unknown } | null>) {
    const own = m?.role === 'assistant';
    if (typeof m?.content === 'string') {
      if (own) out.text += m.content.length;
      continue;
    }
    if (!Array.isArray(m?.content)) continue;
    for (const p of m.content as Array<Record<string, unknown>>) {
      if (own && p.type === 'text' && typeof p.text === 'string') out.text += p.text.length;
      else if (own && p.type === 'reasoning' && typeof p.text === 'string') out.thinking += p.text.length;
      else if (p.type === 'tool-call' && typeof p.toolName === 'string') out.tools.push(p.toolName);
      else if (p.type === 'tool-error' || (p.type === 'tool-result' && /^error/.test(String((p.output as { type?: unknown } | undefined)?.type ?? '')))) out.toolErrors++;
    }
  }
  return out;
}

// -- recording ----------------------------------------------------------------------------------

function enqueue(id: string, what: string, task: () => Promise<unknown>): void {
  const next = (state.queues.get(id) ?? Promise.resolve())
    .then(task)
    .then(() => undefined)
    .catch((e: unknown) => console.error(`[orb] trace ${what} failed`, e instanceof Error ? e.message : e));
  state.queues.set(id, next);
  void next.then(() => {
    if (state.queues.get(id) === next) state.queues.delete(id);
  });
}

/** Wait for a trace's queued writes (for a little while at most). */
function flushTrace(id: string): Promise<void> {
  const q = state.queues.get(id);
  if (!q) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, FLUSH_MAX_MS);
    void q.then(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function insertEvent(db: Db, id: string, at: Date, type: string, summary: Record<string, unknown>, payload: unknown): Promise<void> {
  const json = payload === undefined ? null : JSON.stringify(payload);
  const params = [id, at, type, JSON.stringify(summary), json === null ? null : await zip(json), json === null ? 0 : Buffer.byteLength(json)];
  // Another invocation may be writing the same trace (a tick handing over): take the next number then.
  for (let attempt = 0; attempt < 4; attempt++) {
    const rows = await db.query(
      `insert into orb_trace_events (trace_id, seq, at, type, summary, payload, size)
       select $1::text, coalesce(max(seq) + 1, 0), $2::timestamptz, $3::text, $4::jsonb, $5::bytea, $6::int from orb_trace_events where trace_id = $1::text
       on conflict do nothing returning seq`,
      params,
    );
    if (rows.length) return;
  }
  throw new Error('no free sequence number');
}

// The row's totals, from its events (so a tick that died loses nothing it recorded).
const TOTALS = `s as (
  select count(*) filter (where type = 'step')::int + (count(*) filter (where type = 'output') > 0)::int as steps,
    coalesce(sum((summary->'usage'->>'in')::bigint), 0) as i, coalesce(sum((summary->'usage'->>'out')::bigint), 0) as o,
    coalesce(sum((summary->'usage'->>'cacheRead')::bigint), 0) as cr, coalesce(sum((summary->'usage'->>'cacheWrite')::bigint), 0) as cw,
    coalesce(sum((summary->'usage'->>'reasoning')::bigint), 0) as r,
    count(*) filter (where type = 'commit')::int as versions, count(*) filter (where type = 'look')::int as looks
  from orb_trace_events where trace_id = $1)`;
const TOTAL_SETS = `steps = s.steps, input_tokens = s.i, output_tokens = s.o, cache_read_tokens = s.cr, cache_write_tokens = s.cw, reasoning_tokens = s.r`;

export interface TraceHead {
  id: string;
  group?: string | null;
  kind: TraceKind;
  worldId?: string | null;
  owner?: { deviceHash: string | null; userId: string | null } | null;
  provider: string;
  model?: string | null;
  mode?: string;
  prompt?: string;
  meta?: Record<string, unknown>;
}

export interface TraceInput {
  /** The system prompt (stored once per distinct text). */
  system?: string | null;
  /** The conversation the build starts from (images move to blobs). */
  messages?: unknown[];
  /** The world's files when the build started (a tree, see ./files.ts). */
  tree?: string | null;
}

export interface Trace {
  readonly id: string;
  event(type: string, summary: Record<string, unknown>, payload?: unknown): void;
  /** One model call: the messages it added (words, thinking, tool calls and results), usage, timing. */
  step(s: { step?: number; messages: unknown[]; usage?: UsageLike; finishReason?: string; ms: number; modelId?: string }): void;
  /** A look at the world (./agent/look.ts): its actions and the whole answer, screenshots as blobs. */
  look(l: { lookId: string; callId: string; actions: unknown; skipped: number; answer: unknown; ms: number }): void;
  /** A failed model call: retried ('retry') or the end of the build ('error'). */
  error(e: { message: string; retry?: boolean; status?: number; waitMs?: number; failures?: number; step?: number; ms?: number }): void;
  /** The conversation was trimmed to fit (only recorded when it really changed). */
  compact(before: unknown[], after: unknown[]): void;
  /** Something worth knowing: a nudge the model got, a pause, a hand-over… */
  note(kind: string, detail?: Record<string, unknown>): void;
  commit(c: { version: number; tree: string; name?: string | null }): void;
  /** A tick or request ends with the build still going: note it, refresh the totals, flush. */
  handOver(detail?: Record<string, unknown>): Promise<void>;
  /** How it ended (the first end counts), then flush. `meta.tree`: the world's files at the end. */
  end(status: TraceStatus, error?: string | null, meta?: Record<string, unknown>): Promise<void>;
}

/** Record events on a trace (its row is made by startTrace). */
export function openTrace(db: Db, id: string): Trace {
  /** "orb-look:<look>:<n>" → that screenshot's blob, for the step that shows it. */
  const looks = new Map<string, string>();

  const add = (type: string, summary: Record<string, unknown>, payload: unknown, blobs: TraceBlob[] = []) => {
    const at = new Date();
    enqueue(id, type, async () => {
      if (blobs.length) await putBlobs(db, blobs);
      await insertEvent(db, id, at, type, summary, payload);
    });
  };
  const flush = () => flushTrace(id);

  const t: Trace = {
    id,
    event(type, summary, payload) {
      const blobs: TraceBlob[] = [];
      add(type, summary, payload === undefined ? undefined : stash(payload, blobs, looks), blobs);
    },
    step(s) {
      const blobs: TraceBlob[] = [];
      const messages = stash(s.messages, blobs, looks);
      add('step', { step: s.step, ms: s.ms, finish: s.finishReason, usage: tokensOf(s.usage), model: s.modelId, ...stepParts(s.messages) }, { ...s, messages }, blobs);
    },
    look(l) {
      const blobs: TraceBlob[] = [];
      const urls = new Map<string, string>();
      const a = (l.answer ?? {}) as { result?: { shots?: Array<{ dataUrl?: unknown } | null>; errors?: unknown[]; fps?: unknown }; unavailable?: unknown };
      const shots = Array.isArray(a.result?.shots) ? a.result.shots : [];
      let stored = 0;
      shots.forEach((s, n) => {
        const url = s?.dataUrl;
        const r = typeof url === 'string' ? stash(url, blobs) : null;
        if (typeof url !== 'string' || !blobSha(r)) return;
        urls.set(url, r as string);
        looks.set(`orb-look:${l.lookId}:${n}`, r as string);
        stored++;
      });
      const outcome = a.result ? 'seen' : typeof a.unavailable === 'string' ? 'unavailable' : 'timeout';
      const summary = { lookId: l.lookId, callId: l.callId, outcome, ms: l.ms, shots: stored, errors: a.result?.errors?.length, fps: a.result?.fps, reason: typeof a.unavailable === 'string' ? a.unavailable.slice(0, 200) : undefined };
      add('look', summary, stash(l, blobs, urls), blobs);
    },
    error(e) {
      add(e.retry ? 'retry' : 'error', { message: e.message.slice(0, 300), status: e.status, waitMs: e.waitMs, failures: e.failures, step: e.step, ms: e.ms }, e);
    },
    compact(before, after) {
      if (before === after) return;
      const at = new Date();
      enqueue(id, 'compact', async () => {
        const from = JSON.stringify(before).length;
        const to = JSON.stringify(after).length;
        if (from === to && before.length === after.length) return;
        await insertEvent(db, id, at, 'compact', { chars: [from, to], messages: [before.length, after.length] }, undefined);
      });
    },
    note(kind, detail = {}) {
      const text = typeof detail.text === 'string' ? detail.text.slice(0, 200) : undefined;
      t.event('note', { kind, ...(text ? { text } : {}) }, { kind, ...detail });
    },
    commit(c) {
      add('commit', { version: c.version, tree: c.tree, name: c.name ?? undefined }, c);
    },
    handOver(detail = {}) {
      t.note('tick', detail);
      enqueue(id, 'totals', () => db.query(`with ${TOTALS} update orb_traces t set ${TOTAL_SETS} from s where t.id = $1`, [id]));
      return flush();
    },
    end(status, error, meta = {}) {
      const at = new Date();
      const tree = typeof meta.tree === 'string' ? meta.tree : null;
      enqueue(id, 'end', async () => {
        const files = tree ? await putTreeBlobs(db, tree) : null;
        await insertEvent(db, id, at, 'end', { status, error: error ? error.slice(0, 300) : undefined }, { status, error: error ?? undefined, ...meta, ...(files ? { files } : {}) });
        await db.query(
          `with ${TOTALS}
           update orb_traces t set ${TOTAL_SETS},
             status = case when t.status = 'running' then $2 else t.status end,
             error = case when t.status = 'running' then $3 else t.error end,
             ended_at = case when t.status = 'running' then $4::timestamptz else t.ended_at end,
             duration_ms = case when t.status = 'running' then greatest(0, round(extract(epoch from ($4::timestamptz - t.started_at)) * 1000))::bigint else t.duration_ms end,
             meta = t.meta || $5::jsonb || jsonb_strip_nulls(jsonb_build_object('versions', nullif(s.versions, 0), 'looks', nullif(s.looks, 0)))
           from s where t.id = $1`,
          [id, status, error ?? null, at, JSON.stringify(meta)],
        );
      });
      return flush();
    },
  };
  return t;
}

/** Begin a trace: its row and what the build was given (all queued; nothing here waits on the database). */
export function startTrace(db: Db, head: TraceHead, input?: TraceInput): Trace {
  const { id } = head;
  const startedAt = new Date();
  enqueue(id, 'start', () =>
    db.query(
      `insert into orb_traces (id, group_id, kind, world_id, owner_device, owner_user, provider, model, mode, prompt, meta, started_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::timestamptz) on conflict (id) do nothing`,
      [id, head.group ?? null, head.kind, head.worldId ?? null, head.owner?.deviceHash ?? null, head.owner?.userId ?? null, head.provider, head.model ?? null, head.mode ?? 'build', (head.prompt ?? '').slice(0, PROMPT_MAX), JSON.stringify(head.meta ?? {}), startedAt],
    ),
  );
  if (input) {
    const blobs: TraceBlob[] = [];
    const system = input.system ? toBlob(Buffer.from(input.system), 'text/plain') : null;
    if (system) blobs.push(system);
    const messages = input.messages ? (stash(input.messages, blobs) as unknown[]) : undefined;
    enqueue(id, 'input', async () => {
      const files = input.tree ? await putTreeBlobs(db, input.tree) : null;
      await putBlobs(db, blobs);
      const images = blobs.filter((b) => b.type?.startsWith('image/')).length;
      const summary = { messages: messages?.length, system: input.system?.length, files: files ? Object.keys(files).length : undefined, images: images || undefined };
      await insertEvent(db, id, startedAt, 'input', summary, { system: system ? ref(system.sha) : undefined, messages, tree: input.tree ?? undefined, files: files ?? undefined });
    });
  }
  return openTrace(db, id);
}

/** One stretch of a Cursor run's event stream (./agent/cursor.ts), recorded as a step when it ends. */
export function cursorSegment(t: Trace, runIndex: number, runId: string): { add(event: string, data: Record<string, unknown>): void; end(): void } {
  const startedAt = Date.now();
  let text = '';
  let thinking = '';
  let events = 0;
  const tools = new Map<string, Record<string, unknown>>();
  const other: Array<{ event: string; data: Record<string, unknown> }> = [];
  return {
    add(event, data) {
      events++;
      if (event === 'assistant' && typeof data.text === 'string') text += data.text;
      else if (event === 'thinking' && typeof data.text === 'string') thinking += data.text;
      else if (event === 'tool_call') {
        const k = String(data.callId ?? `#${tools.size}`);
        tools.set(k, { ...tools.get(k), ...data });
      } else if (event !== 'done') other.push({ event, data });
    },
    end() {
      if (!events) return;
      const ms = Date.now() - startedAt;
      const result = other.find((o) => o.event === 'result')?.data;
      t.event(
        'step',
        { run: runIndex, ms, tools: [...tools.values()].map((x) => String(x.name ?? '?')), text: text.length, thinking: thinking.length, status: result?.status },
        { run: runIndex, runId, ms, text, thinking, tools: [...tools.values()], events: other },
      );
    },
  };
}

// -- reading (the lab pages) --------------------------------------------------------------------

export interface TraceRow {
  id: string;
  groupId: string | null;
  kind: TraceKind;
  worldId: string | null;
  worldName: string | null;
  /** The person's name (their account, else their device's). */
  who: string | null;
  user: string | null;
  /** A short tag of the device (enough to tell devices apart). */
  device: string | null;
  provider: string;
  model: string | null;
  mode: string;
  prompt: string;
  status: TraceStatus;
  error: string | null;
  steps: number;
  tokens: Tokens;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  meta: Record<string, unknown>;
}

export interface TraceEvent {
  seq: number;
  at: string;
  type: string;
  summary: Record<string, unknown>;
  payload: unknown;
  /** Bytes of the payload's JSON. */
  size: number;
}

const ROWS = `select t.*, w.name as world_name, coalesce(nullif(btrim(u.name), ''), nullif(btrim(d.name), '')) as who
  from orb_traces t left join orb_worlds w on w.id = t.world_id left join orb_users u on u.id = t.owner_user left join orb_devices d on d.hash = t.owner_device`;

const iso = (v: unknown) => new Date(v as string).toISOString();

function toRow(r: Record<string, unknown>): TraceRow {
  const n = (k: string) => Number(r[k]) || 0;
  return {
    id: String(r.id),
    groupId: (r.group_id as string | null) ?? null,
    kind: r.kind as TraceKind,
    worldId: (r.world_id as string | null) ?? null,
    worldName: (r.world_name as string | null) ?? null,
    who: (r.who as string | null) ?? null,
    user: (r.owner_user as string | null) ?? null,
    device: typeof r.owner_device === 'string' ? r.owner_device.slice(0, 10) : null,
    provider: String(r.provider),
    model: (r.model as string | null) ?? null,
    mode: String(r.mode),
    prompt: String(r.prompt ?? ''),
    status: r.status as TraceStatus,
    error: (r.error as string | null) ?? null,
    steps: n('steps'),
    tokens: { in: n('input_tokens'), out: n('output_tokens'), cacheRead: n('cache_read_tokens'), cacheWrite: n('cache_write_tokens'), reasoning: n('reasoning_tokens') },
    startedAt: iso(r.started_at),
    endedAt: r.ended_at ? iso(r.ended_at) : null,
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    meta: json<Record<string, unknown>>(r.meta, {}),
  };
}

export interface TraceFilter {
  status?: string;
  kind?: string;
  provider?: string;
  /** Words in the prompt. */
  q?: string;
  /** Started then or later. */
  since?: Date;
}

function where(f: TraceFilter, params: unknown[]): string {
  const parts: string[] = [];
  const add = (sql: string, v: unknown, cast = '') => {
    params.push(v);
    parts.push(`${sql} $${params.length}${cast}`);
  };
  if (f.status && TRACE_STATUSES.includes(f.status)) add('t.status =', f.status);
  if (f.kind && TRACE_KINDS.includes(f.kind)) add('t.kind =', f.kind);
  if (f.provider && /^[\w-]{1,40}$/.test(f.provider)) add('t.provider =', f.provider);
  if (f.q?.trim()) add('t.prompt ilike', `%${f.q.trim().slice(0, 200).replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  if (f.since && !Number.isNaN(f.since.getTime())) add('t.started_at >=', f.since, '::timestamptz');
  return parts.length ? `where ${parts.join(' and ')}` : '';
}

/** Traces, newest first, a page at a time. */
export async function listTraces(db: Db, f: TraceFilter = {}, page = 0, limit = 50): Promise<{ traces: TraceRow[]; more: boolean }> {
  const params: unknown[] = [];
  const w = where(f, params);
  params.push(limit + 1, Math.max(0, page) * limit);
  const rows = await db.query(`${ROWS} ${w} order by t.started_at desc, t.id limit $${params.length - 1} offset $${params.length}`, params);
  return { traces: rows.slice(0, limit).map(toRow), more: rows.length > limit };
}

/** How many traces match, their tokens, and the space all traces take. */
export async function traceTotals(db: Db, f: TraceFilter = {}): Promise<{ traces: number; tokens: Tokens; bytes: number }> {
  const params: unknown[] = [];
  const rows = await db.query<Record<string, unknown>>(
    `select count(*)::int as n, coalesce(sum(input_tokens), 0)::float8 as i, coalesce(sum(output_tokens), 0)::float8 as o, coalesce(sum(cache_read_tokens), 0)::float8 as cr,
       coalesce(sum(cache_write_tokens), 0)::float8 as cw, coalesce(sum(reasoning_tokens), 0)::float8 as r,
       (pg_total_relation_size('orb_traces') + pg_total_relation_size('orb_trace_events') + pg_total_relation_size('orb_trace_blobs'))::float8 as b
     from orb_traces t ${where(f, params)}`,
    params,
  );
  const r = rows[0] ?? {};
  return { traces: Number(r.n) || 0, tokens: { in: Number(r.i) || 0, out: Number(r.o) || 0, cacheRead: Number(r.cr) || 0, cacheWrite: Number(r.cw) || 0, reasoning: Number(r.r) || 0 }, bytes: Number(r.b) || 0 };
}

/** The providers traces were made with (for the lab's filters). */
export async function traceProviders(db: Db): Promise<string[]> {
  return (await db.query<{ provider: string }>(`select distinct provider from orb_traces order by provider limit 30`)).map((r) => r.provider);
}

export async function getTrace(db: Db, id: string): Promise<TraceRow | null> {
  const rows = await db.query(`${ROWS} where t.id = $1`, [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

/** A trace's events in order, payloads decoded. */
export async function traceEvents(db: Db, id: string): Promise<TraceEvent[]> {
  const rows = await db.query<{ seq: number; at: unknown; type: string; summary: unknown; payload: Uint8Array | null; size: number }>(`select seq, at, type, summary, payload, size from orb_trace_events where trace_id = $1 order by seq`, [id]);
  return Promise.all(
    rows.map(async (r) => {
      let payload: unknown = null;
      if (r.payload != null) {
        try {
          payload = JSON.parse((await unzip(r.payload)).toString('utf8'));
        } catch (e) {
          payload = { unreadable: e instanceof Error ? e.message : String(e) };
        }
      }
      return { seq: Number(r.seq), at: iso(r.at), type: r.type, summary: json<Record<string, unknown>>(r.summary, {}), payload, size: Number(r.size) || 0 };
    }),
  );
}

/** The rounds of one chat turn (oldest first). */
export async function traceRounds(db: Db, group: string): Promise<Array<{ id: string; kind: TraceKind; status: TraceStatus; startedAt: string }>> {
  const rows = await db.query<{ id: string; kind: TraceKind; status: TraceStatus; started_at: unknown }>(`select id, kind, status, started_at from orb_traces where group_id = $1 order by started_at, id limit 50`, [group]);
  return rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, startedAt: iso(r.started_at) }));
}

export async function traceBlob(db: Db, sha: string): Promise<{ data: Uint8Array; type: string | null } | null> {
  const rows = await db.query<{ data: Uint8Array; media_type: string | null }>(`select data, media_type from orb_trace_blobs where sha = $1`, [sha]);
  return rows[0] ? { data: rows[0].data, type: rows[0].media_type } : null;
}

/** `v` with its blob references inlined: text always, images (as data URLs) when asked. */
async function inlineBlobs(db: Db, v: unknown, images: boolean): Promise<unknown> {
  const shas = new Set<string>();
  mapStrings(v, (s) => {
    const sha = blobSha(s);
    if (sha) shas.add(sha);
    return s;
  });
  if (!shas.size) return v;
  const rows = await db.query<{ sha: string; media_type: string | null; data: Uint8Array }>(
    `select sha, media_type, data from orb_trace_blobs where sha = any($1::text[]) and (media_type like 'text/%' or ($2::boolean and media_type like 'image/%'))`,
    [[...shas], images],
  );
  const inline = new Map<string, string>();
  for (const r of rows) {
    const bytes = Buffer.from(r.data);
    inline.set(ref(r.sha), r.media_type?.startsWith('text/') ? bytes.toString('utf8') : `data:${r.media_type};base64,${bytes.toString('base64')}`);
  }
  return mapStrings(v, (s) => inline.get(s) ?? s);
}

/**
 * Traces as JSON lines, each with all its events (payloads decoded, text blobs inlined, images
 * as "orb-blob:<sha>" or with `images` as data URLs): one trace, or those matching the filter —
 * the first `limit` since `since`, else the newest `limit` — oldest first.
 */
export async function* exportTraces(db: Db, o: TraceFilter & { id?: string; limit?: number; images?: boolean } = {}): AsyncGenerator<string> {
  const limit = Math.min(2000, Math.max(1, o.limit ?? 200));
  const params: unknown[] = [];
  const w = o.id ? (params.push(o.id), 'where t.id = $1') : where(o, params);
  params.push(limit);
  const rows = o.since
    ? await db.query(`${ROWS} ${w} order by t.started_at, t.id limit $${params.length}`, params)
    : (await db.query(`${ROWS} ${w} order by t.started_at desc, t.id desc limit $${params.length}`, params)).reverse();
  for (const r of rows) {
    const t = toRow(r);
    const events = await inlineBlobs(db, await traceEvents(db, t.id), o.images === true);
    yield `${JSON.stringify({ ...t, events })}\n`;
  }
}

/** Forget traces older than ORB_TRACE_DAYS (kept forever when it isn't set), a bounded batch per call. */
export async function pruneTraces(db: Db, days = Number(process.env.ORB_TRACE_DAYS)): Promise<number> {
  if (!(days > 0)) return 0;
  days = Math.max(1, days);
  // A trace still running counts as ending 14 days after it started (the longest an agent job runs).
  const old = await db.query<{ id: string }>(`select id from orb_traces where coalesce(ended_at, started_at + interval '14 days') < now() - ($1::float8 * interval '1 day') order by started_at limit 200`, [days]);
  const ids = old.map((r) => r.id);
  if (ids.length) {
    await db.query(`delete from orb_trace_events where trace_id = any($1::text[])`, [ids]);
    await db.query(`delete from orb_traces where id = any($1::text[])`, [ids]);
  }
  await db.query(`delete from orb_trace_blobs where sha in (select sha from orb_trace_blobs where used_at < now() - ($1::float8 * interval '1 day') limit 500)`, [days]);
  return ids.length;
}
