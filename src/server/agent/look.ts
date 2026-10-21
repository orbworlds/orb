// The agent's eyes. Its `look` tool (./workspace.ts) runs the world in a page that watches the
// job — the person's own browser, which shows every step of the build anyway — plays it with the
// model's actions and reports what it saw: screenshots, runtime errors, console output, frame
// rate and the text on screen. Cursor agents look the same way with `sh .orb/look` (./sync.ts).
//
// A look goes to the pages as a control frame in the job's output ({t:'look'}, then {t:'looked'}
// once it's over, so a page replaying the output skips it). The first page that can answers with
// POST /api/agent/jobs/:id/look. Answers and their screenshots stay in orb_agent_looks; the
// conversation refers to a screenshot as `orb-look:<look>:<n>`, and the image data is filled in
// before each model call, so the saved conversation stays small.
//
// A Cursor agent's look comes in through the job's files link (POST …/files/look) as a request
// row; the job's tick (./cursor.ts) sends it to the pages and closes it once it's over, and the
// link answers the agent with what the page saw: the report and the screenshots as files.

import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ModelMessage } from 'ai';
import type { Db } from '../db';
import { cleanProbeResult, PROBE_LIMITS } from '../../lib/probe';
import type { ProbeAction, ProbeResult } from '../../lib/types';

/** Looks at the world per job (each one is a screenshot or a few for the model to read). */
export const MAX_LOOKS = 300;
/** On top of its actions, a look needs this long: the page loads the files, restarts the world (20 s or more for a heavy one on a slow device), the answer comes back. */
export const LOOK_OVERHEAD_MS = 40_000;
/** Longest side of a look's screenshots: enough to judge details (zoomed shots show more). */
const LOOK_SIZE = 1024;

/** What a look can do before its last screenshot, in order (the look tool's and `sh .orb/look`'s). */
export const LOOK_ACTIONS = `- {"type":"key","key":"w","ms":800} holds a key ("Space", "Enter", "ArrowUp", chords like "Shift+w"; "times":3 taps it 3 times)
- {"type":"click","x":0.5,"y":0.6} clicks a spot: x and y are fractions of the screen from the top-left; "touch":true taps like a finger
- {"type":"drag","x":0.3,"y":0.5,"to_x":0.7,"to_y":0.5,"ms":500} drags or swipes (orbit cameras, joysticks, drawing)
- {"type":"move","dx":300,"dy":0,"ms":300} turns the camera in mouse-look games (pointer lock works); {"type":"move","x":0.5,"y":0.5} hovers a spot
- {"type":"scroll","dy":300}, {"type":"type","text":"hello"}, {"type":"wait","ms":1000}
- {"type":"screenshot","label":"after the jump"} takes an extra screenshot (one is always taken at the end); add "zoom":{"x":0.3,"y":0.2,"w":0.4,"h":0.4} to see just that part of the screen up close, in much more detail (small text, particles, edges and seams)
- {"type":"eval","js":"window.debug.player.position"} runs JavaScript in the page and returns its last expression's value — globals only, so expose what you want to check (window.debug = { player, score })
"viewport":"phone" plays the look on a phone-sized screen (390×844, portrait) instead of the person's own window: use taps ("touch":true) there.`;

/** A page counts as watching while it followed the job this recently. */
const WATCH_FRESH_S = 20;
const POLL_MS = 400;
/** After a page said it can't look (hidden tab, another world on screen…), wait this long for another page. */
const DECLINE_GRACE_MS = 2500;
/** Screenshots kept in the conversation (older ones become a short note). */
export const KEEP_IMAGES = 4;

const REF = 'orb-look:';
const REF_RE = /^orb-look:([\w-]{6,40}):(\d{1,2})$/;

export const isLookId = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{6,40}$/.test(s);

export async function markWatched(db: Db, jobId: string): Promise<void> {
  await db.query(`update orb_agent_jobs set watched_at = now() where id = $1`, [jobId]);
}

