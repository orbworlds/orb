// Durable server-side agent jobs: a build that runs on Orb's server for as long as it takes
// (minutes or days), independent of any browser.
//
// A job is a conversation with a model that has file tools (./workspace.ts). It runs in ticks:
// one tick is one serverless invocation (~4.5 minutes) that holds a lease on the job, runs steps
// (one model call + its tool calls each), saves the conversation and the file tree after every
// step, and then hands over to the next tick by calling /api/agent/tick again. If a tick dies, the
// lease runs out and whoever looks next (a watching page, or the cron) starts a new one.
//
// The job's output is written like a build job's (orb_build_chunks, see ../buildjobs.ts): Orb
// protocol text (<orb:say>, <orb:title>, <orb:suggest>, <orb:error>) plus control frames for
// file steps, live trees and saved versions. Pages follow it with GET /api/agent/jobs/:id?from=N
// and can pick it up again from any offset, after a reload, on any device.

import { streamText, type ModelMessage, type TextStreamPart, type ToolSet } from 'ai';
import type { Db } from '../db';
import { control, newJobId, sweepJobs } from '../buildjobs';
import { getTree, mergeTrees, putTree, type Tree } from '../files';
import { commitTree, worldTree } from '../worlds';
import { pushRepo } from '../reposync';
import { rateLimit } from '../ratelimit';
import { ANON_PAUSE, BUDGET_PAUSE, cutCallUsd, promptTokens, usageUsd } from '../budget';
import { chargeBuild, type Billing } from '../buildlimits';
import { logBuild, outOfCredits, plansConfig, refundCredits, toCredits } from '../credits';
import { paymentsForPayer } from '../billing';
import { freeTierConfig, longBuildChecks } from '../freetier';
import { mockAi, modelLabel, serverCursorKey } from '../ai';
import { recordError } from '../errors';
import type { Viewer } from '../auth';
import { DEFAULT_CURSOR_MODEL } from '../cursor';
import { openTrace, startTrace, type Trace } from '../traces';
import { agentModel, DEFAULT_AGENT_MODELS, PROVIDER_NAMES, reasoningFor, type AgentProvider } from './models';
import { agentSystemPrompt } from './prompt';
import { checkTickToken, openKey, sealKey, tickToken } from './secrets';
import { filesUrl } from './sync';
import { agentTools, closeToolCalls, isFinalStep, Workspace, type LookInput, type Meta, type StepEvent } from './workspace';
import { cursorTick } from './cursor';
import { attachLookImages, closeOpenLooks, dropLooks, formatLook, isWatched, LOOK_OVERHEAD_MS, LOOK_SIZE, lookCount, MAX_LOOKS, openLook, pruneLookImages, resolveLookImages, trimLooks, waitForLook, type LookImage } from './look';
import { cleanProbeActions, PROBE_LIMITS, probeDuration } from '../../lib/probe';
import type { ProbeResult } from '../../lib/types';

export { checkTickToken };

/** A tick holds the job this long (a dead tick's job is picked up again after it runs out). */
const LEASE_S = 330;
/** Start new steps only this early in a tick… (shorter in tests, to exercise the hand-over) */
const STEP_START_MS = Number(process.env.ORB_AGENT_STEP_START_MS) || 200_000;
/** …and stop whatever runs at this point (the function's limit is 300 s). */
const HARD_MS = Number(process.env.ORB_AGENT_HARD_MS) || 268_000;
/** Save a version of the world at least this often while a long job works. */
const CHECKPOINT_MS = 10 * 60_000;
const FLUSH_MS = 350;
/** Output per step, thinking included: the default, and Anthropic or OpenAI keys. */
const MAX_OUTPUT_TOKENS = 16_000;
const BYO_MAX_OUTPUT_TOKENS = 64_000;
/** Consecutive provider failures (overloaded, network…) before a job gives up. */
const MAX_FAILURES = 8;
/** Conversation size (characters of JSON) above which old tool output is trimmed. */
const COMPACT_AT = 320_000;
const HARD_COMPACT_AT = 700_000;
/** Steps of one build, on any model: a guard against an agent that never stops (builds on Orb's AI end sooner when the credits do). */
export const MAX_STEPS = 5000;

/** Who pays for a free-builder job, as its maker's plan stood when it started (orb_agent_jobs.ext). */
function billingOf(ext: Record<string, unknown> | null | undefined): Billing | null {
  const b = ext?.billing as Partial<Billing> | undefined;
  return b && typeof b.payer === 'string' ? { payer: b.payer, plan: b.plan === 'pro' ? 'pro' : b.plan === 'guest' ? 'guest' : 'free', paid: !!b.paid } : null;
}
/** Jobs one person may run at once. */
export const MAX_RUNNING = 3;

interface JobRow {
  id: string;
  world_id: string;
  owner_device: string | null;
  owner_user: string | null;
  mode: 'build' | 'ask';
  status: string;
  provider: AgentProvider;
  model: string | null;
  key_enc: string | null;
  origin: string | null;
  messages: ModelMessage[] | string;
  base_tree: string | null;
  tree: string | null;
  committed_tree: string | null;
  prompt: string | null;
  title: string | null;
  steps: number;
  max_steps: number;
  failures: number;
  committed_at: Date | string | null;
  created_at: Date | string;
  ext: Record<string, unknown> | string | null;
}

