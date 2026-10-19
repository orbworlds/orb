// Streaming parser for the Orb protocol (SPEC §8), the text of a build's output, and the edit
// applier. Pure functions, no DOM, no imports — usable on the server, in the browser and in node
// tests. Agent jobs write say, title, suggest, remix and error blocks (their file changes travel
// as control frames); the parser also reads the file blocks of the single-file protocol.
//
// Namespaced tagged blocks:
//   <orb:say>…</orb:say>                         narration (may appear several times)
//   <orb:title>…</orb:title>                     world name
//   <orb:write label="…">…html…</orb:write>      full document
//   <orb:edit label="…"><orb:find>…</orb:find><orb:replace>…</orb:replace></orb:edit>
//   <orb:suggest>a|b|c</orb:suggest>             next ideas
// plus two small extensions used by Orb itself:
//   <orb:remix/>                                 (ask mode) the person wants changes → the page offers their own copy
//   <orb:error>…</orb:error>                     a failure the server reports in-band
//   <orb:cut/>                                   the AI was stopped here and continues in a new turn:
//                                                 a block left open at this point was cut off
//
// The parser is incremental: chunks may split anywhere (mid-tag, mid-attribute, mid-closing-tag)
// and it is forgiving about the usual model slips (missing labels, markdown fences around code,
// a forgotten closing tag, <orb:find> without an <orb:edit> wrapper, stray text outside tags).

export type StepKind = 'write' | 'edit';

export type ProtocolEvent =
  /**
   * Narration text. `delta` is new text since the last say event; `done` marks the end of a
   * narration block. Deltas are ready to concatenate: consecutive blocks are separated by a blank
   * line inside the first delta of the next block, and outer whitespace is trimmed.
   */
  | { type: 'say'; delta: string; done: boolean }
  | { type: 'title'; text: string }
  /** A write/edit block started streaming (label known as soon as the opening tag is complete). */
  | { type: 'step-start'; id: string; kind: StepKind; label: string }
  /** Progress inside a step: total characters received so far for its body + a short tail for a live code peek. */
  | { type: 'step-progress'; id: string; chars: number; tail: string }
  | { type: 'write'; id: string; label: string; html: string }
  /** One find/replace pair. An edit block with several pairs emits several events with the same id. */
  | { type: 'edit'; id: string; label: string; find: string; replace: string }
  /** A step that could not be used (cut off, unreadable). */
  | { type: 'step-failed'; id: string; kind: StepKind; label: string; error: string; cut?: boolean }
  | { type: 'suggest'; items: string[] }
  /** The model signalled that the person wants changes to a world they can't edit (ask mode). */
  | { type: 'remix' }
  /** In-band upstream failure (the server appends `<orb:error>` when the AI stream breaks mid-way). */
  | { type: 'error'; message: string };

export interface ParserOptions {
  /** Prefix for generated step ids so ids stay unique across rounds/messages. */
  idPrefix?: string;
  /** Emit `step-progress` at most once per this many new body characters (default 160). */
  progressEvery?: number;
  /** Length of the `tail` in `step-progress` (default 200). */
  tailChars?: number;
}

// --- Tag recognition --------------------------------------------------------------------------