export async function isWatched(db: Db, jobId: string): Promise<boolean> {
  const rows = await db.query<{ live: boolean }>(`select coalesce(watched_at > now() - ($2::int * interval '1 second'), false) as live from orb_agent_jobs where id = $1`, [jobId, WATCH_FRESH_S]);
  return rows[0]?.live === true;
}

/** A new look: the look tool's (./runner.ts), or what a Cursor agent asked to see (`request`). */
export async function openLook(db: Db, jobId: string, request?: LookRequest): Promise<string> {
  const id = crypto.randomBytes(9).toString('base64url');
  await db.query(`insert into orb_agent_looks (job_id, id, request) values ($1, $2, $3::jsonb)`, [jobId, id, request ? JSON.stringify(request) : null]);
  return id;
}

/** Why the agent can't look now (it used up its looks, or nobody has the world open), or null. */
export async function lookRefusal(db: Db, jobId: string, looks: number): Promise<string | null> {
  if (looks >= MAX_LOOKS) return `You have looked ${looks} times in this build, which is the limit. Check your work by reading the code instead.`;
  if (!(await isWatched(db, jobId))) return "Nobody has the world open right now, so you can't see it run. Check your work carefully by reading the code instead, and look again later.";
  return null;
}

/** The frames that ask the watching pages to look. */
export function lookFrames(jobId: string, lookId: string, l: { tree: string; actions: ProbeAction[]; viewport?: unknown }): Array<Record<string, unknown>> {
  const phone = l.viewport === 'phone';
  return [
    { t: 'status', phase: 'thinking', text: phone ? 'Trying it on a phone…' : 'Trying it out…' },
    { t: 'look', job: jobId, id: lookId, tree: l.tree, actions: l.actions, size: LOOK_SIZE, shots: PROBE_LIMITS.shots, ...(phone ? { viewport: 'phone' } : {}) },
  ];
}

/** Screenshots of this many recent looks stay stored (only the newest few are shown to the model). */
const KEEP_SHOTS_OF = 6;

/** Forget the screenshots of older looks (they can be large). */
export async function trimLooks(db: Db, jobId: string): Promise<void> {
  await db.query(
    `update orb_agent_looks set result = jsonb_set(result, '{shots}', '[]'::jsonb)
     where job_id = $1 and status = 'done' and jsonb_array_length(coalesce(result->'shots', '[]'::jsonb)) > 0
       and id not in (select id from orb_agent_looks where job_id = $1 and status = 'done' order by answered_at desc nulls last limit $2)`,
    [jobId, KEEP_SHOTS_OF],
  );
}

/** A finished job's looks are of no more use. */
export async function dropLooks(db: Db, jobId: string): Promise<void> {
  await db.query(`delete from orb_agent_looks where job_id = $1`, [jobId]);
}

export async function lookCount(db: Db, jobId: string): Promise<number> {
  const rows = await db.query<{ n: number }>(`select count(*)::int as n from orb_agent_looks where job_id = $1`, [jobId]);
  return Number(rows[0]?.n) || 0;
}

/**
 * A page's answer: `{ result }` (what it saw) or `{ unavailable: reason }`. False when the look
 * is over (answered, given up on) or unknown.
 */
export async function answerLook(db: Db, jobId: string, lookId: string, body: { result?: unknown; unavailable?: unknown }): Promise<boolean> {
  if (typeof body.unavailable === 'string') {
    const rows = await db.query(`update orb_agent_looks set declined = $3 where job_id = $1 and id = $2 and status = 'pending' returning id`, [jobId, lookId, body.unavailable.slice(0, 200)]);
    return rows.length > 0;
  }
  const result = cleanProbeResult(body.result);
  const rows = await db.query(`update orb_agent_looks set status = 'done', result = $3::jsonb, answered_at = now() where job_id = $1 and id = $2 and status = 'pending' returning id`, [jobId, lookId, JSON.stringify(result)]);
  return rows.length > 0;
}

export type LookAnswer = { result: ProbeResult } | { unavailable: string } | { timeout: true };

