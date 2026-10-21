// The look the lab's pages share (Pulse, Analytics and a person's timeline): glass cards, plain
// tables, stat tiles and bars, and how numbers, times (UTC) and countries read.

import type { CSSProperties, ReactNode } from 'react';

export const MAIN = 'mx-auto w-full max-w-[1100px] px-4 pt-[max(28px,env(safe-area-inset-top))] pb-[max(48px,env(safe-area-inset-bottom))] sm:px-8 sm:pt-10';
export const TITLE = 'font-display text-[36px] leading-none text-ink sm:text-[42px]';
export const CARD = 'rounded-[18px] bg-[var(--glass-bg-strong)] p-5 shadow-[0_1px_2px_rgba(16,16,40,.05),0_8px_24px_-12px_rgba(16,16,40,.22),inset_0_0_0_1px_var(--glass-hairline)]';
export const LINK = 'text-ink underline decoration-[var(--ink-4)] underline-offset-[3px] hover:decoration-[var(--ink-2)]';

export function ago(now: number, iso: string): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function duration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = s / 3600;
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
}

/** "Fri, Oct 9" for a UTC day (YYYY-MM-DD) or time. */
export function dayLabel(dayOrIso: string): string {
  const d = new Date(dayOrIso.length === 10 ? `${dayOrIso}T00:00:00Z` : dayOrIso);
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}

/** "16:02" (UTC). */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
}

const regions = new Intl.DisplayNames(['en'], { type: 'region' });
export function countryName(code: string | null): string {
  if (!code) return 'Unknown';
  try {
    return regions.of(code) ?? code;
  } catch {
    return code;
  }
}

const deviceLabel = (mobile: boolean | null) => (mobile === null ? 'Unknown device' : mobile ? 'Phone' : 'Computer');
/** "Phone · Germany" (the country only when known). */
export const seenOn = (mobile: boolean | null, country: string | null) => (country ? `${deviceLabel(mobile)} · ${countryName(country)}` : deviceLabel(mobile));
export const personName = (p: { name: string | null; id: string }) => p.name ?? `Visitor ${p.id.slice(0, 8)}`;
export const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');

export function Section({ title, about, children }: { title: string; about?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-[17px] font-semibold text-ink">{title}</h2>
      {about && <p className="mt-1 text-[13.5px] text-ink-2">{about}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className={CARD}>
      <div className="text-[12.5px] text-ink-2">{label}</div>
      <div className="mt-1 text-[28px] leading-none font-semibold tracking-[-0.01em] text-ink">{value}</div>
      {sub && <div className="mt-2 text-[12.5px] text-ink-3">{sub}</div>}
    </div>
  );
}

export interface Column<T> {
  label: string;
  cell: (row: T) => ReactNode;
  /** Numbers: right-aligned. */
  num?: boolean;
}

export function Table<T>({ rows, columns, rowKey, minWidth = 620, empty = 'Nothing so far.', footer }: { rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string; minWidth?: number; empty?: string; footer?: ReactNode }) {
  if (rows.length === 0) return <p className={`${CARD} text-[14px] text-ink-2`}>{empty}</p>;
  const style: CSSProperties = { minWidth };
  return (
    <div className={`${CARD} overflow-x-auto`}>
      <table className="w-full text-left text-[14px] tabular-nums" style={style}>
        <thead className="text-[12.5px] text-ink-2">
          <tr>
            {columns.map((c) => (
              <th key={c.label} className={`px-3 pb-2 font-medium first:pl-0 last:pr-0 ${c.num ? 'text-right' : ''}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className="border-t border-[var(--ink-5)]">
              {columns.map((c) => (
                <td key={c.label} className={`px-3 py-2 first:pl-0 last:pr-0 ${c.num ? 'text-right text-ink' : 'text-ink-2'}`}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {footer && <p className="mt-3 text-[12.5px] text-ink-3">{footer}</p>}
    </div>
  );
}

/** A labelled bar: `value` out of `of` (the longest bar in its list). */
export function Bar({ label, value, of, note }: { label: ReactNode; value: number; of: number; note?: ReactNode }) {
  const width = of > 0 ? Math.max(value > 0 ? 2 : 0, (value / of) * 100) : 0;
  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[14px]">
        <span className="min-w-0 truncate text-ink">{label}</span>
        <span className="shrink-0 text-ink tabular-nums">
          {value}
          {note && <span className="ml-1.5 text-[12.5px] text-ink-3">{note}</span>}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-[var(--ink-5)]">
        <div className="h-full rounded-full bg-[linear-gradient(90deg,var(--iris-1),var(--iris-2))]" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}