/** Opening tags that implicitly terminate an unterminated block (the model "moved on"). */
const OPENER_RE = /^<orb:(say|title|write|edit|suggest|error|remix|cut)(?=[\s>/])/i;
const CLOSER_RE = /^<\/orb:([a-z][a-z0-9_-]*)\s*>/i;
const TAG_HEAD_RE = /^<(\/?)orb:([a-z][a-z0-9_-]*)/i;
/** A string that could still grow into "<orb:…" or "</orb:…" once more input arrives. */
const PARTIAL_TAG_RE = /^<\/?(?:o(?:r(?:b(?::[a-z0-9_-]*\s*)?)?)?)?$/i;
/** Stray text that looks like code is never narrated. */
const CODEY_RE = /```|<!doctype|<\/?(?:html|head|body|script|style|div|canvas)\b/i;
const MAX_TAG_LEN = 600;

interface Tag {
  len: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: Record<string, string>;
}

function startsWithCI(s: string, i: number, prefix: string): boolean {
  return s.slice(i, i + prefix.length).toLowerCase() === prefix;
}

/** Locate the next "<orb:" / "</orb:" in `s`, or a trailing partial that might become one. */
function findTagStart(s: string): { index: number; partial: boolean } | null {
  for (let i = s.indexOf('<'); i !== -1; i = s.indexOf('<', i + 1)) {
    if (startsWithCI(s, i, '<orb:') || startsWithCI(s, i, '</orb:')) return { index: i, partial: false };
    if (s.length - i <= 8 && PARTIAL_TAG_RE.test(s.slice(i))) return { index: i, partial: true };
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const ATTR_RE = /([a-z_:][-a-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’|([^\s"'>/]+))/gi;
function parseAttrs(inner: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of inner.matchAll(ATTR_RE)) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? '');
  }
  return attrs;
}

/**
 * Parse a complete orb tag at the start of `s`.
 * Returns 'partial' if more input is needed, 'invalid' if this is not a tag after all.
 */
function parseTag(s: string): Tag | 'partial' | 'invalid' {
  const head = TAG_HEAD_RE.exec(s);
  if (!head) return PARTIAL_TAG_RE.test(s.slice(0, 12)) && s.length < 12 ? 'partial' : 'invalid';
  // Scan to the closing '>' while respecting quoted attribute values (labels may contain '>').
  let quote: string | null = null;
  let end = -1;
  for (let j = head[0].length; j < s.length && j < MAX_TAG_LEN; j++) {
    const c = s[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      // Only treat as a quote when it opens an attribute value (avoids apostrophes in unquoted text).
      if (/=\s*$/.test(s.slice(Math.max(head[0].length, j - 8), j))) quote = c;
    } else if (c === '“') {
      quote = '”';
    } else if (c === '‘') {
      quote = '’';
    } else if (c === '>') {
      end = j;
      break;
    } else if (c === '<') {
      // A new tag starts before this one closed — not a well-formed tag.
      return 'invalid';
    }
  }
  if (end === -1) {
    if (s.length < MAX_TAG_LEN) return 'partial';
    // Unbalanced quote: fall back to the first '>' so the block is not lost.
    end = s.indexOf('>', head[0].length);
    if (end === -1 || end > MAX_TAG_LEN * 2) return 'invalid';
  }
  // The tag name must be followed by whitespace, '/' or '>' (e.g. not "<orb:sayhello>").
  const after = s[head[0].length];
  if (after !== undefined && !/[\s/>]/.test(after)) return 'invalid';
  const inner = s.slice(head[0].length, end);
  return {
    len: end + 1,
    name: head[2].toLowerCase(),
    closing: head[1] === '/',
    selfClosing: /\/\s*$/.test(inner),
    attrs: parseAttrs(inner),
  };
}

type ScanMode = 'text' | 'write' | 'edit' | 'edit-implicit';
type ScanResult = { end: number; closeLen: number } | { hold: number };

/**
 * Find where the body of the current block ends inside `buf`.
 * - `{end, closeLen}`: the body is buf[0, end); a closing tag of `closeLen` chars follows
 *   (closeLen 0 = implicitly closed by a new block opener, which stays in the buffer).
 * - `{hold}`: no terminator yet; buf[0, hold) is safe body text, the rest may be a partial tag.
 */
function scanBody(buf: string, mode: ScanMode): ScanResult {
  for (let i = buf.indexOf('<'); i !== -1; i = buf.indexOf('<', i + 1)) {
    if (buf.charCodeAt(i + 1) === 47 /* '/' */) {
      const m = CLOSER_RE.exec(buf.slice(i, i + 48));
      if (m) {
        const name = m[1].toLowerCase();
        if (mode === 'text') return { end: i, closeLen: m[0].length };
        if (mode === 'write' && name === 'write') return { end: i, closeLen: m[0].length };
        if ((mode === 'edit' || mode === 'edit-implicit') && name === 'edit') return { end: i, closeLen: m[0].length };
        // An edit started by a bare <orb:find> ends right after its </orb:replace> (kept in the body).
        if (mode === 'edit-implicit' && name === 'replace') return { end: i + m[0].length, closeLen: 0 };
        continue;
      }
    } else if (OPENER_RE.test(buf.slice(i, i + 16))) {
      return { end: i, closeLen: 0 };
    }
    if (buf.length - i <= 48 && PARTIAL_TAG_RE.test(buf.slice(i))) return { hold: i };
  }
  return { hold: buf.length };
}

// --- Body cleanup ------------------------------------------------------------------------------

const LEADING_FENCE_RE = /^\s*```[\w.+-]*[ \t]*\r?\n/;
const TRAILING_FENCE_RE = /\r?\n?[ \t]*```[ \t]*\s*$/;

/** Strip markdown fences and one leading/trailing newline from a code body. */
export function cleanBody(raw: string, kind: 'write' | 'snippet'): string {
  let s = raw;
  const fenced = LEADING_FENCE_RE.test(s);
  if (fenced) s = s.replace(LEADING_FENCE_RE, '');
  // A trailing fence is never valid code at the end of a document; in snippets only strip it
  // when a leading fence was present too.
  if (fenced || kind === 'write') s = s.replace(TRAILING_FENCE_RE, '');
  if (kind === 'write') s = s.replace(/^\s+/, '');
  s = s.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  return s;
}

function cleanLabel(raw: string | undefined): string {
  if (!raw) return '';
  // Already entity-decoded by parseAttrs. Labels are rendered as text (never HTML), so angle
  // brackets are kept as typed.
  const s = raw
    .replace(/[*_`#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 60 ? s.slice(0, 59).replace(/\s+\S*$/, '') + '…' : s;
}