/** What a provider-specific tick driver (./cursor.ts) gets from the runner. */
export interface TickCtx {
  db: Db;
  job: JobRow;
  out: Output;
  meta: Meta;
  startedAt: number;
  hardMs: number;
  signal: AbortSignal;
  /** What the job was asked, saw and did, kept for the lab (../traces.ts). */
  trace: Trace;
  apiKey: string | null;
  /** The free builder on Orb's own key (its failures are Orb's to fix, not the person's). */
  shared?: boolean;
  /** The free builder: add what the build cost (US$) to the day's budget → why it must pause now, or null. */
  charge?: (usd: number) => Promise<string | null>;
  /** The job's files link, for the agent to get and save the world (./sync.ts). */
  filesUrl?: string;
  ext: Record<string, unknown>;
  worldName: string;
  cursorParams?: Array<{ id: string; value: string }>;
  /** The request as one text (+ screenshot). */
  prompt(): { text: string; images: Array<{ data: string; mimeType: string }> };
  getTree(): string | null;
  /** The files changed: remember and show them. */
  setTree(tree: string): Promise<void>;
  commit(): Promise<void>;
  save(extra?: Record<string, unknown>): Promise<void>;
  /** `refund: false`: a build that saved nothing still costs its maker (it ran out of time or credits). */
  finish(status: 'done' | 'failed' | 'cancelled', error?: string, opts?: { refund?: boolean }): Promise<TickResult>;
}

// -- creating jobs ------------------------------------------------------------------------------

export interface NewJob {
  owner: Viewer;
  worldId: string;
  mode: 'build' | 'ask';
  provider: AgentProvider;
  model: string | null;
  apiKey: string | null;
  origin: string;
  messages: ModelMessage[];
  prompt: string;
  /** Model options and the like. */
  ext?: Record<string, unknown>;
  /** For its trace (../traces.ts): the chat turn it belongs to, and more about the request. */
  trace?: { group: string | null; meta?: Record<string, unknown> };
}

/** The model a job really talks to. */
function modelOf(provider: AgentProvider, model: string | null, onCursor: boolean): string {
  if (onCursor || provider === 'cursor') return model || DEFAULT_CURSOR_MODEL;
  if (mockAi() || provider === 'mock') return 'mock';
  if (provider === 'free') return model || modelLabel();
  return model || DEFAULT_AGENT_MODELS[provider];
}

/** Whether a job runs as a Cursor agent: on the person's key, or the free builder on Orb's. */
const runsOnCursor = (provider: AgentProvider, ext: Record<string, unknown> | null | undefined) => provider === 'cursor' || ext?.backend === 'cursor';

export async function createAgentJob(db: Db, j: NewJob): Promise<string> {
  const world = await worldTree(db, j.worldId);
  if (!world) throw new Error('world not found');
  const id = newJobId();
  await db.query(`insert into orb_build_jobs (id) values ($1)`, [id]);
  if (Math.random() < 0.02) void sweepJobs(db).catch(() => undefined); // housekeeping, without relying on the cron
  await db.query(
    `insert into orb_agent_jobs (id, world_id, owner_device, owner_user, mode, provider, model, key_enc, origin, messages, base_tree, tree, committed_tree, prompt, max_steps, ext)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $11, $11, $12, $13, $14::jsonb)`,
    [
      id,
      j.worldId,
      j.owner.deviceHash,
      j.owner.userId,
      j.mode,
      j.provider,
      j.model,
      j.apiKey ? sealKey(j.apiKey) : null,
      j.origin,
      JSON.stringify(j.messages),
      world.tree,
      j.prompt.slice(0, 2000),
      MAX_STEPS,
      JSON.stringify(j.ext ?? {}),
    ],
  );
  const onCursor = runsOnCursor(j.provider, j.ext);
  // Traces never hold a whole device hash: of who pays, only the plan.
  const { billing, ...shown } = j.ext ?? {};
  startTrace(
    db,
    { id, group: j.trace?.group, kind: onCursor ? 'cursor' : 'agent', worldId: j.worldId, owner: j.owner, provider: j.provider, model: modelOf(j.provider, j.model, onCursor), mode: j.mode, prompt: j.prompt, meta: { ...shown, ...j.trace?.meta, plan: billingOf({ billing })?.plan, effort: reasoningFor(j.provider, j.ext ?? {}) } },
    { system: onCursor ? null : agentSystemPrompt(j.mode), messages: j.messages, tree: world.tree },
  );
  return id;
}

export async function runningJobs(db: Db, owner: Viewer): Promise<number> {
  const rows = await db.query<{ n: number }>(
    `select count(*)::int as n from orb_agent_jobs where status = 'running' and ((owner_device is not null and owner_device = $1::text) or (owner_user is not null and owner_user = $2::text))`,
    [owner.deviceHash, owner.userId],
  );
  return Number(rows[0]?.n) || 0;
}

/** What a watching page needs to know about a job. */
export interface JobInfo {
  status: string;
  /** Running, but no tick holds it (it died, or is between ticks): kick it. */
  idle: boolean;
  origin: string | null;
}