/** A jsonb value (or its JSON text). */
const parsed = <T>(v: unknown): T | null => (v ? ((typeof v === 'string' ? JSON.parse(v) : v) as T) : null);

/** Wait for a page to answer (or for every page that answered to say it can't). */
export async function waitForLook(db: Db, jobId: string, lookId: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<LookAnswer> {
  const end = Date.now() + opts.timeoutMs;
  let declinedAt = 0;
  let answer: LookAnswer = { timeout: true };
  while (!opts.signal?.aborted) {
    const rows = await db.query<{ status: string; result: unknown; declined: string | null }>(`select status, result, declined from orb_agent_looks where job_id = $1 and id = $2`, [jobId, lookId]);
    const r = rows[0];
    if (!r) break;
    const result = r.status === 'done' ? parsed<ProbeResult>(r.result) : null;
    if (result) return { result };
    if (r.declined) {
      declinedAt ||= Date.now();
      if (Date.now() - declinedAt >= DECLINE_GRACE_MS) {
        answer = { unavailable: r.declined };
        break;
      }
    }
    if (Date.now() >= end) break;
    await sleep(POLL_MS, undefined, { signal: opts.signal }).catch(() => undefined);
  }
  // Answers that come in now are too late.
  await db.query(`update orb_agent_looks set status = 'over' where job_id = $1 and id = $2 and status = 'pending'`, [jobId, lookId]).catch(() => undefined);
  return answer;
}

/** Why a look saw nothing (no answer in time, interrupted, or no page could look), for the agent. */
export function missedLook(answer: { timeout: true } | { unavailable: string }, aborted: boolean): string {
  if ('unavailable' in answer) return `Couldn't look: ${answer.unavailable} Continue carefully, and look again later.`;
  return aborted ? 'The look was interrupted.' : "The person's browser didn't answer in time (it may be busy, or the world is very slow to start). Continue carefully, and look again later.";
}

/** A word to the agent when its looks run low. */
export function looksLeft(left: number): string | null {
  if (left > 3) return null;
  return left > 0 ? `(${left} look${left === 1 ? '' : 's'} left in this build: keep one for a last check and one on a phone.)` : '(That was your last look in this build.)';
}

// -- a Cursor agent's looks -----------------------------------------------------------------------

/** What a Cursor agent asked to see: its files (a tree), played with these actions first. */
export interface LookRequest {
  tree: string;
  actions: ProbeAction[];
  /** Actions dropped as unknown or over the limits (the agent is told). */
  skipped: number;
  viewport?: 'phone';
}

/** Looks a Cursor agent asked for that no page was told about yet, oldest first: each is handed out once. */
export async function takeLookRequests(db: Db, jobId: string): Promise<Array<{ id: string; request: LookRequest }>> {
  const rows = await db.query<{ id: string; request: unknown; created_at: Date | string }>(
    `update orb_agent_looks set asked_at = now() where job_id = $1 and status = 'pending' and request is not null and asked_at is null returning id, request, created_at`,
    [jobId],
  );
  return rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()).map((r) => ({ id: r.id, request: parsed<LookRequest>(r.request)! }));
}

/** A look the pages were told about that is over: what it was, what came of it and how long it took. */
export interface ClosedLook {
  id: string;
  request: LookRequest;
  answer: LookAnswer;
  ms: number;
}

/**
 * The asked looks that are over (answered or given up on — or quiet for so long that whoever
 * waited for them is gone), each closed once: their 'looked' frame goes out now.
 */
export async function closeLooks(db: Db, jobId: string): Promise<ClosedLook[]> {
  const rows = await db.query<{ id: string; request: unknown; status: string; result: unknown; declined: string | null; ms: number | string }>(
    `update orb_agent_looks set closed_at = now()
     where job_id = $1 and asked_at is not null and closed_at is null and (status <> 'pending' or asked_at < now() - interval '5 minutes')
     returning id, request, status, result, declined, (extract(epoch from (coalesce(answered_at, now()) - asked_at)) * 1000)::int as ms`,
    [jobId],
  );
  return rows.map((r) => {
    const result = r.status === 'done' ? parsed<ProbeResult>(r.result) : null;
    return { id: r.id, request: parsed<LookRequest>(r.request)!, answer: result ? { result } : r.declined ? { unavailable: r.declined } : { timeout: true }, ms: Number(r.ms) || 0 };
  });
}