function cleanTitle(raw: string): string {
  let s = decodeEntities(raw)
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’.]+$/g, '')
    .trim();
  if (s.length > 48) s = s.slice(0, 48).replace(/\s+\S*$/, '');
  return s;
}

export function parseSuggestions(raw: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const part of decodeEntities(raw).split(/[|\n]/)) {
    const s = part
      .replace(/<[^>]*>/g, '')
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
      .trim();
    if (!s || s.length > 80) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(s);
    if (items.length === 4) break;
  }
  return items;
}

interface EditPair {
  find: string;
  replace: string;
}

/**
 * Extract find/replace pairs from an edit body. Tolerates a missing </orb:find> (ends at
 * <orb:replace>) and a missing </orb:replace> (ends at the next <orb:find> or the body end —
 * only when the block was terminated; an unterminated body means the replacement was cut off).
 */
function parsePairs(body: string, terminated: boolean): { pairs: EditPair[]; error?: string } {
  const pairs: EditPair[] = [];
  const findOpen = /<orb:find\b[^>]*>/gi;
  let pos = 0;
  let error: string | undefined;
  for (;;) {
    findOpen.lastIndex = pos;
    const fo = findOpen.exec(body);
    if (!fo) break;
    const fStart = fo.index + fo[0].length;
    const replOpen = /<orb:replace\b[^>]*>/gi;
    replOpen.lastIndex = fStart;
    const ro = replOpen.exec(body);
    if (!ro) {
      error = terminated ? 'The change had no <orb:replace> part.' : 'The step was cut off before it finished.';
      break;
    }
    const fClose = /<\/orb:find\s*>/gi;
    fClose.lastIndex = fStart;
    const fc = fClose.exec(body);
    const findEnd = fc && fc.index < ro.index ? fc.index : ro.index;
    const rStart = ro.index + ro[0].length;
    const rClose = /<\/orb:replace\s*>/gi;
    rClose.lastIndex = rStart;
    const rc = rClose.exec(body);
    findOpen.lastIndex = rStart;
    const nextFind = findOpen.exec(body);
    let replEnd: number;
    if (rc && (!nextFind || rc.index < nextFind.index)) {
      replEnd = rc.index;
      pos = rc.index + rc[0].length;
    } else if (nextFind) {
      replEnd = nextFind.index;
      pos = nextFind.index;
    } else if (terminated) {
      replEnd = body.length;
      pos = body.length;
    } else {
      error = 'The step was cut off before it finished.';
      break;
    }
    pairs.push({
      find: cleanBody(body.slice(fStart, findEnd), 'snippet'),
      replace: cleanBody(body.slice(rStart, replEnd), 'snippet'),
    });
  }
  if (!pairs.length && !error) error = terminated ? "Couldn't read this change (no <orb:find>)." : 'The step was cut off before it finished.';
  return { pairs, error };
}

// --- Parser ----------------------------------------------------------------------------------

interface StepState {
  id: string;
  kind: StepKind;
  label: string;
  body: string;
  lastProgress: number;
}

