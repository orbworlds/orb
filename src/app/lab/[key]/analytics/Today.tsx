'use client';
// Today on Orb, hour by hour (UTC): the people in each hour as columns, yesterday's as a quiet line
// to read them against, and today's count so far beside yesterday's by the same time. Hovering or
// focusing an hour shows its numbers; the table under the chart has them all.

import { useState } from 'react';
import type { AnalyticsToday } from '@/server/analytics';
import { CARD } from '../pulse/ui';

const pad = (h: number) => String(h).padStart(2, '0');
const span = (h: number, now: number) => `${pad(h)}:00–${h === now ? 'now' : `${pad((h + 1) % 24)}:00`}`;
const x = (i: number) => ((i + 0.5) / 24) * 100;

/** Gridlines in whole people, at most four steps, with room above the tallest hour. */
function ticks(max: number): number[] {
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000].find((s) => Math.ceil((max * 1.1) / s) <= 4) ?? 10_000;
  return Array.from({ length: Math.max(1, Math.ceil((max * 1.1) / step)) + 1 }, (_, i) => i * step);
}

/** Today so far against yesterday by the same time of day, in words. */
function versus(today: number, before: number): string {
  if (!before) return 'None yesterday by this time';
  const change = Math.round(((today - before) / before) * 100);
  if (!change) return `As many as yesterday by this time (${before})`;
  return `${change > 0 ? '▲' : '▼'} ${Math.abs(change)}% on yesterday by this time (${before})`;
}

export function Today({ today }: { today: AnalyticsToday }) {
  const [at, setAt] = useState<number | null>(null);
  const { hours, hour } = today;
  const grid = ticks(Math.max(...hours.map((h) => Math.max(h.today ?? 0, h.yesterday))));
  const top = grid[grid.length - 1];
  const y = (v: number) => (v / top) * 100;
  const line = hours.map((h, i) => `${x(i)},${100 - y(h.yesterday)}`).join(' ');
  const shown = at === null ? null : hours[at];
  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <div className="text-[12.5px] text-ink-2">People today</div>
          <div className="mt-1 text-[40px] leading-none font-semibold tracking-[-0.02em] text-ink">{today.people}</div>
          <div className="mt-2 text-[12.5px] text-ink-3">
            {versus(today.people, today.yesterdaySoFar)} · {today.yesterday} all of yesterday
          </div>
        </div>
        <div className="flex items-center gap-4 text-[12.5px] text-ink-2" aria-hidden>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[3px] bg-[var(--iris-1)]" />
            Today
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full bg-[var(--ink-3)]" />
            Yesterday
          </span>
        </div>
      </div>

      <div className="relative mt-6 ml-7 h-[168px]" role="group" aria-label="People on Orb in each hour of today (UTC), beside yesterday">
        {grid.map((t) => (
          <div key={t} className="absolute inset-x-0 border-t border-[var(--ink-5)]" style={{ bottom: `${y(t)}%` }}>
            <span className="absolute right-full mr-2 -translate-y-1/2 text-[11.5px] text-ink-3 tabular-nums">{t}</span>
          </div>
        ))}
        <div className="absolute inset-0 flex">
          {hours.map((h, i) => (
            <div
              key={i}
              tabIndex={0}
              aria-label={`${span(i, hour)} UTC: ${h.today === null ? 'still to come' : `${h.today} ${h.today === 1 ? 'person' : 'people'}${i === hour ? ' so far' : ''}`}, yesterday ${h.yesterday}`}
              onPointerEnter={() => setAt(i)}
              onPointerLeave={() => setAt((a) => (a === i ? null : a))}
              onFocus={() => setAt(i)}
              onBlur={() => setAt((a) => (a === i ? null : a))}
              className={`relative flex h-full flex-1 items-end justify-center rounded-[4px] px-px outline-none ${at === i ? 'bg-[var(--hover)]' : ''}`}
            >
              {!!h.today && (
                <div className={`w-full max-w-6 rounded-t-[4px] bg-[var(--iris-1)] ${i === hour ? 'opacity-55' : ''} ${at === i ? 'brightness-110' : ''}`} style={{ height: `${y(h.today)}%` }} />
              )}
            </div>
          ))}
        </div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          <polyline points={line} fill="none" stroke="var(--paper)" strokeWidth="5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
          <polyline points={line} fill="none" stroke="var(--ink-3)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        {!!hours[hour]?.today && ( // this hour so far, on its column, over yesterday's line
          <span
            className="pointer-events-none absolute -translate-x-1/2 rounded-full bg-[var(--glass-bg-strong)] px-1 text-[11.5px] leading-4 text-ink-2 tabular-nums"
            style={{ left: `${x(hour)}%`, bottom: `calc(${y(hours[hour].today ?? 0)}% + 3px)` }}
          >
            {hours[hour].today}
          </span>
        )}
        {shown && at !== null && (
          <div
            className="pointer-events-none absolute top-1 z-10 min-w-[128px] rounded-[12px] bg-[var(--glass-bg-strong)] px-3 py-2 text-[12.5px] shadow-[0_8px_24px_-8px_rgba(16,16,40,.35),inset_0_0_0_1px_var(--glass-hairline)] backdrop-blur-xl"
            style={at < 12 ? { left: `calc(${x(at)}% + 14px)` } : { right: `calc(${100 - x(at)}% + 14px)` }}
          >
            <div className="text-ink-2">{span(at, hour)} UTC</div>
            {shown.today !== null && (
              <div className="mt-1 flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-[3px] bg-[var(--iris-1)]" />
                <span className="font-semibold text-ink tabular-nums">{shown.today}</span>
                <span className="text-ink-2">{at === hour ? 'so far' : 'today'}</span>
              </div>
            )}
            <div className="mt-0.5 flex items-center gap-2">
              <span className="h-0.5 w-2.5 rounded-full bg-[var(--ink-3)]" />
              <span className="font-semibold text-ink tabular-nums">{shown.yesterday}</span>
              <span className="text-ink-2">yesterday</span>
            </div>
          </div>
        )}
      </div>
      <div className="relative mt-2 ml-7 h-4 text-[11.5px] text-ink-3 tabular-nums" aria-hidden>
        {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
          <span key={h} className={`absolute -translate-x-1/2 ${h % 6 ? 'hidden sm:inline' : ''}`} style={{ left: `${x(h)}%` }}>
            {pad(h)}:00
          </span>
        ))}
      </div>

      <details className="mt-4 text-[13px]">
        <summary className="cursor-pointer text-ink-2">Hour by hour</summary>
        <table className="mt-2 w-full max-w-[420px] text-left tabular-nums">
          <thead className="text-[12px] text-ink-2">
            <tr>
              <th className="py-1 font-medium">Hour (UTC)</th>
              <th className="py-1 text-right font-medium">Today</th>
              <th className="py-1 text-right font-medium">Yesterday</th>
            </tr>
          </thead>
          <tbody>
            {hours.map((h, i) => (
              <tr key={i} className="border-t border-[var(--ink-5)]">
                <td className="py-1 text-ink-2">{span(i, hour)}</td>
                <td className="py-1 text-right text-ink">{h.today ?? '—'}</td>
                <td className="py-1 text-right text-ink">{h.yesterday}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
