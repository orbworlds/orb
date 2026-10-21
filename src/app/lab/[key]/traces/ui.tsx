import type { ReactNode } from 'react';
import { blobSha, type Tokens, type TraceKind, type TraceStatus } from '@/server/traces';

// What the trace pages share: the card, numbers read at a glance, a status, folds for long text,
// and any JSON value laid out to read (stored screenshots shown, other stored blobs as links).

export { ago, CARD } from '../pulse/ui';

export const KINDS: Record<TraceKind, string> = { agent: 'Agent', cursor: 'Cursor', build: 'Build', direct: 'Own key' };

export const when = (iso: string) => `${iso.slice(0, 19).replace('T', ' ')} UTC`;
export const num = (n: number) => Math.round(n).toLocaleString('en-US');

/** 950, 12.3k, 4.5M */
export function short(n: number): string {
  for (const [d, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']] as const) {
    if (n >= d) return `${n / d < 9.95 ? (n / d).toFixed(1) : Math.round(n / d)}${unit}`;
  }
  return String(Math.round(n));
}

export function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 59_500) return `${(ms / 1000).toFixed(ms < 9950 ? 1 : 0)} s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/** Time since the start, as m:ss (h:mm:ss past an hour). */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${ss}` : `${Math.floor(s / 60)}:${ss}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  let v = n / 1024;
  let i = 0;
  for (; v >= 1024 && i < 3; i++) v /= 1024;
  return `${v < 9.95 ? v.toFixed(1) : Math.round(v)} ${['KB', 'MB', 'GB', 'TB'][i]}`;
}

/** "12.3k in (11k cached) · 410 out (90 thinking)" */
export function tokenLine(t: Partial<Tokens>, exact = false): string {
  const f = exact ? num : short;
  const { in: i = 0, out = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0 } = t;
  const extra = [cacheRead ? `${f(cacheRead)} cached` : '', cacheWrite ? `${f(cacheWrite)} cache writes` : ''].filter(Boolean).join(', ');
  return `${f(i)} in${extra ? ` (${extra})` : ''} · ${f(out)} out${reasoning ? ` (${f(reasoning)} thinking)` : ''}`;
}

const STATUS: Record<TraceStatus, [string, string]> = {
  running: ['Running', 'animate-pulse bg-[var(--iris-2)]'],
  done: ['Done', 'bg-[var(--ok)]'],
  failed: ['Failed', 'bg-[var(--bad)]'],
  cancelled: ['Stopped', 'bg-[var(--ink-3)]'],
};

export function Status({ status }: { status: TraceStatus }) {
  const [label, dot] = STATUS[status] ?? [status, 'bg-[var(--ink-3)]'];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

// -- long text and JSON -------------------------------------------------------------------------

/** Past this, a page shows the start of a text (the JSONL export has all of it). */
const PAGE_MAX = 100_000;
const clip = (s: string) => (s.length > PAGE_MAX ? `${s.slice(0, PAGE_MAX)}\n\n… ${num(s.length - PAGE_MAX)} more characters (the JSONL export has them)` : s);
const lineCount = (s: string) => s.split('\n').length;
export const isLong = (s: string, max = 280) => s.length > max || lineCount(s) > 6;
export const sizeOf = (s: string) => (lineCount(s) > 1 ? `${num(lineCount(s))} lines` : `${num(s.length)} characters`);

export function Pre({ children, tone = 'text-ink-2' }: { children: string; tone?: string }) {
  return <pre className={`mt-1.5 max-h-[480px] overflow-auto rounded-[10px] bg-[var(--field-bg)] px-3 py-2.5 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap ${tone}`}>{clip(children)}</pre>;
}

export function Fold({ summary, open, children }: { summary: ReactNode; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group mt-1.5 min-w-0">
      <summary className="cursor-pointer text-[12.5px] break-words text-ink-2 select-none group-open:text-ink hover:text-ink">{summary}</summary>
      {children}
    </details>
  );
}

const blobUrl = (lab: string, sha: string) => `${lab}/blob/${sha}`;

export function BlobLink({ lab, sha, children }: { lab: string; sha: string; children?: ReactNode }) {
  return (
    <a href={blobUrl(lab, sha)} target="_blank" rel="noreferrer" className="font-mono text-[12px] break-all text-ink underline decoration-[var(--ink-4)] underline-offset-2 hover:decoration-[var(--ink-2)]">
      {children ?? `stored ${sha.slice(0, 10)}`}
    </a>
  );
}

export function Shot({ lab, sha, label, small }: { lab: string; sha: string; label?: string; small?: boolean }) {
  return (
    <figure className="m-0 min-w-0">
      <a href={blobUrl(lab, sha)} target="_blank" rel="noreferrer" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element -- stored screenshots, from the lab's blob route */}
        <img src={blobUrl(lab, sha)} alt={label ?? 'Screenshot'} loading="lazy" decoding="async" className={`block w-auto max-w-full rounded-[10px] bg-[var(--field-bg)] shadow-[0_0_0_1px_var(--ink-5)] ${small ? 'max-h-[150px]' : 'max-h-[220px]'}`} />
      </a>
      {label && <figcaption className="mt-1 text-[11.5px] text-ink-3">{label}</figcaption>}
    </figure>
  );
}

/** A value laid out to read: short ones inline, long text folded with its own lines, stored blobs as links. */
function Value({ v, lab, name }: { v: unknown; lab: string; name?: string }) {
  if (typeof v === 'string') {
    const sha = blobSha(v);
    if (sha) return <BlobLink lab={lab} sha={sha} />;
    if (!isLong(v)) return <code className="font-mono text-[12px] break-words whitespace-pre-wrap text-ink">{v}</code>;
    return (
      <Fold summary={`${name ?? 'text'} · ${sizeOf(v)}`}>
        <Pre>{v}</Pre>
      </Fold>
    );
  }
  if (v === null || typeof v !== 'object') return <code className="font-mono text-[12px] text-ink">{String(v)}</code>;
  const flat = JSON.stringify(v);
  if (flat.length <= 160) return <code className="font-mono text-[12px] break-all text-ink">{flat}</code>;
  const json = JSON.stringify(v, null, 2);
  return (
    <Fold summary={`${name ?? 'value'} · ${sizeOf(json)}`}>
      <Pre>{json}</Pre>
    </Fold>
  );
}

const brief = (v: unknown) => (typeof v === 'string' ? !isLong(v, 120) || blobSha(v) !== null : v === null || typeof v !== 'object' || JSON.stringify(v).length <= 100);
/** Whether <Value> folds `v` away (its fold then says its name). */
const folds = (v: unknown) => (typeof v === 'string' ? isLong(v) && blobSha(v) === null : v !== null && typeof v === 'object' && JSON.stringify(v).length > 160);

/** An object's fields: the short ones together on a line, each long one on its own. */
export function Fields({ o, lab }: { o: unknown; lab: string }) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o === undefined ? null : <Value v={o} lab={lab} />;
  const entries = Object.entries(o as Record<string, unknown>).filter(([, v]) => v !== undefined);
  const inline = entries.filter(([, v]) => brief(v));
  return (
    <>
      {inline.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px]">
          {inline.map(([k, v]) => (
            <span key={k} className="min-w-0 break-words">
              <span className="text-ink-3">{k}</span> <Value v={v} lab={lab} />
            </span>
          ))}
        </div>
      )}
      {entries
        .filter(([, v]) => !brief(v))
        .map(([k, v]) => (
          <div key={k} className="min-w-0 text-[12px]">
            {!folds(v) && <span className="mr-1 text-ink-3">{k}</span>}
            <Value v={v} lab={lab} name={k} />
          </div>
        ))}
    </>
  );
}