type Mode =
  | { k: 'out' }
  | { k: 'say' }
  | { k: 'title'; text: string }
  | { k: 'suggest'; text: string }
  | { k: 'error'; text: string }
  | { k: 'skip' }
  | { k: 'write'; step: StepState }
  | { k: 'edit'; step: StepState; implicit: boolean };

const OUT: Mode = { k: 'out' };
const EDIT_DEFAULT_LABELS = ['Adding a new touch', 'Polishing the details', 'Making it even nicer', 'Adding finishing touches'];

export class ProtocolParser {
  private buf = '';
  private mode: Mode = OUT;
  private stepCount = 0;
  private writeCount = 0;
  private editCount = 0;
  private ended = false;
  private readonly idPrefix: string;
  private readonly progressEvery: number;
  private readonly tailChars: number;

  // Narration state (shared by <orb:say> blocks and stray-text narration).
  private sawSay = false;
  private strayOff = false;
  private strayOpen = false;
  private narrHasText = false;
  private narrAnyText = false;
  private narrPendingWs = '';

  constructor(opts: ParserOptions = {}) {
    this.idPrefix = opts.idPrefix ?? '';
    this.progressEvery = Math.max(1, opts.progressEvery ?? 160);
    this.tailChars = Math.max(0, opts.tailChars ?? 200);
  }

  /** Feed a chunk of model output; returns events completed/advanced by this chunk. */
  push(chunk: string): ProtocolEvent[] {
    if (this.ended || !chunk) return [];
    this.buf += chunk;
    const out: ProtocolEvent[] = [];
    this.drain(out);
    return out;
  }

  /** Flush at end of stream (closes any dangling blocks gracefully). Idempotent. */
  end(): ProtocolEvent[] {
    if (this.ended) return [];
    const out: ProtocolEvent[] = [];
    this.drain(out);
    // Whatever is left in the buffer is a partial tag (e.g. "</orb:wri") — drop it.
    this.buf = '';
    const m = this.mode;
    this.mode = OUT;
    switch (m.k) {
      case 'say':
        this.closeNarration(out);
        break;
      case 'title':
        this.emitTitle(m.text, out);
        break;
      case 'suggest':
        this.emitSuggest(m.text, out);
        break;
      case 'error':
        this.emitError(m.text, out);
        break;
      case 'write':
        this.closeWrite(m.step, 'eof', out);
        break;
      case 'edit':
        this.closeEdit(m.step, false, out);
        break;
      default:
        if (this.strayOpen) this.closeNarration(out);
    }
    this.ended = true;
    return out;
  }

  // -- core loop --

  private drain(out: ProtocolEvent[]): void {
    for (;;) {
      const m = this.mode;
      if (m.k === 'out') {
        if (!this.drainOut(out)) return;
        continue;
      }
      const scanMode: ScanMode = m.k === 'write' ? 'write' : m.k === 'edit' ? (m.implicit ? 'edit-implicit' : 'edit') : 'text';
      const r = scanBody(this.buf, scanMode);
      const upto = 'hold' in r ? r.hold : r.end;
      const text = this.buf.slice(0, upto);
      switch (m.k) {
        case 'say':
          this.emitNarration(text, out);
          break;
        case 'title':
        case 'suggest':
        case 'error':
          m.text += text;
          break;
        case 'write':
        case 'edit':
          this.appendBody(m.step, text, out);
          break;
      }
      if ('hold' in r) {
        this.buf = this.buf.slice(upto);
        return;
      }
      this.buf = this.buf.slice(r.end + r.closeLen);
      this.mode = OUT;
      // Ended by <orb:cut/>: the block was cut off mid-way — keep it only if it is complete.
      const cut = !r.closeLen && /^<orb:cut\b/i.test(this.buf);
      if (cut && (m.k === 'write' || m.k === 'edit')) {
        const evs: ProtocolEvent[] = [];
        if (m.k === 'write') this.closeWrite(m.step, 'eof', evs);
        else this.closeEdit(m.step, false, evs);
        for (const e of evs) out.push(e.type === 'step-failed' ? { ...e, cut: true } : e);
        continue;
      }
      switch (m.k) {
        case 'say':
          this.closeNarration(out);
          break;
        case 'title':
          this.emitTitle(m.text, out);
          break;
        case 'suggest':
          this.emitSuggest(m.text, out);
          break;
        case 'error':
          this.emitError(m.text, out);
          break;
        case 'write':
          this.closeWrite(m.step, r.closeLen ? 'closed' : 'implicit', out);
          break;
        case 'edit':
          this.closeEdit(m.step, true, out);
          break;
      }
    }
  }

