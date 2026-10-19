// Query parameters written into the query text as literals, so that every query reaches Postgres as
// one simple-protocol message. Through Supabase's transaction pooler, postgres.js sends a query with
// parameters in two steps (Parse/Describe/Flush, then Bind/Execute/Sync), and under load the pooler
// can hand the second step to another server connection: the query then fails ("unnamed prepared
// statement does not exist"), runs with another request's statement, or leaves the first connection
// waiting mid-query, holding its locks, until the statement timeout.
//
// A quoted literal has no type, like an untyped parameter, so Postgres infers the same type from
// the context (casts such as `$1::jsonb` keep working); values postgres.js would send typed (dates,
// bytes, booleans, bigints) are typed here too.
//
// Both databases (./db) first make the values storable (storableParams).

// --- values Postgres can store ---------------------------------------------------------------------

/** A string Postgres can store as text: no NUL characters, no halves of surrogate pairs. */
function storableText(s: string): string {
  return s.includes('\u0000') || !s.isWellFormed() ? s.replace(/\u0000/g, '').toWellFormed() : s;
}

function storableValue(v: unknown): unknown {
  if (typeof v === 'string') return storableText(v);
  if (Array.isArray(v)) return v.map(storableValue);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [storableText(k), storableValue(x)]));
  return v;
}

/** JSON.stringify writes a NUL as \u0000 and a lone surrogate as \udxxx, and jsonb takes neither. */
const UNSTORABLE_ESCAPE = /\\u0000|\\ud[89a-f][0-9a-f]{2}/i;

function storableJson(s: string): string {
  const text = storableText(s);
  if (!UNSTORABLE_ESCAPE.test(text)) return text;
  try {
    return JSON.stringify(storableValue(JSON.parse(text)));
  } catch {
    return text;
  }
}

/**
 * `params` as values Postgres accepts. Text can't hold NUL characters, and jsonb (the `$n::jsonb`
 * parameters) rejects their \u0000 escape and halves of surrogate pairs: any of them fails the
 * whole query. They come from outside — WebGL shader logs end in a NUL, and a world's runtime
 * errors, console output and stored values carry them along — so they are dropped (NUL) or
 * replaced with U+FFFD (lone surrogates).
 */
export function storableParams(text: string, params: readonly unknown[]): unknown[] {
  let jsonb: Set<number> | null = null;
  return params.map((p, i) => {
    if (typeof p !== 'string') return p;
    jsonb ??= new Set([...text.matchAll(/\$(\d+)\s*::\s*jsonb\b/gi)].map((m) => Number(m[1])));
    return jsonb.has(i + 1) ? storableJson(p) : storableText(p);
  });
}

// --- literals ---------------------------------------------------------------------------------------

/** An E'…' string: safe whatever `standard_conforming_strings` is set to. */
function quote(s: string): string {
  return `E'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

const hex = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');

/** An array value in Postgres' text form, e.g. {"a","b c",NULL}. */
function arrayText(xs: readonly unknown[]): string {
  return `{${xs
    .map((x) => {
      if (x === null || x === undefined) return 'NULL';
      if (Array.isArray(x)) return arrayText(x);
      const s = x instanceof Date ? x.toISOString() : x instanceof Uint8Array ? `\\x${hex(x)}` : typeof x === 'object' ? JSON.stringify(x) : String(x);
      return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    })
    .join(',')}}`;
}

/** One parameter value as an SQL literal. */
export function literal(v: unknown): string {
  if (v === undefined) throw new Error('Undefined values are not allowed');
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'bigint') return `${quote(String(v))}::int8`;
  if (v instanceof Date) return `${quote(v.toISOString())}::timestamptz`;
  if (v instanceof Uint8Array) return `${quote(`\\x${hex(v)}`)}::bytea`;
  if (Array.isArray(v)) return quote(arrayText(v));
  if (typeof v === 'object') return quote(JSON.stringify(v));
  return quote(String(v));
}

const WORD = /[\w$]/;

/** End (exclusive) of the quoted text starting at `i`; `''` (or `""`) inside it is a quote. */
function closing(text: string, i: number, q: string, backslashes: boolean): number {
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (backslashes && c === '\\') j += 2;
    else if (c === q && text[j + 1] === q) j += 2;
    else if (c === q) return j + 1;
    else j++;
  }
  return text.length;
}

/**
 * `text` with each `$n` placeholder replaced by the literal of `params[n - 1]`. Placeholders inside
 * quoted strings, quoted identifiers, comments and dollar-quoted strings are left alone.
 */
export function inlineParams(text: string, params: readonly unknown[]): string {
  let out = '';
  let from = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const prev = text[i - 1] ?? '';
    let end = -1;
    if (c === "'") end = closing(text, i, "'", /[eE]/.test(prev) && !WORD.test(text[i - 2] ?? ''));
    else if (c === '"') end = closing(text, i, '"', false);
    else if (c === '-' && text[i + 1] === '-') end = text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i);
    else if (c === '/' && text[i + 1] === '*') end = text.indexOf('*/', i + 2) < 0 ? text.length : text.indexOf('*/', i + 2) + 2;
    else if (c === '$' && !WORD.test(prev)) {
      const n = /^\$(\d+)/.exec(text.slice(i, i + 12));
      if (n) {
        const k = Number(n[1]);
        if (k < 1 || k > params.length) throw new Error(`No value for parameter $${k}`);
        out += text.slice(from, i) + literal(params[k - 1]);
        i += n[0].length;
        from = i;
        continue;
      }
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(text.slice(i, i + 64));
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        end = close < 0 ? text.length : close + tag[0].length;
      }
    }
    i = end > i ? end : i + 1;
  }
  return out + text.slice(from);
}