/** A finished job's looks that the pages were told about and that are still open, closed now. */
export async function closeOpenLooks(db: Db, jobId: string): Promise<string[]> {
  const rows = await db.query<{ id: string }>(`update orb_agent_looks set closed_at = now() where job_id = $1 and asked_at is not null and closed_at is null returning id`, [jobId]);
  return rows.map((r) => r.id);
}

// -- what the model reads -----------------------------------------------------------------------

export interface LookImage {
  ref: string;
  mediaType: string;
  label: string;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const f2 = (n: number) => n.toFixed(2);

function region(u: { x: number; y: number; w: number; h: number }): string {
  const cx = u.x + u.w / 2;
  const cy = u.y + u.h / 2;
  const row = cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : '';
  const col = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : '';
  return row && col ? `${row} ${col}` : row || col || 'center';
}

/** Where an error happened, in the world's own file names. */
function where(e: { line?: number; source?: string }): string {
  const tree = e.source ? /\/api\/tree\/[a-f0-9]{64}\/([^?#]*)/.exec(e.source) : null;
  const file = tree ? tree[1] : e.source ? e.source : e.line ? 'index.html' : '';
  if (!file) return '';
  return ` — ${file}${e.line ? `:${e.line}` : ''}`;
}

/** The look as text for the model, and the screenshots to show it. */
export function formatLook(lookId: string, r: ProbeResult, skipped: number): { text: string; images: LookImage[] } {
  const lines: string[] = [];
  const screen = r.size.w <= 600 ? 'phone-sized' : r.size.w <= 1100 ? 'tablet-sized' : 'desktop';
  lines.push(`The world in the person's browser: ${r.size.w}×${r.size.h} px (${screen}${r.size.dpr > 1 ? `, ${r.size.dpr}× pixel density` : ''}), running for ${secs(r.uptime)}${r.title ? `, page title "${r.title}"` : ''}.`);
  if (skipped) lines.push(`(${skipped} action${skipped > 1 ? 's were' : ' was'} skipped: unknown, or over the limits of one look.)`);
  const slow = r.fps < 25;
  const rate = r.software
    ? slow
      ? " — this browser draws the world in software (it has no graphics chip to use), so it runs far slower here than on a real phone or laptop: judge the speed by the code (instancing, counts, shadows), not by this number, and don't take things out of the world for it"
      : ' (drawn in software, without a graphics chip)'
    : r.fps && slow
      ? ' — low: something is too heavy (too many objects, lights, shadows or draw calls, or a lot of work every frame)'
      : '';
  lines.push(`Frame rate: ${r.fps} fps${rate}.`);
  if (r.canvas) lines.push(`Main canvas: ${r.canvas.type === 'none' ? 'never drawn into' : r.canvas.type}, ${r.canvas.w}×${r.canvas.h}, covering ${Math.round(r.canvas.cover * 100)}% of the screen.`);
  else lines.push('No canvas on screen.');
  if (r.locked) lines.push('The world asked for pointer lock (mouse-look); the play-test simulated it.');
  if (r.focus && r.focus !== 'page') lines.push(`Keyboard focus: ${r.focus}.`);

  if (r.errors.length) {
    const during = r.errors.filter((e) => e.during).length;
    lines.push(`Errors (${r.errors.length}${during ? `, ${during} while playing` : ''}):`);
    r.errors.forEach((e, i) => lines.push(`${i + 1}. ${e.message}${where(e)} (at ${secs(e.t)}${e.during ? ', while playing' : ''})`));
  } else lines.push('Errors: none.');

  if (r.logs.length) {
    const shown = r.logs.slice(-15);
    lines.push(`Console (last ${shown.length}${r.dropped ? `; ${r.dropped} more were too many to keep` : ''}):`);
    for (const l of shown) lines.push(`[${l.level}] ${l.text}`);
  }

  if (r.ui.length) {
    lines.push('Text on screen (positions are fractions of the screen, from the top-left):');
    for (const u of r.ui.slice(0, 40)) {
      const kind = u.click ? `[${u.tag === 'a' ? 'link' : u.tag === 'input' || u.tag === 'textarea' || u.tag === 'select' ? u.tag : 'button'}] ` : '';
      lines.push(`- ${kind}"${u.text}" ${region(u)} (x ${f2(u.x)}–${f2(u.x + u.w)}, y ${f2(u.y)}–${f2(u.y + u.h)})`);
    }
  } else lines.push('Text on screen: none.');

  for (const e of r.evals) lines.push(`eval ${JSON.stringify(e.js)} → ${e.error ? 'threw ' : ''}${e.result}`);
  for (const n of r.notes) lines.push(`Note: ${n}`);

  const images: LookImage[] = [];
  r.shots.forEach((s, n) => {
    if (s.dataUrl) images.push({ ref: `${REF}${lookId}:${n}`, mediaType: s.dataUrl.slice(5, s.dataUrl.indexOf(';')), label: s.label });
  });
  if (r.shots.length) {
    const list = r.shots.map((s) => `"${s.label}" at ${secs(s.t)}${s.zoom ? ` (zoomed into x ${f2(s.zoom.x)}–${f2(s.zoom.x + s.zoom.w)}, y ${f2(s.zoom.y)}–${f2(s.zoom.y + s.zoom.h)})` : ''}${s.flat ? ' (one flat color — nothing visible!)' : ''}${s.dataUrl ? '' : ' (could not be taken)'}`);
    lines.push(`Screenshots, in order: ${list.join(', ')}. The canvas is captured exactly; HTML on top of it is redrawn approximately (boxes, colors, text).`);
  } else lines.push('No screenshot could be taken.');
  return { text: lines.join('\n'), images };
}

/** Where a Cursor agent finds what its look saw (`sh .orb/look` unpacks the answer there). */
export const SEEN_DIR = '.orb/seen';

/**
 * What a Cursor agent's look saw, as files for its folder: report.txt (the text the look tool
 * gives, `left` looks to go) and the screenshots, named by their order and label.
 */
export function seenFiles(lookId: string, r: ProbeResult, skipped: number, left: number): Array<{ name: string; data: Buffer }> {
  const shots: Array<{ name: string; data: Buffer }> = [];
  r.shots.forEach((s, n) => {
    const url = s.dataUrl;
    if (!url) return;
    const type = url.slice('data:image/'.length, url.indexOf(';'));
    const slug = s.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'screenshot';
    shots.push({ name: `${n + 1}-${slug}.${type === 'jpeg' ? 'jpg' : type}`, data: Buffer.from(url.slice(url.indexOf(',') + 1), 'base64') });
  });
  const lines = [formatLook(lookId, r, skipped).text];
  if (shots.length) lines.push(`Open each screenshot to see it: ${shots.map((s) => `${SEEN_DIR}/${s.name}`).join(', ')}`);
  const low = looksLeft(left);
  if (low) lines.push(low);
  return [{ name: 'report.txt', data: Buffer.from(`${lines.join('\n')}\n`) }, ...shots];
}

// -- screenshots in the conversation ----------------------------------------------------------

type Part = Record<string, unknown>;
const filePart = (img: LookImage): Part => ({ type: 'file', mediaType: img.mediaType, data: { type: 'data', data: img.ref } });

/**
 * After a step: put each look's screenshots with its result — inside the tool result, or (for
 * providers whose API takes no images there) in a user message right after the step.
 */
export function attachLookImages(messages: ModelMessage[], images: Map<string, LookImage[]>, where: 'tool' | 'user'): ModelMessage[] {
  if (!images.size) return messages;
  const later: Part[] = [];
  const out = messages.map((m) => {
    if (m.role !== 'tool' || !Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((p) => {
        if (p.type !== 'tool-result') return p;
        const imgs = images.get(p.toolCallId);
        if (!imgs?.length) return p;
        const o = p.output as { type: string; value?: unknown };
        const text = o.type === 'text' && typeof o.value === 'string' ? o.value : JSON.stringify(o.value ?? '');
        if (where === 'user') {
          for (const img of imgs) later.push({ type: 'text', text: `Screenshot "${img.label}" from look:` }, filePart(img));
          return { ...p, output: { type: 'text', value: `${text}\nThe screenshots follow in the next message.` } };
        }
        const value: Part[] = [{ type: 'text', text }];
        for (const img of imgs) value.push({ type: 'text', text: `Screenshot "${img.label}":` }, filePart(img));
        return { ...p, output: { type: 'content', value } };
      }),
    } as ModelMessage;
  });
  if (later.length) out.push({ role: 'user', content: [{ type: 'text', text: '(Screenshots from your look.)' }, ...later] } as unknown as ModelMessage);
  return out;
}

/** Each screenshot reference in the conversation, newest last (with a way to replace it). */
function* refs(messages: ModelMessage[]): Generator<{ ref: string; replace(part: Part): void }> {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    const parts = m.content as Part[];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.type === 'file') {
        const ref = ((p.data as Part | undefined)?.data ?? p.data) as unknown;
        if (typeof ref === 'string' && ref.startsWith(REF)) yield { ref, replace: (next) => (parts[i] = next) };
      } else if (p.type === 'tool-result') {
        const o = p.output as { type: string; value?: unknown };
        if (o?.type !== 'content' || !Array.isArray(o.value)) continue;
        const value = o.value as Part[];
        for (let k = 0; k < value.length; k++) {
          const v = value[k];
          const ref = v.type === 'file' ? (v.data as Part | undefined)?.data : undefined;
          if (typeof ref === 'string' && ref.startsWith(REF)) yield { ref, replace: (next) => (value[k] = next) };
        }
      }
    }
  }
}