  /** Handle text outside blocks. Returns false when more input is needed. */
  private drainOut(out: ProtocolEvent[]): boolean {
    const t = findTagStart(this.buf);
    if (!t) {
      this.stray(this.buf, out);
      this.buf = '';
      return false;
    }
    this.stray(this.buf.slice(0, t.index), out);
    this.buf = this.buf.slice(t.index);
    if (t.partial) return false;
    const tag = parseTag(this.buf);
    if (tag === 'partial') return false;
    if (tag === 'invalid') {
      // Not a real tag: treat the '<' as plain text and keep going.
      this.stray('<', out);
      this.buf = this.buf.slice(1);
      return true;
    }
    this.buf = this.buf.slice(tag.len);
    this.open(tag, out);
    return true;
  }

  private open(tag: Tag, out: ProtocolEvent[]): void {
    if (tag.closing) return; // stray closing tag outside any block
    const { name } = tag;
    if (this.strayOpen) this.closeNarration(out);
    switch (name) {
      case 'say':
        this.sawSay = true;
        if (!tag.selfClosing) this.mode = { k: 'say' };
        return;
      case 'title':
        if (!tag.selfClosing) this.mode = { k: 'title', text: '' };
        return;
      case 'suggest':
        if (!tag.selfClosing) this.mode = { k: 'suggest', text: '' };
        return;
      case 'error':
        if (!tag.selfClosing) this.mode = { k: 'error', text: '' };
        return;
      case 'remix':
        out.push({ type: 'remix' });
        if (!tag.selfClosing) this.mode = { k: 'skip' };
        return;
      case 'write':
      case 'edit': {
        if (tag.selfClosing) return;
        const step = this.startStep(name, tag.attrs.label, out);
        this.mode = name === 'write' ? { k: 'write', step } : { k: 'edit', step, implicit: false };
        return;
      }
      case 'find': {
        // <orb:find> without an <orb:edit> wrapper: treat it as an edit that ends after </orb:replace>.
        const step = this.startStep('edit', undefined, out);
        step.body = '<orb:find>';
        this.mode = { k: 'edit', step, implicit: true };
        return;
      }
      default:
        // Unknown block (or a stray <orb:replace>): skip its content.
        if (!tag.selfClosing) this.mode = { k: 'skip' };
    }
  }

  // -- steps --

  private startStep(kind: StepKind, rawLabel: string | undefined, out: ProtocolEvent[]): StepState {
    const n = ++this.stepCount;
    let label = cleanLabel(rawLabel);
    if (!label) {
      label =
        kind === 'write'
          ? this.writeCount === 0
            ? 'Building your world'
            : 'Rebuilding your world'
          : EDIT_DEFAULT_LABELS[this.editCount % EDIT_DEFAULT_LABELS.length];
    }
    if (kind === 'write') this.writeCount++;
    else this.editCount++;
    const step: StepState = { id: `${this.idPrefix}step-${n}`, kind, label, body: '', lastProgress: 0 };
    out.push({ type: 'step-start', id: step.id, kind, label });
    return step;
  }

  private appendBody(step: StepState, text: string, out: ProtocolEvent[]): void {
    if (!text) return;
    step.body += text;
    const chars = step.body.length;
    if (chars - step.lastProgress >= this.progressEvery) {
      step.lastProgress = chars;
      out.push({ type: 'step-progress', id: step.id, chars, tail: this.tail(step) });
    }
  }

  private tail(step: StepState): string {
    if (!this.tailChars) return '';
    const raw = step.body.slice(-(this.tailChars + 64));
    const visible = step.kind === 'edit' ? raw.replace(/<\/?orb:(?:find|replace)\b[^>]*>/gi, '') : raw;
    return visible.slice(-this.tailChars);
  }

  private closeWrite(step: StepState, how: 'closed' | 'implicit' | 'eof', out: ProtocolEvent[]): void {
    let html = cleanBody(step.body, 'write');
    if (how === 'eof') {
      // Cut off mid-stream: only usable if the document is complete.
      const re = /<\/html\s*>/gi;
      let last = -1;
      let lastLen = 0;
      for (const m of html.matchAll(re)) {
        last = m.index;
        lastLen = m[0].length;
      }
      if (last === -1) {
        out.push({ type: 'step-failed', id: step.id, kind: 'write', label: step.label, error: 'The new world was cut off before it was finished.' });
        return;
      }
      html = html.slice(0, last + lastLen);
    }
    if (!html.trim()) {
      out.push({ type: 'step-failed', id: step.id, kind: 'write', label: step.label, error: 'The new world was empty.' });
      return;
    }
    out.push({ type: 'write', id: step.id, label: step.label, html });
  }