export async function jobInfo(db: Db, id: string): Promise<JobInfo | null> {
  const rows = await db.query<JobInfo>(
    `select status, origin, (status = 'running' and (lease_until is null or lease_until < now())) as idle from orb_agent_jobs where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Ask the next tick to run (a fresh invocation of /api/agent/tick). */
export async function kick(origin: string | null, id: string, db?: Db): Promise<boolean> {
  if (!origin) return false;
  let failure = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${origin}/api/agent/tick`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orb-tick': tickToken(id) },
        body: JSON.stringify({ id }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return true;
      console.error('[orb] agent kick failed', res.status, (await res.text().catch(() => '')).slice(0, 200));
      failure = `${res.status} ${res.headers.get('x-vercel-error') ?? ''}`.trim();
      // The platform stops a function calling itself too many times in a row: the next request
      // from outside (a watching page, or the minute cron) picks the job up again.
      if (res.status === 508) break;
    } catch (e) {
      console.error('[orb] agent kick failed', e instanceof Error ? e.message : e);
      failure = e instanceof Error ? e.message : String(e);
    }
    await sleep(1000 * (attempt + 1));
  }
  // Leave a trace in the job's output (pages ignore 'note' frames) — the next look picks it up.
  if (db) {
    await db
      .query(`insert into orb_build_chunks (job_id, seq, text) select $1, coalesce(max(seq) + 1, 0), $2 from orb_build_chunks where job_id = $1`, [id, control({ t: 'note', text: `hand-over failed: ${failure}`.slice(0, 300) })])
      .catch(() => undefined);
  }
  return false;
}

/** Running jobs that no tick holds (for the cron). */
export async function idleJobs(db: Db, limit = 25): Promise<Array<{ id: string; origin: string | null }>> {
  // Jobs that ran for two weeks are stopped: whatever they made is saved.
  await db.query(`update orb_build_jobs set cancelled = true where id in (select id from orb_agent_jobs where status = 'running' and created_at < now() - interval '14 days')`);
  return db.query<{ id: string; origin: string | null }>(
    `select id, origin from orb_agent_jobs where status = 'running' and (lease_until is null or lease_until < now()) and updated_at < now() - interval '20 seconds' order by updated_at limit $1`,
    [limit],
  );
}

// -- output -------------------------------------------------------------------------------------

/** Appends a job's output to its chunk rows (in order, retried), and notices Cancel. */
export class Output {
  private buf = '';
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  cancelled = false;
  private inSay = false;

  constructor(
    private readonly db: Db,
    private readonly id: string,
    private seq: number,
    private readonly onCancel: () => void,
  ) {
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
  }

  /** Narration text (shown in the chat). */
  say(text: string): void {
    if (!text) return;
    if (!this.inSay) {
      this.buf += '<orb:say>';
      this.inSay = true;
    }
    // The model's words must never read as protocol tags.
    this.buf += text.replace(/<(\/?orb:)/gi, '‹$1');
  }

  endSay(): void {
    if (this.inSay) this.buf += '</orb:say>\n';
    this.inSay = false;
  }

  raw(text: string): void {
    this.endSay();
    this.buf += text;
  }

  control(frame: Record<string, unknown>): void {
    this.buf += control(frame);
  }

  flush(): Promise<void> {
    this.chain = this.chain.then(async () => {
      const text = this.buf;
      this.buf = '';
      for (let attempt = 0; ; attempt++) {
        try {
          if (text) {
            await this.db.query(`insert into orb_build_chunks (job_id, seq, text) values ($1, $2, $3) on conflict do nothing`, [this.id, this.seq, text]);
            this.seq++;
          }
          const rows = await this.db.query<{ cancelled: boolean }>(`update orb_build_jobs set updated_at = now() where id = $1 returning cancelled`, [this.id]);
          if (rows[0]?.cancelled && !this.cancelled) {
            this.cancelled = true;
            this.onCancel();
          }
          return;
        } catch (e) {
          console.error('[orb] agent output write failed', e);
          if (attempt >= 3) {
            this.buf = text + this.buf; // keep it for the next flush, in order
            return;
          }
          await sleep(300 * (attempt + 1));
        }
      }
    });
    return this.chain;
  }

  async close(done: boolean): Promise<void> {
    clearInterval(this.timer);
    this.endSay();
    await this.flush();
    if (done) await this.db.query(`update orb_build_jobs set done = true, updated_at = now() where id = $1`, [this.id]);
  }
}

// -- running ------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseMessages(v: ModelMessage[] | string): ModelMessage[] {
  return typeof v === 'string' ? (JSON.parse(v) as ModelMessage[]) : v;
}

function ownerOf(job: JobRow): Viewer {
  return { deviceHash: job.owner_device, userId: job.owner_user, deviceId: null };
}

