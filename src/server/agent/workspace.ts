// The files an agent job works on, and the tools it uses to read and change them.
//
// A Workspace is a mutable view of a file tree: reads come from the content-addressed store
// (src/server/files.ts), writes store new blobs right away and update the in-memory manifest.
// The runner snapshots the manifest into a tree after every step.

import { jsonSchema, tool, type JSONSchema7, type ModelMessage, type ToolResultPart, type ToolSet } from 'ai';
import type { Db } from '../db';
import { blobSizes, cleanPath, FILE_LIMITS, getBlob, isText, putBlob, putTree, type Tree } from '../files';
import { problemsAfterChange } from './check';
import { LOOK_ACTIONS } from './look';
import { DOC_HOSTS, excerpt, fetchText, type Doc } from './web';

const MAX_READ_LINES = 2000;
const DEFAULT_READ_LINES = 800;
const MAX_LINE = 2000;
const MAX_LIST = 400;
const MAX_MATCHES = 120;

export interface StepEvent {
  /** The tool call. */
  id: string;
  /** A file-changing tool finished (shown as a step in the chat). */
  kind: 'write' | 'edit';
  label: string;
  path: string;
  ok: boolean;
  error?: string;
}

export interface Meta {
  name?: string;
  /** What kind of world it is (Explore's category), said with its name. */
  category?: 'game' | 'world' | 'toy';
  suggestions?: string[];
  /** The question a big world's first look ends with (suggest_next's), said last. */
  question?: string;
  remix?: boolean;
  /** What the whole build cost Orb (US$, estimated for Cursor agents), for its trace. */
  costUsd?: number;
}

export class Workspace {
  files: Tree;
  private readonly sizes = new Map<string, number>();
  private readonly text = new Map<string, string>();
  /** File changes run one at a time, in the order the reply asked for them: the tools of one reply start side by side, and two edits of a file must not both start from its old text. */
  private queue: Promise<unknown> = Promise.resolve();
  changed = false;