  private closeEdit(step: StepState, terminated: boolean, out: ProtocolEvent[]): void {
    const { pairs, error } = parsePairs(step.body, terminated);
    for (const p of pairs) out.push({ type: 'edit', id: step.id, label: step.label, find: p.find, replace: p.replace });
    if (error) out.push({ type: 'step-failed', id: step.id, kind: 'edit', label: step.label, error });
  }

  // -- narration --

  private stray(text: string, out: ProtocolEvent[]): void {
    if (!text || this.sawSay || this.strayOff) return;
    const code = CODEY_RE.exec(text);
    if (code) {
      // Narrate the prose before the code, then stop narrating stray text for good.
      const before = text.slice(0, code.index);
      if (/\S/.test(before)) {
        this.strayOpen = true;
        this.emitNarration(before, out);
      }
      this.strayOff = true;
      if (this.strayOpen) this.closeNarration(out);
      return;
    }
    if (!this.strayOpen && !/\S/.test(text)) return;
    this.strayOpen = true;
    this.emitNarration(text, out);
  }

  private emitNarration(text: string, out: ProtocolEvent[]): void {
    let t = text;
    if (!this.narrHasText) t = t.replace(/^\s+/, '');
    if (!t) return;
    let full = this.narrPendingWs + t;
    const ws = /\s+$/.exec(full);
    this.narrPendingWs = ws ? ws[0] : '';
    if (ws) full = full.slice(0, full.length - ws[0].length);
    if (!full) return;
    if (!this.narrHasText && this.narrAnyText) full = '\n\n' + full;
    this.narrHasText = true;
    this.narrAnyText = true;
    out.push({ type: 'say', delta: full, done: false });
  }

  private closeNarration(out: ProtocolEvent[]): void {
    if (this.narrHasText) out.push({ type: 'say', delta: '', done: true });
    this.narrHasText = false;
    this.narrPendingWs = '';
    this.strayOpen = false;
  }

  private emitTitle(raw: string, out: ProtocolEvent[]): void {
    const text = cleanTitle(raw);
    if (text) out.push({ type: 'title', text });
  }

  private emitSuggest(raw: string, out: ProtocolEvent[]): void {
    const items = parseSuggestions(raw);
    if (items.length) out.push({ type: 'suggest', items });
  }

  private emitError(raw: string, out: ProtocolEvent[]): void {
    const message = decodeEntities(raw).replace(/\s+/g, ' ').trim();
    out.push({ type: 'error', message: message || 'The AI stopped unexpectedly.' });
  }
}

/** Parse a complete reply in one go (tests, mocks, debugging). */
export function parseAll(text: string, opts?: ParserOptions): ProtocolEvent[] {
  const p = new ProtocolParser(opts);
  return [...p.push(text), ...p.end()];
}

// --- Edit applier ----------------------------------------------------------------------------

export type EditResult =
  | {
      ok: true;
      code: string;
      /** True when the snippet matched only after ignoring whitespace differences (or was a no-op). */
      fuzzy: boolean;
      /** True when the find wasn't present but the replacement already was (idempotent re-apply). */
      noop?: boolean;
    }
  | { ok: false; error: string };

const normLine = (l: string): string => l.trim().replace(/\s+/g, ' ');
const leadingWs = (l: string): string => /^[ \t]*/.exec(l)![0];

/**
 * Apply one find/replace edit:
 * 1. exact match (first occurrence);
 * 2. whitespace-insensitive line-window match (ignores indentation, trailing spaces and blank
 *    lines; the replacement is re-indented to the code's indentation);
 * 3. whitespace-insensitive match within lines (snippets that start/end mid-line);
 * 4. if the replacement is already present, succeed without changes (idempotent);
 * otherwise fail with a hint that helps a repair round.
 */