function errorText(e: unknown): string {
  const err = e as { message?: unknown; responseBody?: unknown; lastError?: { message?: unknown; responseBody?: unknown } } | null;
  const inner = err?.lastError ?? err;
  let msg = typeof inner?.message === 'string' ? inner.message : String(e);
  if (typeof inner?.responseBody === 'string') {
    try {
      const b = JSON.parse(inner.responseBody) as { error?: { message?: string } | string };
      const m = typeof b.error === 'string' ? b.error : b.error?.message;
      if (m) msg = m;
    } catch {
      /* not JSON */
    }
  }
  return msg.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function statusOf(e: unknown): number | undefined {
  const err = e as { statusCode?: number; status?: number; lastError?: { statusCode?: number }; cause?: { statusCode?: number } } | null;
  return err?.lastError?.statusCode ?? err?.statusCode ?? err?.status ?? err?.cause?.statusCode;
}

/** A failure worth waiting out (the job keeps going) vs. one that ends the job. */
function classify(e: unknown, provider: AgentProvider): { retry: boolean; message: string; down?: boolean } {
  const status = statusOf(e);
  const name = PROVIDER_NAMES[provider];
  const own = provider !== 'free';
  if (own && (status === 401 || status === 403)) return { retry: false, message: `Your ${name} key didn't work — check it in You → Model.` };
  if (own && status === 402) return { retry: false, message: `Your ${name} account is out of credits.` };
  // The free tier's provider refuses to serve (account not set up, out of credit…): waiting won't help.
  if (!own && (status === 401 || status === 402 || status === 403 || /credit card|customer_verification|verification required|insufficient (funds|credit)/i.test(errorText(e)))) {
    return { retry: false, down: true, message: "The free builder is resting right now. You can keep building by adding your own AI key in You → Model." };
  }
  if (status === 404 || status === 400) return { retry: false, message: own ? `${name}: ${errorText(e)}` : `The AI couldn't continue (${errorText(e)}).` };
  return { retry: true, message: errorText(e) };
}

const escapeTag = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Prompt-cache breakpoints (Anthropic): the system prompt and the newest message. */
function withCache(messages: ModelMessage[]): ModelMessage[] {
  if (!messages.length) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  out[out.length - 1] = { ...last, providerOptions: { ...(last.providerOptions ?? {}), anthropic: { cacheControl: { type: 'ephemeral' } } } } as ModelMessage;
  return out;
}

/**
 * Keep a long conversation within bounds: old tool output and old file contents in earlier
 * calls are elided (the files themselves are the source of truth); if that isn't enough, the
 * oldest steps are dropped.
 */
export function compact(messages: ModelMessage[]): ModelMessage[] {
  const size = () => JSON.stringify(messages).length;
  if (size() < COMPACT_AT) return messages;
  const keep = 8; // the newest messages stay untouched
  const out = messages.map((m, i) => {
    if (i === 0 || i >= messages.length - keep || typeof m.content === 'string') return m;
    if (m.role === 'tool') {
      return {
        ...m,
        content: m.content.map((p) => {
          if (p.type !== 'tool-result') return p;
          const o = p.output as { type: string; value?: unknown };
          if ((o.type === 'text' || o.type === 'error-text') && typeof o.value === 'string' && o.value.length > 600) {
            return { ...p, output: { type: o.type, value: `${o.value.slice(0, 300)}\n… [older output trimmed — read the file again if you need it]` } };
          }
          return p;
        }),
      } as ModelMessage;
    }
    if (m.role === 'assistant') {
      return {
        ...m,
        content: m.content.map((p) => {
          if (p.type !== 'tool-call' || !p.input || typeof p.input !== 'object') return p;
          const input = { ...(p.input as Record<string, unknown>) };
          for (const k of ['content', 'old_string', 'new_string']) {
            const v = input[k];
            if (typeof v === 'string' && v.length > 400) input[k] = `${v.slice(0, 200)}… [trimmed]`;
          }
          return { ...p, input };
        }),
      } as ModelMessage;
    }
    return m;
  });
  messages = out;
  if (size() < HARD_COMPACT_AT) return messages;
  // Drop the oldest steps: keep the first request, a note, and the newest steps from an
  // assistant turn on (so every tool result still follows its call).
  let start = Math.max(1, messages.length - 40);
  while (start < messages.length && messages[start].role !== 'assistant') start++;
  const note: ModelMessage = {
    role: 'user',
    content: '(Earlier steps of this job were trimmed to save space. The files are up to date — check .orb/plan.md and the files to see where things stand, then continue.)',
  };
  const tail = messages.slice(start);
  return [messages[0], ...(messages[0].role === 'user' ? [{ role: 'assistant', content: 'Working on it.' } as ModelMessage] : []), note, ...tail];
}

/** The most recent complete-ish sentence of a thought, for the "thinking" peek. */
function latestSentence(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  const parts = t.split(/(?<=[.!?])\s+/).filter((x) => x.length > 12);
  return (parts[parts.length - 1] ?? t).slice(-200);
}

const FILE_TOOLS: Record<string, 'write' | 'edit'> = { write_file: 'write', edit_file: 'edit', delete_file: 'edit', move_file: 'edit' };
const READ_TOOLS: Record<string, string> = { list_files: 'Looking around', read_file: 'Reading', search: 'Searching', read_docs: 'Reading the docs at' };

/** Pull a string field out of a partial JSON object (tool input still streaming). */
function partialField(json: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json);
  if (!m) return null;
  return m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

export type TickResult = 'continue' | 'done' | 'busy';

/** Run one tick of a job (see the top of this file). */
export async function runTick(db: Db, id: string): Promise<TickResult> {
  const startedAt = Date.now();
  const leased = await db.query<JobRow>(
    `update orb_agent_jobs set lease_until = now() + ($2::int * interval '1 second'), ticks = ticks + 1, updated_at = now()
     where id = $1 and status = 'running' and (lease_until is null or lease_until < now())
     returning *`,
    [id, LEASE_S],
  );
  const job = leased[0];
  if (!job) return 'busy';
  const trace = openTrace(db, id);

  const seqRows = await db.query<{ next: number }>(`select coalesce(max(seq) + 1, 0)::int as next from orb_build_chunks where job_id = $1`, [id]);
  const stop = new AbortController();
  const out = new Output(db, id, Number(seqRows[0]?.next) || 0, () => stop.abort('cancelled'));
  let messages = parseMessages(job.messages);
  const files = (job.tree && (await getTree(db, job.tree))) || {};
  const ws = new Workspace(db, files);
  let tree = job.tree;
  let committedTree = job.committed_tree;
  let committedAt = job.committed_at ? new Date(job.committed_at).getTime() : new Date(job.created_at).getTime();
  let steps = Number(job.steps) || 0;
  let failures = Number(job.failures) || 0;
  const meta: Meta = job.title ? { name: job.title } : {};
  let tokensIn = 0;
  let tokensOut = 0;

  const save = async (extra: Record<string, unknown> = {}) => {
    const sets = [`messages = $2::jsonb`, `tree = $3`, `steps = $4`, `failures = $5`, `tokens_in = tokens_in + $6`, `tokens_out = tokens_out + $7`, `title = $8`, `updated_at = now()`];
    const params: unknown[] = [id, JSON.stringify(messages), tree, steps, failures, tokensIn, tokensOut, meta.name ?? null];
    for (const [k, v] of Object.entries(extra)) {
      params.push(v);
      sets.push(`${k} = $${params.length}`);
    }
    tokensIn = tokensOut = 0;
    await db.query(`update orb_agent_jobs set ${sets.join(', ')} where id = $1`, params);
  };

  /** Save the files as a new version of the world (merged with changes made meanwhile). */
  const commit = async (): Promise<void> => {
    if (job.mode !== 'build' || !tree || tree === committedTree) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = await worldTree(db, job.world_id);
      if (!now) return;
      let target = tree;
      if (now.tree !== committedTree && committedTree) {
        // The world changed while we worked (a hand edit, another build): keep both.
        const base: Tree = (await getTree(db, committedTree)) ?? {};
        target = await putTree(db, mergeTrees(base, ws.files, now.files));
      }
      const res = await commitTree(db, ownerOf(job), job.world_id, target, { prompt: job.prompt, name: meta.name ?? null, category: meta.category ?? null, expect: { tree: now.stored } });
      if (res) {
        committedTree = target;
        committedAt = Date.now();
        out.control({ t: 'version', worldId: job.world_id, version: res.version, tree: target, name: res.name });
        trace.commit({ version: res.version, tree: target, name: res.name });
        await save({ committed_tree: target, committed_at: new Date(committedAt) });
        await pushRepo(db, job.world_id);
        return;
      }
      if ((await worldTree(db, job.world_id))?.tree === target) return; // nothing to save
    }
  };

  const ext: Record<string, unknown> = (typeof job.ext === 'string' ? JSON.parse(job.ext) : job.ext) ?? {};
  /** Whose credits pay for this build on Orb's AI (null: the person's own key). */
  const billing = job.provider === 'free' ? billingOf(ext) : null;
  /** The maker's credits ran out during this build (it pauses, and isn't refunded). */
  let creditsOut = false;

  /** What the build cost its maker: given back if it failed without saving anything; told to the page. */
  const settleCredits = async (status: 'done' | 'failed' | 'cancelled', refundable: boolean) => {
    const rows = await db.query<{ charged_micros: string | number; charged_topup_micros: string | number }>(`select charged_micros, charged_topup_micros from orb_agent_jobs where id = $1`, [id]);
    let micros = Number(rows[0]?.charged_micros) || 0;
    const nothing = status === 'failed' && job.mode === 'build' && committedTree === job.base_tree;
    if (nothing && refundable && micros > 0 && (await refundCredits(db, billing!.payer, micros, id, Number(rows[0]?.charged_topup_micros) || 0))) micros = 0;
    await logBuild(db, billing!.payer, micros, id);
    out.control({ t: 'credits', used: Math.round(toCredits(micros) * 100) / 100 });
  };

  const finish = async (status: 'done' | 'failed' | 'cancelled', error?: string, opts: { refund?: boolean } = {}): Promise<TickResult> => {
    try {
      await commit();
    } catch (e) {
      console.error('[orb] agent commit failed', e);
      error ??= "Couldn't save the world — try again in a moment.";
      status = 'failed';
    }
    if (meta.question) {
      out.say(meta.question);
      out.endSay();
    }
    if (meta.suggestions?.length) out.raw(`<orb:suggest>${meta.suggestions.join('|')}</orb:suggest>\n`);
    if (meta.remix) out.raw('<orb:remix/>\n');
    if (error) out.raw(`\n<orb:error>${escapeTag(error)}</orb:error>\n`);
    if (billing) await settleCredits(status, opts.refund !== false && !creditsOut).catch((e) => console.error("[orb] settling a build's credits failed", e));
    // A look still open (a Cursor agent's, cut short) is over too: a page replaying the output skips it.
    for (const lookId of await closeOpenLooks(db, id).catch(() => [])) out.control({ t: 'looked', id: lookId });
    await out.close(true);
    await save({ status, error: error ?? null, key_enc: null, lease_until: null });
    await dropLooks(db, id).catch((e) => console.error('[orb] agent looks cleanup failed', e));
    await trace.end(status, error ?? null, { tree, name: meta.name ?? null, suggestions: meta.suggestions, costUsd: meta.costUsd });
    return 'done';
  };

  /**
   * A build on Orb's AI: what it cost (US$) comes off its maker's credits and onto the day's spend
   * (../budget.ts) → why it must pause now (credits or the free budget used up), or null.
   */
  const charge = async (usd: number): Promise<string | null> => {
    if (!(usd > 0)) return null;
    try {
      const sum = await db.query<{ charged_micros: string | number }>(`update orb_agent_jobs set charged_micros = charged_micros + $2::bigint where id = $1 returning charged_micros`, [id, Math.round(usd * 1e6)]);
      // What the build has used so far, for the page to show while it runs.
      if (billing) out.control({ t: 'credits', used: Math.round(toCredits(Number(sum[0]?.charged_micros) || 0) * 100) / 100 });
      const { wallet, over } = await chargeBuild(db, billing, usd, !job.owner_user);
      if (wallet && wallet.fromTopup > 0) await db.query(`update orb_agent_jobs set charged_topup_micros = charged_topup_micros + $2::bigint where id = $1`, [id, wallet.fromTopup]);
      if (wallet && wallet.left <= 0) {
        creditsOut = true;
        return outOfCredits(wallet, plansConfig(), await paymentsForPayer(db, billing!.payer), true);
      }
      return over === 'all' ? BUDGET_PAUSE : over === 'anon' ? ANON_PAUSE : null;
    } catch (e) {
      console.error('[orb] charging the free builder failed', e);
      return null;
    }
  };

  if (runsOnCursor(job.provider, ext)) {
    const last = messages[messages.length - 1];
    const shared = job.provider !== 'cursor';
    const ctx: TickCtx = {
      db,
      job,
      out,
      meta,
      startedAt,
      hardMs: HARD_MS,
      signal: stop.signal,
      trace,
      apiKey: shared ? serverCursorKey() : openKey(job.key_enc),
      shared,
      charge: shared ? charge : undefined,
      filesUrl: job.origin ? filesUrl(job.origin, id) : undefined,
      ext,
      worldName: (await worldTree(db, job.world_id))?.name ?? 'Untitled world',
      cursorParams: Array.isArray(ext.params) ? (ext.params as Array<{ id: string; value: string }>) : undefined,
      prompt: () => {
        const parts = typeof last?.content === 'string' ? [{ type: 'text', text: last.content }] : ((last?.content ?? []) as Array<{ type: string; text?: string; data?: unknown; mediaType?: string }>);
        return {
          text: parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n\n'),
          images: parts.filter((p) => p.type === 'file' && typeof p.data === 'string' && p.mediaType).map((p) => ({ data: p.data as string, mimeType: p.mediaType! })),
        };
      },
      getTree: () => tree,
      setTree: async (next) => {
        tree = next;
        ws.files = (await getTree(db, next)) ?? {};
        out.control({ t: 'tree', tree: next });
        await save();
      },
      commit,
      save,
      finish,
    };
    try {
      const r = await cursorTick(ctx);
      if (r === 'continue') {
        await out.close(false);
        await trace.handOver();
        await save({ lease_until: null });
      }
      return r;
    } catch (e) {
      console.error('[orb] cursor tick crashed', e);
      trace.error({ message: errorText(e), retry: true });
      await out.close(false);
      await trace.handOver();
      await save({ lease_until: null });
      return 'continue';
    }
  }

  let model;
  try {
    model = await agentModel(job.provider, openKey(job.key_enc), job.model);
  } catch {
    return finish('failed', 'Your key is missing — add it in You → Model and try again.');
  }
  const system = agentSystemPrompt(job.mode);
  const instructions = { role: 'system' as const, content: system, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' as const } } } };
  const reasoning = reasoningFor(job.provider, ext);
  const own = job.provider !== 'free' && job.provider !== 'mock';
  const roomy = job.provider === 'anthropic' || job.provider === 'openai';

  // -- looking at the world (./look.ts) --
  /** Screenshots of this step's looks, by tool call (put with their results after the step). */
  const lookImages = new Map<string, LookImage[]>();
  /** Looks whose screenshots are in the conversation (filled in before each model call). */
  const lookResults = new Map<string, ProbeResult | null>();
  let looks: number | null = null;
  /** The tree the watching pages were last told about. */
  let shownTree = tree;
  const lookAt = async (input: LookInput, callId: string, signal?: AbortSignal): Promise<string> => {
    const { actions, skipped } = cleanProbeActions(input.actions);
    const left = HARD_MS - (Date.now() - startedAt) - 10_000;
    if (left < 15_000) return "There's no time left to look in this part of the build. Look again in your next step.";
    looks ??= await lookCount(db, id);
    const maxLooks = MAX_LOOKS;
    if (looks >= maxLooks) return `You have looked ${looks} times in this build, which is the limit. Check your work by reading the code instead.`;
    if (!(await isWatched(db, id))) return "Nobody has the world open right now, so you can't see it run. Check your work carefully by reading the code instead, and look again later.";
    await ws.settled();
    const shown = await ws.snapshot();
    if (shown !== shownTree) {
      shownTree = shown;
      out.control({ t: 'tree', tree: shown });
    }
    const lookId = await openLook(db, id);
    looks++;
    out.control({ t: 'status', phase: 'thinking', text: input.viewport === 'phone' ? 'Trying it on a phone…' : 'Trying it out…' });
    out.control({ t: 'look', job: id, id: lookId, tree: shown, actions, size: LOOK_SIZE, shots: PROBE_LIMITS.shots, ...(input.viewport === 'phone' ? { viewport: 'phone' } : {}) });
    await out.flush();
    const asked = Date.now();
    const answer = await waitForLook(db, id, lookId, { timeoutMs: Math.min(left, probeDuration(actions) + LOOK_OVERHEAD_MS), signal });
    trace.look({ lookId, callId, actions, skipped, answer, ms: Date.now() - asked });
    out.control({ t: 'looked', id: lookId });
    if ('timeout' in answer) return signal?.aborted ? 'The look was interrupted.' : "The person's browser didn't answer in time (it may be busy, or the world is very slow to start). Continue carefully, and look again later.";
    if ('unavailable' in answer) return `Couldn't look: ${answer.unavailable} Continue carefully, and look again later.`;
    lookResults.set(lookId, answer.result);
    await trimLooks(db, id).catch((e) => console.error('[orb] agent looks trim failed', e));
    const seen = formatLook(lookId, answer.result, skipped);
    if (seen.images.length) lookImages.set(callId, seen.images);
    const remaining = maxLooks - looks;
    return remaining > 3 ? seen.text : `${seen.text}\n(${remaining ? `${remaining} look${remaining === 1 ? '' : 's'} left in this build: keep one for a last check and one on a phone.` : 'That was your last look in this build.'})`;
  };

  /** How long the last step of this tick took (a step that won't fit before HARD_MS waits for the next tick). */
  let lastStepMs = 0;
  /** A free build that has spent the day's budget, or its maker's credits, pauses before its next step. */
  let budgetStop: string | null = null;
  /** A word to the model from Orb, between its steps. */
  const nudge = (text: string) => {
    messages = [...messages, { role: 'user', content: text }];
    trace.note('nudge', { text });
  };

  try {
    for (;;) {
      if (out.cancelled) return await finish('cancelled');
      if (steps >= job.max_steps) {
        out.say(job.provider === 'free' ? "I've taken lots of steps on this one, so I'll pause here — say “keep going” and I'll continue!" : "That's a lot of steps — I'll pause here. Say “keep going” to continue!");
        trace.note('pause', { text: `Paused at the step limit (${job.max_steps}).` });
        return await finish('done');
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed > (job.provider === 'mock' && job.prompt?.includes('mockchain') ? 300 : STEP_START_MS)) break;
      if (lastStepMs && elapsed + lastStepMs > HARD_MS - 10_000) break;
      if (job.provider === 'free' && !billing?.paid && steps > 0 && steps % 10 === 0) {
        for (const c of longBuildChecks({ deviceHash: job.owner_device, userId: job.owner_user }, freeTierConfig(process.env, mockAi()))) {
          if ((await rateLimit(db, c.key, c.limit, c.windowSec)).ok) continue;
          out.say(`I'll pause here. ${c.message}`);
          trace.note('pause', { text: `Paused at a free builder limit (${c.key.split(':').slice(0, 2).join(':')}).` });
          return await finish('done');
        }
      }
      if (budgetStop) {
        out.say(budgetStop);
        trace.note('pause', { text: budgetStop === BUDGET_PAUSE || budgetStop === ANON_PAUSE ? "Paused: the free builder's budget for today is used up." : "Paused: the maker's credits are used up." });
        return await finish('done');
      }

      const full = messages;
      messages = pruneLookImages(compact(messages));
      trace.compact(full, messages);
      const prompt = await resolveLookImages(db, id, messages, lookResults);
      const stepStart = Date.now();
      const ctrl = new AbortController();
      const onStop = () => ctrl.abort('cancelled');
      stop.signal.addEventListener('abort', onStop);
      const deadline = setTimeout(() => ctrl.abort('deadline'), Math.max(5000, HARD_MS - (stepStart - startedAt)));
      const pending = new Map<string, { name: string; json: string; lastProgress: number; label: string | null }>();
      const results = new Map<string, string>();
      const stepEvent = (e: StepEvent) => {
        out.control({ t: 'step', id: e.id, kind: e.kind, label: e.label, status: e.ok ? 'done' : 'failed', ...(e.error ? { error: e.error } : {}) });
      };
      const tools: ToolSet = agentTools(ws, job.mode, meta, stepEvent, job.mode === 'build' ? { look: lookAt } : {});
      const calls: string[] = [];
      let thought = '';
      let lastThought = 0;
      /** Characters the model wrote in this step (words, thinking, tool input): what a step cut short is charged for. */
      let written = 0;
      try {
        const result = streamText({
          model,
          instructions,
          messages: withCache(prompt),
          tools,
          maxOutputTokens: roomy ? BYO_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS,
          ...(reasoning ? { reasoning } : {}),
          maxRetries: 2,
          abortSignal: ctrl.signal,
        });
        for await (const part of result.stream as AsyncIterable<TextStreamPart<ToolSet>>) {
          switch (part.type) {
            case 'text-delta':
              written += part.text.length;
              out.say(part.text);
              break;
            case 'reasoning-delta':
              written += part.text.length;
              thought += part.text;
              if (Date.now() - lastThought > 1500) {
                lastThought = Date.now();
                out.control({ t: 'status', phase: 'thinking', text: latestSentence(thought) });
              }
              break;
            case 'tool-input-start': {
              out.endSay();
              pending.set(part.id, { name: part.toolName, json: '', lastProgress: 0, label: null });
              const kind = FILE_TOOLS[part.toolName];
              if (kind) out.control({ t: 'step', id: part.id, kind, label: kind === 'write' ? 'Writing…' : 'Editing…', status: 'pending' });
              break;
            }
            case 'tool-input-delta': {
              written += part.delta.length;
              const p = pending.get(part.id);
              if (!p) break;
              p.json += part.delta;
              if (!FILE_TOOLS[p.name]) break;
              if (!p.label) {
                const l = partialField(p.json, 'label');
                if (l && p.json.indexOf('"', p.json.indexOf('"label"') + 9 + l.length) !== -1) {
                  p.label = l.slice(0, 60);
                  out.control({ t: 'step', id: part.id, kind: FILE_TOOLS[p.name], label: p.label, status: 'pending' });
                }
              }
              if (Date.now() - p.lastProgress > 600) {
                p.lastProgress = Date.now();
                const body = partialField(p.json, p.name === 'write_file' ? 'content' : 'new_string') ?? '';
                out.control({ t: 'progress', id: part.id, chars: body.length, tail: body.slice(-200) });
              }
              break;
            }
            case 'tool-call': {
              calls.push(part.toolName);
              const reading = READ_TOOLS[part.toolName];
              if (reading) {
                const input = part.input as { path?: string; pattern?: string; url?: string };
                const what = input?.path || input?.pattern || (input?.url ? String(input.url).replace(/^https:\/\//, '') : '');
                out.control({ t: 'status', phase: 'thinking', text: what ? `${reading} ${String(what).slice(0, 80)}…` : `${reading}…` });
              }
              break;
            }
            case 'tool-result':
              results.set(part.toolCallId, (typeof part.output === 'string' ? part.output : JSON.stringify(part.output ?? '')).slice(0, 4000));
              if (part.toolName === 'name_world' && meta.name) out.raw(`<orb:title>${escapeTag(meta.name)}</orb:title>\n`);
              break;
            case 'tool-error':
              results.set(part.toolCallId, `Error: ${errorText(part.error)}`.slice(0, 4000));
              if (FILE_TOOLS[part.toolName]) out.control({ t: 'step', id: part.toolCallId, kind: FILE_TOOLS[part.toolName], label: pending.get(part.toolCallId)?.label ?? 'A change', status: 'failed', error: 'Something went wrong' });
              break;
            case 'error':
              throw part.error;
            case 'abort':
              throw new Error(String(ctrl.signal.reason ?? 'aborted'));
          }
        }
        const response = await result.response;
        const finishReason = await result.finishReason;
        const usage = await result.usage;
        tokensIn += usage.inputTokens ?? 0;
        tokensOut += usage.outputTokens ?? 0;
        if (job.provider === 'free') budgetStop = await charge(usageUsd(response.modelId || job.model, usage));
        const added = attachLookImages(closeToolCalls(response.messages as ModelMessage[], results), lookImages, job.provider === 'openrouter' ? 'user' : 'tool');
        messages = [...messages, ...added];
        steps++;
        trace.step({ step: steps, messages: added, usage, finishReason, ms: Date.now() - stepStart, modelId: response.modelId });
        failures = 0;
        lastStepMs = Date.now() - stepStart;
        out.endSay();
        if (ws.changed) {
          ws.changed = false;
          const next = await ws.snapshot();
          if (next !== tree) {
            tree = next;
            if (tree !== shownTree) out.control({ t: 'tree', tree });
            shownTree = tree;
          }
        }
        if (finishReason === 'length') {
          // Ran out of output mid-reply (likely a huge file): ask for smaller pieces and go on.
          nudge('(Your reply hit the output limit before it finished. Work in smaller pieces: several smaller files, or a few edit_file calls instead of one huge write.)');
          await save();
          continue;
        }
        await save();
        if (finishReason !== 'tool-calls' || isFinalStep(calls)) return await finish('done');
        if (Date.now() - committedAt > CHECKPOINT_MS) await commit();
      } catch (e) {
        out.endSay();
        const reason = ctrl.signal.reason;
        const stopped = reason === 'cancelled' || out.cancelled;
        // A step cut short used what it read and wrote: on Stop, at the time limit, or when it
        // failed after the model started writing (a call refused before that isn't billed).
        if (job.provider === 'free' && (stopped || reason === 'deadline' || written > 0)) {
          const usd = cutCallUsd(modelOf(job.provider, job.model, false), { input: promptTokens(system, prompt), cached: promptTokens(system, steps > 0 ? prompt.slice(0, -2) : []), written });
          trace.note('cut', { text: 'A step was cut short: charged an estimate of what it used.', usd, written, ms: Date.now() - stepStart });
          budgetStop = (await charge(usd)) ?? budgetStop;
        }
        if (stopped) return await finish('cancelled');
        if (reason === 'deadline') {
          // Out of time mid-step: the step is redone by the next tick (its file changes too).
          trace.note('deadline', { text: 'Out of time mid-step: the next tick does it again.', ms: Date.now() - stepStart, calls });
          ws.files = (tree && (await getTree(db, tree))) || {};
          ws.changed = false;
          if (stepStart - startedAt < 5000) {
            // It had the whole tick and still didn't finish: ask for smaller pieces.
            nudge('(Your previous reply was cut off by a time limit before it finished. Work in smaller pieces: several smaller files, or a few edit_file calls instead of one huge write.)');
          }
          break;
        }
        const c = classify(e, job.provider);
        console.error(`[orb] agent step failed (${job.provider})`, c.message);
        trace.error({ message: errorText(e), retry: c.retry, status: statusOf(e), failures: failures + 1, step: steps + 1, ms: Date.now() - stepStart });
        if (c.down) await recordError(db, { kind: 'builder', message: `Agent builds refused: ${errorText(e)}` }).catch(() => {});
        if (!c.retry) return await finish('failed', c.message);
        failures++;
        if (failures >= MAX_FAILURES) return await finish('failed', `The AI kept failing (${c.message}). What was built so far is saved — try again in a bit.`);
        out.control({ t: 'status', phase: 'thinking', text: 'The AI is busy — trying again in a moment…' });
        ws.files = (tree && (await getTree(db, tree))) || {};
        ws.changed = false;
        const wait = Math.min(60_000, 3000 * 2 ** (failures - 1));
        if (Date.now() - startedAt + wait > STEP_START_MS) break;
        await sleep(wait);
      } finally {
        clearTimeout(deadline);
        stop.signal.removeEventListener('abort', onStop);
        lookImages.clear();
      }
    }
  } catch (e) {
    console.error('[orb] agent tick failed', e);
    trace.error({ message: errorText(e), retry: true });
    // Leave the job for the next tick (the lease is released below).
  }

  // Out of time for this tick: save, let go of the job, and hand over to the next tick.
  await out.close(false);
  await trace.handOver({ steps });
  await save({ lease_until: null });
  return 'continue';
}
