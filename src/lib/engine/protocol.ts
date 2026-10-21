// Streaming parser for the Orb protocol (SPEC §8): the text of a build's output. Pure functions,
// no DOM, no imports — usable on the server, in the browser and in node tests. Agent jobs write
// five namespaced blocks (their file changes travel as control frames):
//   <orb:say>…</orb:say>                         narration (may appear several times)
//   <orb:title>…</orb:title>                     world name
//   <orb:suggest>a|b|c</orb:suggest>             next ideas
//   <orb:remix/>                                 (ask mode) the person wants changes → the page offers Remix
//   <orb:error>…</orb:error>                     a failure the server reports in-band
//
// The parser is incremental: chunks may split anywhere (mid-tag, mid-closing-tag) and it is
// forgiving about the usual model slips (a forgotten closing tag, stray text outside tags).

export type ProtocolEvent =
  /**
   * Narration text. `delta` is new text since the last say event; `done` marks the end of a
   * narration block. Deltas are ready to concatenate: consecutive blocks are separated by a blank
   * line inside the first delta of the next block, and outer whitespace is trimmed.
   */
  | { type: 'say'; delta: string; done: boolean }
  | { type: 'title'; text: string }
  | { type: 'suggest'; items: string[] }
  /** The model signalled that the person wants changes to a world they can't edit (ask mode). */
  | { type: 'remix' }
  /** In-band upstream failure (the server appends `<orb:error>` when the AI stream breaks mid-way). */
  | { type: 'error'; message: string };

// --- Tag recognition --------------------------------------------------------------------------

/** Opening tags that implicitly terminate an unterminated block (the model "moved on"). */
const OPENER_RE = /^<orb:(say|title|suggest|error|remix)(?=[\s>/])/i;
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

/**
 * Parse a complete orb tag at the start of `s` (none of the blocks has attributes).
 * Returns 'partial' if more input is needed, 'invalid' if this is not a tag after all.
 */
function parseTag(s: string): Tag | 'partial' | 'invalid' {
  const head = TAG_HEAD_RE.exec(s);
  if (!head) return PARTIAL_TAG_RE.test(s.slice(0, 12)) && s.length < 12 ? 'partial' : 'invalid';
  const from = head[0].length;
  // The tag name must be followed by whitespace, '/' or '>' (e.g. not "<orb:say.x>").
  if (from < s.length && !/[\s/>]/.test(s[from])) return 'invalid';
  const scan = s.slice(0, MAX_TAG_LEN);
  const end = scan.indexOf('>', from);
  const next = scan.indexOf('<', from);
  // A new tag starts before this one closed — not a well-formed tag.
  if (next !== -1 && (end === -1 || next < end)) return 'invalid';
  if (end === -1) return s.length < MAX_TAG_LEN ? 'partial' : 'invalid';
  return { len: end + 1, name: head[2].toLowerCase(), closing: head[1] === '/', selfClosing: /\/\s*$/.test(s.slice(from, end)) };
}

type ScanResult = { end: number; closeLen: number } | { hold: number };

/**
 * Find where the body of the current block ends inside `buf`.
 * - `{end, closeLen}`: the body is buf[0, end); a closing tag of `closeLen` chars follows
 *   (closeLen 0 = implicitly closed by a new block opener, which stays in the buffer).
 * - `{hold}`: no terminator yet; buf[0, hold) is safe body text, the rest may be a partial tag.
 */
function scanBody(buf: string): ScanResult {
  for (let i = buf.indexOf('<'); i !== -1; i = buf.indexOf('<', i + 1)) {
    if (buf.charCodeAt(i + 1) === 47 /* '/' */) {
      const m = CLOSER_RE.exec(buf.slice(i, i + 48));
      if (m) return { end: i, closeLen: m[0].length };
    } else if (OPENER_RE.test(buf.slice(i, i + 16))) {
      return { end: i, closeLen: 0 };
    }
    if (buf.length - i <= 48 && PARTIAL_TAG_RE.test(buf.slice(i))) return { hold: i };
  }
  return { hold: buf.length };
}

// --- Cleanup -----------------------------------------------------------------------------------

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

// --- Parser ----------------------------------------------------------------------------------

/** Outside any block, in one, or skipping one (unknown blocks, a remix with content). */
type Mode = { k: 'out' } | { k: 'say' } | { k: 'skip' } | { k: 'title' | 'suggest' | 'error'; text: string };

const OUT: Mode = { k: 'out' };

export class ProtocolParser {
  private buf = '';
  private mode: Mode = OUT;
  private ended = false;

  // Narration state (shared by <orb:say> blocks and stray-text narration).
  private sawSay = false;
  private strayOff = false;
  private strayOpen = false;
  private narrHasText = false;
  private narrAnyText = false;
  private narrPendingWs = '';

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
    // Whatever is left in the buffer is a partial tag (e.g. "</orb:sa") — drop it.
    this.buf = '';
    const m = this.mode;
    this.mode = OUT;
    if (m.k === 'out' && this.strayOpen) this.closeNarration(out);
    else this.close(m, out);
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
      const r = scanBody(this.buf);
      const upto = 'hold' in r ? r.hold : r.end;
      const text = this.buf.slice(0, upto);
      if (m.k === 'say') this.emitNarration(text, out);
      else if (m.k !== 'skip') m.text += text;
      if ('hold' in r) {
        this.buf = this.buf.slice(upto);
        return;
      }
      this.buf = this.buf.slice(r.end + r.closeLen);
      this.mode = OUT;
      this.close(m, out);
    }
  }

  /** A block ended (closed, implicitly by the next one, or at the end of the stream). */
  private close(m: Mode, out: ProtocolEvent[]): void {
    switch (m.k) {
      case 'say':
        this.closeNarration(out);
        break;
      case 'title': {
        const text = cleanTitle(m.text);
        if (text) out.push({ type: 'title', text });
        break;
      }
      case 'suggest': {
        const items = parseSuggestions(m.text);
        if (items.length) out.push({ type: 'suggest', items });
        break;
      }
      case 'error': {
        const message = decodeEntities(m.text).replace(/\s+/g, ' ').trim();
        out.push({ type: 'error', message: message || 'The AI stopped unexpectedly.' });
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
    if (name === 'say') this.sawSay = true;
    if (name === 'remix') out.push({ type: 'remix' });
    if (tag.selfClosing) return;
    if (name === 'say') this.mode = { k: 'say' };
    else if (name === 'title' || name === 'suggest' || name === 'error') this.mode = { k: name, text: '' };
    else this.mode = { k: 'skip' }; // an unknown block (or a remix with content): skip its content
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
}

/** Parse a complete reply in one go (tests, mocks, debugging). */
export function parseAll(text: string): ProtocolEvent[] {
  const p = new ProtocolParser();
  return [...p.push(text), ...p.end()];
}