export function applyEdit(code: string, find: string, replace: string): EditResult {
  if (!find || !find.trim()) return { ok: false, error: 'The <orb:find> snippet was empty.' };

  const exact = code.indexOf(find);
  if (exact !== -1) return { ok: true, code: code.slice(0, exact) + replace + code.slice(exact + find.length), fuzzy: false };

  const lw = lineWindowApply(code, find, replace);
  if (lw !== null) return { ok: true, code: lw, fuzzy: true };

  const loose = compactMatch(code, find);
  if (loose) return { ok: true, code: code.slice(0, loose.start) + replace + code.slice(loose.end), fuzzy: true };

  if (alreadyPresent(code, replace)) return { ok: true, code, fuzzy: true, noop: true };

  return { ok: false, error: describeMiss(code, find) };
}

/** Line offsets: start index of each line in `code` (lines split on '\n'). */
function lineStarts(lines: string[]): number[] {
  const starts = new Array<number>(lines.length);
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = off;
    off += lines[i].length + 1;
  }
  return starts;
}

function lineWindowApply(code: string, find: string, replace: string): string | null {
  const findLines = find.split('\n');
  const want = findLines.map(normLine).filter(Boolean);
  if (!want.length) return null;
  const lines = code.split('\n');
  // Compare only non-blank lines so blank-line differences don't matter.
  const idx: number[] = [];
  const norm: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const n = normLine(lines[i]);
    if (n) {
      idx.push(i);
      norm.push(n);
    }
  }
  let at = -1;
  outer: for (let s = 0; s + want.length <= norm.length; s++) {
    if (norm[s] !== want[0]) continue;
    for (let k = 1; k < want.length; k++) if (norm[s + k] !== want[k]) continue outer;
    at = s;
    break;
  }
  if (at === -1) return null;
  const startLine = idx[at];
  const endLine = idx[at + want.length - 1];
  const starts = lineStarts(lines);
  const start = starts[startLine];
  let end = starts[endLine] + lines[endLine].length;
  if (lines[endLine].endsWith('\r')) end -= 1; // keep CRLF line endings intact
  const crlf = code.includes('\r\n');

  if (!replace.trim()) {
    // Deletion: drop the lines together with one line break.
    let delEnd = end;
    if (code.slice(delEnd, delEnd + 2) === '\r\n') delEnd += 2;
    else if (code[delEnd] === '\n') delEnd += 1;
    else if (start > 0) return code.slice(0, code[start - 2] === '\r' ? start - 2 : start - 1) + code.slice(end);
    return code.slice(0, start) + code.slice(delEnd);
  }

  // Anchor each non-blank find line to the code line it matched, for re-indentation.
  const findNonBlank = findLines.filter((l) => l.trim());
  const anchors: Anchor[] = want.map((n, k) => ({
    norm: n,
    findIndent: leadingWs(findNonBlank[k]),
    codeIndent: leadingWs(lines[idx[at + k]]),
  }));
  let out = reindent(replace, anchors);
  if (crlf) out = out.replace(/\r?\n/g, '\r\n');
  return code.slice(0, start) + out + code.slice(end);
}

interface Anchor {
  norm: string;
  findIndent: string;
  codeIndent: string;
}

/**
 * Re-indent the replacement of a fuzzy line match. The matched lines are replaced including their
 * indentation, so the replacement must carry the code's indentation:
 * - if it is already written against the code's real indentation, it is used as is;
 * - otherwise each line is shifted by the difference between the code's and the find's
 *   indentation, measured at the most recent replacement line that also appears in the find.
 *   So a flat replacement takes the code's indentation (that of the first matched line for new
 *   lines), kept lines snap back to their original indentation, and nesting the model added on
 *   top of its find is preserved.
 */