  /** A file change (queued behind the ones before it). */
  track<T>(run: () => Promise<T>): Promise<T> {
    const p = this.queue.then(run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Wait for the file changes started so far (e.g. before looking at the world). */
  async settled(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    let q: Promise<unknown> | undefined;
    while (q !== this.queue) await (q = this.queue);
  }

  private readonly db: Db;

  constructor(db: Db, files: Tree) {
    this.db = db;
    this.files = { ...files };
  }

  paths(): string[] {
    return Object.keys(this.files).sort();
  }

  async snapshot(): Promise<string> {
    return putTree(this.db, this.files);
  }

  async size(path: string): Promise<number> {
    const sha = this.files[path];
    if (!sha) return 0;
    if (!this.sizes.has(sha)) {
      const missing = Object.values(this.files).filter((s) => !this.sizes.has(s));
      for (const [k, v] of await blobSizes(this.db, missing)) this.sizes.set(k, v);
    }
    return this.sizes.get(sha) ?? 0;
  }

  /** Text of a file; null if it doesn't exist; throws for binary files. */
  async read(path: string): Promise<string | null> {
    const sha = this.files[path];
    if (!sha) return null;
    const cached = this.text.get(sha);
    if (cached !== undefined) return cached;
    const bytes = await getBlob(this.db, sha);
    if (!bytes) throw new Error(`The contents of ${path} are missing.`);
    if (!isText(bytes)) throw new Error(`${path} is a binary file (${bytes.length.toLocaleString('en')} bytes) — it can't be read as text.`);
    const t = new TextDecoder().decode(bytes);
    this.text.set(sha, t);
    return t;
  }

  async write(path: string, content: string): Promise<void> {
    const { sha, size } = await putBlob(this.db, content);
    this.sizes.set(sha, size);
    this.text.set(sha, content);
    if (this.files[path] !== sha) this.changed = true;
    this.files[path] = sha;
  }

  remove(path: string): boolean {
    if (!this.files[path]) return false;
    delete this.files[path];
    this.changed = true;
    return true;
  }
}

/** Exact match first; then the same lines with trailing whitespace and line endings ignored. */
export function replaceIn(content: string, oldStr: string, newStr: string, all: boolean): { ok: true; content: string; count: number } | { ok: false; error: string } {
  if (!oldStr) return { ok: false, error: 'old_string is empty. To add to a file, include an existing anchor line in old_string and repeat it in new_string.' };
  if (oldStr === newStr) return { ok: false, error: 'old_string and new_string are the same — nothing would change.' };
  let count = content.split(oldStr).length - 1;
  if (count > 0) {
    if (count > 1 && !all) return { ok: false, error: `old_string appears ${count} times. Include more surrounding lines to make it unique, or set replace_all.` };
    return { ok: true, content: all ? content.split(oldStr).join(newStr) : content.replace(oldStr, () => newStr), count: all ? count : 1 };
  }
  // Forgiving match: per-line trailing whitespace and CRLF differences.
  const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
  const lines = content.split('\n');
  const want = norm(oldStr).split('\n');
  const hits: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) {
      if (norm(lines[i + k]) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  count = hits.length;
  if (count === 1 || (count > 1 && all)) {
    for (const i of hits.reverse()) lines.splice(i, want.length, ...newStr.split('\n'));
    return { ok: true, content: lines.join('\n'), count };
  }
  if (count > 1) return { ok: false, error: `old_string appears ${count} times. Include more surrounding lines to make it unique, or set replace_all.` };
  // Help the model find the right spot: the line that best matches the first line it gave.
  const first = want.find((l) => l.trim().length > 3)?.trim() ?? '';
  let hint = '';
  if (first) {
    const at = lines.findIndex((l) => l.includes(first));
    if (at !== -1) hint = ` The line "${clipLine(first, 80)}" is at line ${at + 1} — read the file around there and copy old_string exactly.`;
  }
  return { ok: false, error: `old_string was not found in the file.${hint || ' Read the file again and copy old_string exactly as it is now.'}` };
}

function clipLine(s: string, n = MAX_LINE): string {
  return s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s;
}

function numbered(text: string, offset: number, limit: number): string {
  const lines = text.split('\n');
  const start = Math.max(1, offset);
  const end = Math.min(lines.length, start + limit - 1);
  const width = String(end).length;
  const out: string[] = [];
  for (let i = start; i <= end; i++) out.push(`${String(i).padStart(width, ' ')}\t${clipLine(lines[i - 1])}`);
  const head = lines.length > limit || start > 1 ? `(lines ${start}–${end} of ${lines.length})\n` : '';
  const tail = end < lines.length ? `\n… ${lines.length - end} more lines (read with offset ${end + 1})` : '';
  return head + out.join('\n') + tail;
}

function globToRe(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${re}$`);
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export interface LookInput {
  actions?: unknown;
  viewport?: unknown;
}

const LOOK_DESCRIPTION = `Run the world in the person's browser — with your latest files — and see what they see: screenshots, errors, console output, frame rate, and the text and buttons on screen. Optionally play it first; actions run in order:
${LOOK_ACTIONS}
Each look starts the world fresh and takes a few seconds. If nobody has the world open, it says so.`;

const ACTION_SCHEMA: JSONSchema7 = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['key', 'click', 'drag', 'move', 'scroll', 'type', 'wait', 'screenshot', 'eval'] },
    key: { type: 'string' },
    ms: { type: 'number' },
    times: { type: 'integer' },
    x: { type: 'number' },
    y: { type: 'number' },
    to_x: { type: 'number' },
    to_y: { type: 'number' },
    dx: { type: 'number' },
    dy: { type: 'number' },
    button: { type: 'string', enum: ['left', 'right'] },
    double: { type: 'boolean' },
    touch: { type: 'boolean' },
    text: { type: 'string' },
    label: { type: 'string' },
    js: { type: 'string' },
    zoom: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } },
  },
  required: ['type'],
};

const docCache = new Map<string, { at: number; doc: Doc }>();

/** Library code and docs change rarely (and pinned versions never): keep recent ones a while. */
async function readDoc(url: string): Promise<Doc | { error: string }> {
  const key = url.trim();
  const hit = docCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.doc;
  const doc = await fetchText(key);
  if (!('error' in doc) && doc.text.length < 1_000_000) {
    docCache.set(key, { at: Date.now(), doc });
    if (docCache.size > 20) docCache.delete(docCache.keys().next().value!);
  }
  return doc;
}

/**
 * The agent's tools. `onStep` reports file changes (shown in the chat as they happen); `meta`
 * collects the world name, next ideas and remix offers; `look` runs the world in a page that
 * watches the job and sees it (./look.ts), giving the text for the model.
 */
export function agentTools(ws: Workspace, mode: 'build' | 'ask', meta: Meta, onStep: (e: StepEvent) => void, look?: (input: LookInput, toolCallId: string, signal?: AbortSignal) => Promise<string>): ToolSet {
  const pathError = (p: unknown) => `"${String(p)}" is not a valid file path. Use relative paths like "src/main.js" (letters, digits, - _ . / only).`;

  const read = {
    read_docs: tool({
      description: `Read library source code or documentation from the web, e.g. the exact API of a three.js addon in the pinned version (https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/controls/PointerLockControls.js), a package's file list (https://data.jsdelivr.com/v1/packages/npm/three@0.186.1?structure=flat) or an MDN page. Only https on ${DOC_HOSTS.join(', ')}. Returns numbered lines (offset and limit like read_file), or only the lines matching find (a regular expression). Use it instead of guessing when you're not sure how an API works.`,
      inputSchema: jsonSchema<{ url: string; offset?: number; limit?: number; find?: string }>({
        type: 'object',
        properties: { url: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 }, find: { type: 'string' } },
        required: ['url'],
        additionalProperties: false,
      }),
      execute: async ({ url, offset, limit, find }) => {
        const doc = await readDoc(str(url));
        if ('error' in doc) return doc.error;
        return `${doc.url}${doc.cut ? ' (only its first 3 MB)' : ''}\n${excerpt(doc.text, { offset, limit, find: str(find) || undefined })}`;
      },
    }),
    list_files: tool({
      description: 'List the files of the world (paths and sizes). Optionally only those under a folder or matching a glob like "src/**/*.js".',
      inputSchema: jsonSchema<{ path?: string; glob?: string }>({
        type: 'object',
        properties: { path: { type: 'string', description: 'Folder to list (default: everything)' }, glob: { type: 'string' } },
        additionalProperties: false,
      }),
      execute: async ({ path, glob }) => {
        const dir = path ? cleanPath(path) : '';
        if (path && dir === null) return pathError(path);
        const re = glob ? globToRe(glob) : null;
        const all = ws.paths().filter((p) => (!dir || p === dir || p.startsWith(`${dir}/`)) && (!re || re.test(p)));
        if (!all.length) return ws.paths().length ? 'No files match.' : 'The world has no files yet.';
        const shown = all.slice(0, MAX_LIST);
        const lines = await Promise.all(shown.map(async (p) => `${p}  (${(await ws.size(p)).toLocaleString('en')} bytes)`));
        return lines.join('\n') + (all.length > shown.length ? `\n… and ${all.length - shown.length} more` : '');
      },
    }),
    read_file: tool({
      description: `Read a text file with line numbers. Big files: pass offset (1-based line) and limit (default ${DEFAULT_READ_LINES}, max ${MAX_READ_LINES}).`,
      inputSchema: jsonSchema<{ path: string; offset?: number; limit?: number }>({
        type: 'object',
        properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 } },
        required: ['path'],
        additionalProperties: false,
      }),
      execute: async ({ path, offset, limit }) => {
        const p = cleanPath(path);
        if (!p) return pathError(path);
        const text = await ws.read(p);
        if (text === null) return `${p} does not exist.`;
        if (!text) return `${p} is empty.`;
        return numbered(text, offset ?? 1, Math.min(MAX_READ_LINES, limit ?? DEFAULT_READ_LINES));
      },
    }),
    search: tool({
      description: 'Search the text files for a string (or a regular expression with regex: true). Returns matching lines as path:line: text.',
      inputSchema: jsonSchema<{ pattern: string; regex?: boolean; ignore_case?: boolean; path?: string; glob?: string }>({
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          regex: { type: 'boolean' },
          ignore_case: { type: 'boolean' },
          path: { type: 'string', description: 'Only under this folder' },
          glob: { type: 'string', description: 'Only files matching, e.g. "**/*.js"' },
        },
        required: ['pattern'],
        additionalProperties: false,
      }),
      execute: async ({ pattern, regex, ignore_case, path, glob }) => {
        if (!pattern) return 'Give a pattern to search for.';
        let re: RegExp;
        try {
          re = new RegExp(regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ignore_case ? 'i' : '');
        } catch (e) {
          return `Bad regular expression: ${(e as Error).message}`;
        }
        const dir = path ? cleanPath(path) : '';
        const g = glob ? globToRe(glob) : null;
        const out: string[] = [];
        let more = 0;
        for (const p of ws.paths()) {
          if ((dir && p !== dir && !p.startsWith(`${dir}/`)) || (g && !g.test(p))) continue;
          if ((await ws.size(p)) > 2_000_000) continue;
          let text: string | null;
          try {
            text = await ws.read(p);
          } catch {
            continue; // binary
          }
          if (!text) continue;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (!re.test(lines[i])) continue;
            if (out.length >= MAX_MATCHES) more++;
            else out.push(`${p}:${i + 1}: ${clipLine(lines[i].trim(), 240)}`);
          }
        }
        if (!out.length) return 'No matches.';
        return out.join('\n') + (more ? `\n… and ${more} more matches (narrow the search)` : '');
      },
    }),
    suggest_next: tool({
      description:
        'Call once at the very end: exactly 3 short ideas (each ≤ 5 words) the person could ask for next. After the first look of a big new world, also give question: your one short question about its direction, shown as your last words.',
      inputSchema: jsonSchema<{ ideas: string[]; question?: string }>({
        type: 'object',
        properties: { ideas: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 }, question: { type: 'string' } },
        required: ['ideas'],
        additionalProperties: false,
      }),
      execute: async ({ ideas, question }) => {
        meta.suggestions = (Array.isArray(ideas) ? ideas : []).map((s) => str(s).replace(/[|<>]/g, ' ').trim().slice(0, 60)).filter(Boolean).slice(0, 3);
        const q = str(question).trim().slice(0, 240);
        if (q) meta.question = q;
        return 'Noted.';
      },
    }),
  } satisfies ToolSet;

  if (mode === 'ask') {
    return {
      ...read,
      offer_remix: tool({
        description: 'The person wants to change this world: offer them their own copy (remix) to change.',
        inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false }),
        execute: async () => {
          meta.remix = true;
          return 'Offered.';
        },
      }),
    };
  }

  const label = (l: unknown, fallback: string) => str(l).replace(/[<>"]/g, '').trim().slice(0, 60) || fallback;

  const seeing: ToolSet = look
    ? {
        look: tool({
          description: LOOK_DESCRIPTION,
          inputSchema: jsonSchema<LookInput>({
            type: 'object',
            properties: {
              actions: { type: 'array', items: ACTION_SCHEMA, maxItems: 30 },
              viewport: { type: 'string', enum: ['phone'] },
            },
            additionalProperties: false,
          }),
          execute: (input, { toolCallId, abortSignal }) => look(input ?? {}, toolCallId, abortSignal),
        }),
      }
    : {};

  return {
    ...read,
    ...seeing,
    write_file: tool({
      description: 'Create a file, or replace a whole file. Keep it under ~300 lines; split bigger code into several modules.',
      inputSchema: jsonSchema<{ path: string; content: string; label: string }>({
        type: 'object',
        properties: {
          label: { type: 'string', description: '2–5 friendly words describing the visible result' },
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['label', 'path', 'content'],
        additionalProperties: false,
      }),
      execute: ({ path, content, label: l }, { toolCallId: id }) => ws.track(async () => {
        const p = cleanPath(path);
        const lbl = label(l, 'Building it');
        if (!p) {
          onStep({ id, kind: 'write', label: lbl, path: String(path), ok: false, error: 'Bad file name' });
          return pathError(path);
        }
        if (typeof content !== 'string') return 'content must be a string.';
        if (content.length > FILE_LIMITS.file) return 'That file is too big — split it into several smaller files.';
        const existed = !!ws.files[p];
        if (!existed && ws.paths().length >= FILE_LIMITS.files) return `The world already has the maximum of ${FILE_LIMITS.files} files.`;
        await ws.write(p, content);
        onStep({ id, kind: 'write', label: lbl, path: p, ok: true });
        return `${existed ? 'Replaced' : 'Created'} ${p} (${content.split('\n').length} lines).${await problemsAfterChange(ws, [p])}`;
      }),
    }),
    edit_file: tool({
      description: 'Replace an exact snippet of a file. old_string must match the file exactly (including whitespace) and be unique — add surrounding lines if needed — unless replace_all is set.',
      inputSchema: jsonSchema<{ path: string; old_string: string; new_string: string; replace_all?: boolean; label: string }>({
        type: 'object',
        properties: {
          label: { type: 'string', description: '2–5 friendly words describing the visible result' },
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['label', 'path', 'old_string', 'new_string'],
        additionalProperties: false,
      }),
      execute: ({ path, old_string, new_string, replace_all, label: l }, { toolCallId: id }) => ws.track(async () => {
        const p = cleanPath(path);
        const lbl = label(l, 'Touching it up');
        const failed = (error: string, msg: string) => {
          onStep({ id, kind: 'edit', label: lbl, path: p ?? String(path), ok: false, error });
          return msg;
        };
        if (!p) return failed('Bad file name', pathError(path));
        const text = await ws.read(p);
        if (text === null) return failed('No such file', `${p} does not exist. Use write_file to create it.`);
        const r = replaceIn(text, str(old_string), str(new_string), !!replace_all);
        if (!r.ok) return failed("Couldn't find the spot to change", r.error);
        await ws.write(p, r.content);
        onStep({ id, kind: 'edit', label: lbl, path: p, ok: true });
        return `Edited ${p}${r.count > 1 ? ` (${r.count} places)` : ''}.${await problemsAfterChange(ws, [p])}`;
      }),
    }),
    delete_file: tool({
      description: 'Delete a file.',
      inputSchema: jsonSchema<{ path: string; label?: string }>({
        type: 'object',
        properties: { path: { type: 'string' }, label: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      }),
      execute: ({ path, label: l }, { toolCallId: id }) => ws.track(async () => {
        const p = cleanPath(path);
        if (!p || !ws.remove(p)) return `${String(path)} does not exist.`;
        onStep({ id, kind: 'edit', label: label(l, `Removing ${p}`), path: p, ok: true });
        return `Deleted ${p}.${await problemsAfterChange(ws, [p])}`;
      }),
    }),
    move_file: tool({
      description: 'Rename or move a file.',
      inputSchema: jsonSchema<{ from: string; to: string }>({
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        required: ['from', 'to'],
        additionalProperties: false,
      }),
      execute: ({ from, to }, { toolCallId: id }) => ws.track(async () => {
        const a = cleanPath(from);
        const b = cleanPath(to);
        if (!a || !ws.files[a]) return `${String(from)} does not exist.`;
        if (!b) return pathError(to);
        if (ws.files[b]) return `${b} already exists — delete it first or pick another name.`;
        ws.files[b] = ws.files[a];
        ws.remove(a);
        onStep({ id, kind: 'edit', label: `Moving ${a.split('/').pop()}`, path: b, ok: true });
        return `Moved ${a} to ${b}.${await problemsAfterChange(ws, [a, b])}`;
      }),
    }),
    name_world: tool({
      description:
        "Give the world its name (1–3 words, e.g. \"Cloud Castle\") — for a new or untitled world, or when it clearly became something else — and say what it is: a game (there's a goal: win, collect, survive, solve), a world (a place to wander) or a toy (something to make or play with freely, or a scene to look at).",
      inputSchema: jsonSchema<{ name: string; kind: 'game' | 'world' | 'toy' }>({
        type: 'object',
        properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['game', 'world', 'toy'] } },
        required: ['name', 'kind'],
        additionalProperties: false,
      }),
      execute: async ({ name, kind }) => {
        const n = str(name).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (n) meta.name = n;
        if (kind === 'game' || kind === 'world' || kind === 'toy') meta.category = kind;
        return 'Named.';
      },
    }),
  };
}

/**
 * A reply cut off at the output limit can leave tool calls without results in its messages, and
 * providers refuse every later call on such a conversation. Each gets the result its tool gave
 * (`results`, by call id; the tools did run) or, failing that, word that it never ran.
 */
export function closeToolCalls(added: ModelMessage[], results: Map<string, string>): ModelMessage[] {
  const answered = new Set<string>();
  for (const m of added) if (m.role === 'tool') for (const p of m.content) if (p.type === 'tool-result') answered.add(p.toolCallId);
  const missing: ToolResultPart[] = [];
  for (const m of added) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const p of m.content) {
      if (p.type !== 'tool-call' || answered.has(p.toolCallId)) continue;
      missing.push({ type: 'tool-result', toolCallId: p.toolCallId, toolName: p.toolName, output: { type: 'text', value: results.get(p.toolCallId) ?? 'Not run: your reply was cut off at the output limit.' } });
    }
  }
  return missing.length ? [...added, { role: 'tool', content: missing }] : added;
}

/** A step that only wraps up (next ideas, remix offer, naming) ends the reply: nothing to wait for. */
export function isFinalStep(toolNames: string[]): boolean {
  return toolNames.some((n) => n === 'suggest_next' || n === 'offer_remix') && toolNames.every((n) => n === 'suggest_next' || n === 'offer_remix' || n === 'name_world');
}