/** A deep enough copy that replacing parts leaves `messages` alone. */
function copy(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    return {
      ...m,
      content: (m.content as Part[]).map((p) => {
        const o = p.type === 'tool-result' ? (p.output as { type: string; value?: unknown }) : null;
        return o?.type === 'content' && Array.isArray(o.value) ? { ...p, output: { ...o, value: o.value.slice() } } : p;
      }),
    } as ModelMessage;
  });
}

/** Keep only the newest `keep` screenshots; older ones become a short note. */
export function pruneLookImages(messages: ModelMessage[], keep = KEEP_IMAGES): ModelMessage[] {
  const all = [...refs(messages)];
  if (all.length <= keep) return messages;
  const next = copy(messages);
  const found = [...refs(next)];
  for (const r of found.slice(0, found.length - keep)) r.replace({ type: 'text', text: '(an older screenshot, no longer shown)' });
  return next;
}

/** The conversation with screenshot references replaced by the image data (for a model call). */
export async function resolveLookImages(db: Db, jobId: string, messages: ModelMessage[], cache: Map<string, ProbeResult | null>): Promise<ModelMessage[]> {
  if (![...refs(messages)].length) return messages;
  const next = copy(messages);
  for (const r of [...refs(next)]) {
    const m = REF_RE.exec(r.ref);
    let result = m ? cache.get(m[1]) : null;
    if (m && result === undefined) {
      const rows = await db.query<{ result: unknown }>(`select result from orb_agent_looks where job_id = $1 and id = $2`, [jobId, m[1]]);
      result = parsed<ProbeResult>(rows[0]?.result);
      cache.set(m[1], result);
    }
    const url = m && result ? result.shots[Number(m[2])]?.dataUrl : null;
    if (!url) {
      r.replace({ type: 'text', text: '(a screenshot that is no longer available)' });
      continue;
    }
    r.replace({ type: 'file', mediaType: url.slice(5, url.indexOf(';')), data: { type: 'data', data: url.slice(url.indexOf(',') + 1) } });
  }
  return next;
}