function reindent(replace: string, matched: Anchor[]): string {
  const lines = replace.split('\n');
  const first = lines.find((l) => l.trim());
  if (first === undefined || !matched.length) return replace;
  // A replacement written from column 0 (relative indentation only) is rebased from column 0, even
  // if its find carried the real indentation: measure the find relative to its own base too.
  const findBase = matched[0].findIndent;
  const anchors =
    !leadingWs(first) && findBase
      ? matched.map((a) => ({ ...a, findIndent: a.findIndent.startsWith(findBase) ? a.findIndent.slice(findBase.length) : '' }))
      : matched;

  // Pair replacement lines with the find lines they repeat (in order).
  const anchorOf: Array<Anchor | null> = [];
  let ptr = 0;
  for (const l of lines) {
    let hit: Anchor | null = null;
    if (l.trim()) {
      const n = normLine(l);
      for (let j = ptr; j < anchors.length; j++) {
        if (anchors[j].norm === n) {
          hit = anchors[j];
          ptr = j + 1;
          break;
        }
      }
    }
    anchorOf.push(hit);
  }
  const paired = lines.map((l, i) => [l, anchorOf[i]] as const).filter((p): p is readonly [string, Anchor] => p[1] !== null);
  const shifted = anchors.some((a) => a.codeIndent !== a.findIndent);
  if (!shifted) return replace; // find was indented like the code → replacement presumably too
  const absolute = paired.length
    ? paired.every(([l, a]) => leadingWs(l) === a.codeIndent)
    : leadingWs(first) === anchors[0].codeIndent;
  if (absolute) return replace;

  const unit = anchors.some((a) => a.codeIndent.includes('\t')) ? '\t' : ' ';
  let delta = anchors[0].codeIndent.length - anchors[0].findIndent.length;
  return lines
    .map((l, i) => {
      if (!l.trim()) return '';
      const lead = leadingWs(l);
      const a = anchorOf[i];
      if (a) {
        delta = a.codeIndent.length - a.findIndent.length;
        // Same relative indentation as in the find: reuse the code's exact indentation (tabs, mixes).
        if (lead === a.findIndent) return a.codeIndent + l.slice(lead.length);
      }
      return unit.repeat(Math.max(0, lead.length + delta)) + l.slice(lead.length);
    })
    .join('\n');
}

/** Whitespace-free view of `code` with a map back to original offsets. */
function compact(code: string): { text: string; map: Int32Array } {
  const map = new Int32Array(code.length);
  let text = '';
  let n = 0;
  let runStart = 0;
  for (let i = 0; i <= code.length; i++) {
    const c = code.charCodeAt(i);
    const ws = i === code.length || c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 160;
    if (ws) {
      if (i > runStart) {
        text += code.slice(runStart, i);
        for (let k = runStart; k < i; k++) map[n++] = k;
      }
      runStart = i + 1;
    }
  }
  return { text, map: map.subarray(0, n) };
}

function compactMatch(code: string, find: string): { start: number; end: number } | null {
  const f = find.replace(/\s+/g, '');
  if (f.length < 4) return null;
  const c = compact(code);
  const i = c.text.indexOf(f);
  if (i === -1) return null;
  return { start: c.map[i], end: c.map[i + f.length - 1] + 1 };
}

function alreadyPresent(code: string, replace: string): boolean {
  const r = replace.trim();
  // Too short/generic to be meaningful evidence ("}" or "</div>" are everywhere).
  if (r.length < 24 && !r.includes('\n')) return false;
  if (code.includes(r)) return true;
  const rc = r.replace(/\s+/g, '');
  return rc.length >= 24 && compact(code).text.includes(rc);
}

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** Explain why a find didn't match, pointing at the closest spot — useful for repair rounds. */
function describeMiss(code: string, find: string): string {
  const want = find.split('\n').filter((l) => l.trim());
  const first = normLine(want[0] ?? '');
  const lines = code.split('\n');
  let best = { line: -1, matched: 0 };
  for (let i = 0; i < lines.length; i++) {
    if (normLine(lines[i]) !== first) continue;
    // Count how many following non-blank lines agree.
    let k = 1;
    let j = i + 1;
    while (k < want.length && j < lines.length) {
      if (!lines[j].trim()) {
        j++;
        continue;
      }
      if (normLine(lines[j]) !== normLine(want[k])) break;
      k++;
      j++;
    }
    if (k > best.matched) best = { line: i, matched: k };
  }
  if (best.line === -1) return `Snippet not found: the line "${clip(want[0] ?? find, 90)}" does not exist in the current code.`;
  const bad = want[best.matched];
  let actual = '';
  for (let j = best.line + 1, k = 1; j < lines.length; j++) {
    if (!lines[j].trim()) continue;
    if (k === best.matched) {
      actual = lines[j];
      break;
    }
    k++;
  }
  return (
    `Snippet not found: the first ${best.matched === 1 ? 'line matches' : `${best.matched} lines match`} at line ${best.line + 1}, ` +
    `but then "${clip(bad ?? '', 90)}" differs from the code's "${clip(actual, 90)}".`
  );
}
