// Reading library code and documentation from the web, for the agent's `read_docs` tool: the
// exact source of a three.js addon on jsDelivr, a package's file list, an MDN page… Only a few
// well-known hosts over https (so nothing private can be reached), text only, size-capped.

import { SITE } from '../../lib/site';

const HOSTS = new Set(['cdn.jsdelivr.net', 'data.jsdelivr.com', 'unpkg.com', 'raw.githubusercontent.com', 'threejs.org', 'developer.mozilla.org']);
const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const DEFAULT_LINES = 400;
const MAX_LINES = 1500;
const MAX_MATCHES = 80;

export const DOC_HOSTS = [...HOSTS];

export function allowedUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !HOSTS.has(u.hostname)) return null;
  return u;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** An HTML page as readable text: scripts, styles and tags removed, blocks on their own lines. */
export function htmlToText(html: string): string {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] ?? html;
  return main
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(pre|code)\b[^>]*>/gi, '\n')
    .replace(/<\/?(p|div|section|article|header|footer|nav|li|ul|ol|h[1-6]|tr|table|pre|br|hr|dt|dd|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readCapped(res: Response): Promise<{ text: string; cut: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: '', cut: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      chunks.push(value.subarray(0, value.length - (size - MAX_BYTES)));
      cut = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), cut };
}

const TEXTUAL = /^(text\/|application\/(javascript|ecmascript|json|xml|x-javascript|ld\+json|manifest\+json)|image\/svg\+xml)/i;

/** The text at an allowed URL (following redirects only to allowed hosts). */
export async function fetchText(raw: string, fetcher: typeof fetch = fetch): Promise<{ url: string; text: string; cut: boolean; html: boolean } | { error: string }> {
  const first = allowedUrl(raw);
  if (!first) return { error: `Only https pages on ${DOC_HOSTS.join(', ')} can be read.` };
  let u: URL = first;
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetcher(u.href, { redirect: 'manual', headers: { accept: 'text/*, application/javascript, application/json;q=0.9, */*;q=0.1', 'user-agent': `OrbWorldBuilder/1.0 (+${SITE})` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      return { error: `Couldn't reach ${u.hostname} (${e instanceof Error ? e.message : String(e)}).` };
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      const to: URL | null = next ? allowedUrl(new URL(next, u).href) : null;
      if (!to || hop >= MAX_REDIRECTS) return { error: `${u.href} redirects to ${next ?? 'nowhere'}, which can't be read.` };
      u = to;
      continue;
    }
    if (!res.ok) return { error: `${u.href} answered ${res.status}${res.status === 404 ? ' (not found — check the path and version)' : ''}.` };
    const type = res.headers.get('content-type') ?? '';
    if (type && !TEXTUAL.test(type)) return { error: `${u.href} is not text (${type.split(';')[0]}).` };
    const { text, cut } = await readCapped(res);
    const html = /html/i.test(type) || (!type && /^\s*<(!doctype|html)/i.test(text));
    return { url: u.href, text: html ? htmlToText(text) : text, cut, html };
  }
}

/** Lines of a text, numbered like read_file; or only the lines matching `find`. */
export function excerpt(text: string, opts: { offset?: number; limit?: number; find?: string }): string {
  const lines = text.split('\n');
  if (opts.find) {
    let re: RegExp;
    try {
      re = new RegExp(opts.find, 'i');
    } catch {
      re = new RegExp(opts.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    const out: string[] = [];
    let more = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      if (out.length >= MAX_MATCHES) more++;
      else out.push(`${i + 1}\t${lines[i].length > 300 ? `${lines[i].slice(0, 300)}…` : lines[i]}`);
    }
    if (!out.length) return `No lines match "${opts.find}" (${lines.length} lines).`;
    return `${out.join('\n')}${more ? `\n… and ${more} more matches` : ''}\n(read around a match with offset)`;
  }
  const start = Math.max(1, Math.floor(opts.offset ?? 1));
  const limit = Math.min(MAX_LINES, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LINES)));
  const end = Math.min(lines.length, start + limit - 1);
  const body = lines
    .slice(start - 1, end)
    .map((l, i) => `${start + i}\t${l.length > 500 ? `${l.slice(0, 500)}…` : l}`)
    .join('\n');
  const head = start > 1 || end < lines.length ? `(lines ${start}–${end} of ${lines.length})\n` : '';
  return `${head}${body}${end < lines.length ? `\n… ${lines.length - end} more lines (read on with offset ${end + 1}, or use find)` : ''}`;
}
