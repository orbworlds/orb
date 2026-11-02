'use client';
// People on Orb over the range the page shows (UTC): today hour by hour, or the last 7, 30 or 90
// days day by day, as columns, with the period just before as a quiet line to read them against,
// and the count so far beside the period before's by the same time. Hovering or focusing a column
// shows its numbers; the table under the chart has them all.

import { useState } from 'react';
import type { AnalyticsTrend, Range } from '@/server/analytics';
import { CARD } from '../pulse/ui';

const pad = (h: number) => String(h).padStart(2, '0');
const date = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
const DAY = 86_400_000;

/** Gridlines in whole people, at most four steps, with room above the tallest column. */
function ticks(max: number): number[] {
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000].find((s) => Math.ceil((max * 1.1) / s) <= 4) ?? 10_000;
  return Array.from({ length: Math.max(1, Math.ceil((max * 1.1) / step)) + 1 }, (_, i) => i * step);
}

export function Trend({ trend, range }: { trend: AnalyticsTrend; range: Range }) {
  const [at, setAt] = useState<number | null>(null);
  const { points, now } = trend;
  const hourly = range === 1;
  const n = points.length;
  const x = (i: number) => ((i + 0.5) / n) * 100;
  const grid = ticks(Math.max(...points.map((p) => Math.max(p.people ?? 0, p.before))));
  const top = grid[grid.length - 1];
  const y = (v: number) => (v / top) * 100;
  const line = points.map((p, i) => `${x(i)},${100 - y(p.before)}`).join(' ');

  // How a column, its twin in the period before, and the axis read.
  const name = (i: number) => {
    if (!hourly) return date(points[i].at, { weekday: 'short', month: 'short', day: 'numeric' });
    const h = new Date(points[i].at).getUTCHours();
    return `${pad(h)}:00–${i === now ? 'now' : `${pad((h + 1) % 24)}:00`}`;
  };
  const twin = (i: number) => (hourly ? 'yesterday' : `on ${date(new Date(Date.parse(points[i].at) - range * DAY).toISOString(), { month: 'short', day: 'numeric' })}`);
  const tick = (i: number) => (hourly ? `${pad(i)}:00` : date(points[i].at, range === 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' }));
  // Axis labels: every 3 hours (6 on a phone); every day of a week; for longer ranges every 5th or
  // 15th day counted back from today (10th or 30th on a phone).
  const every = hourly ? 3 : range === 7 ? 1 : range === 30 ? 5 : 15;
  const labels = points.map((_, i) => i).filter((i) => (hourly ? i : n - 1 - i) % every === 0);
  const wide = (i: number) => ((hourly ? i : n - 1 - i) % (every * 2) === 0 ? '' : 'hidden sm:inline');

  const period = hourly ? 'today' : `in ${range} days`;
  const was = hourly ? 'yesterday by this time' : `the ${range} days before`;
  const change = trend.beforeSoFar ? Math.round(((trend.people - trend.beforeSoFar) / trend.beforeSoFar) * 100) : null;
  const versus = change === null ? `None ${was}` : change === 0 ? `As many as ${was} (${trend.beforeSoFar})` : `${change > 0 ? '▲' : '▼'} ${Math.abs(change)}% on ${was} (${trend.beforeSoFar})`;
  const shown = at === null ? null : points[at];
  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <div className="text-[12.5px] text-ink-2">People {period}</div>
          <div className="mt-1 text-[40px] leading-none font-semibold tracking-[-0.02em] text-ink">{trend.people}</div>
          <div className="mt-2 text-[12.5px] text-ink-3">
            {versus}
            {hourly && ` · ${trend.before} all of yesterday`}
          </div>
        </div>
        <div className="flex items-center gap-4 text-[12.5px] text-ink-2" aria-hidden>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[3px] bg-[var(--iris-1)]" />
            {hourly ? 'Today' : `Last ${range} days`}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full bg-[var(--ink-3)]" />
            {hourly ? 'Yesterday' : `The ${range} before`}
          </span>
        </div>
      </div>

      <div className="relative mt-6 ml-7 h-[168px]" role="group" aria-label={`People on Orb ${hourly ? 'in each hour of today (UTC), beside yesterday' : `each day of the last ${range} days (UTC), beside the ${range} days before`}`}>
        {grid.map((t) => (
          <div key={t} className="absolute inset-x-0 border-t border-[var(--ink-5)]" style={{ bottom: `${y(t)}%` }}>
            <span className="absolute right-full mr-2 -translate-y-1/2 text-[11.5px] text-ink-3 tabular-nums">{t}</span>
          </div>
        ))}
        <div className="absolute inset-0 flex">
          {points.map((p, i) => (
            <div
              key={p.at}
              tabIndex={0}
              aria-label={`${name(i)}${hourly ? ' UTC' : ''}: ${p.people === null ? 'still to come' : `${p.people} ${p.people === 1 ? 'person' : 'people'}${i === now ? ' so far' : ''}`}, ${twin(i)} ${p.before}`}
              onPointerEnter={() => setAt(i)}
              onPointerLeave={() => setAt((a) => (a === i ? null : a))}
              onFocus={() => setAt(i)}
              onBlur={() => setAt((a) => (a === i ? null : a))}
              className={`relative flex h-full flex-1 items-end justify-center rounded-[4px] outline-none ${n > 45 ? 'px-[0.5px]' : 'px-px'} ${at === i ? 'bg-[var(--hover)]' : ''}`}
            >
              {!!p.people && (
                <div className={`w-full max-w-6 rounded-t-[4px] bg-[var(--iris-1)] ${i === now ? 'opacity-55' : ''} ${at === i ? 'brightness-110' : ''}`} style={{ height: `${y(p.people)}%` }} />
              )}
            </div>
          ))}
        </div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          <polyline points={line} fill="none" stroke="var(--paper)" strokeWidth="5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
          <polyline points={line} fill="none" stroke="var(--ink-3)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        {!!points[now]?.people && ( // the one going on now, so far: on its column, over the line
          <span
            className="pointer-events-none absolute -translate-x-1/2 rounded-full bg-[var(--glass-bg-strong)] px-1 text-[11.5px] leading-4 text-ink-2 tabular-nums"
            style={{ left: `${x(now)}%`, bottom: `calc(${y(points[now].people ?? 0)}% + 3px)` }}
          >
            {points[now].people}
          </span>
        )}
        {shown && at !== null && (
          <div
            className="pointer-events-none absolute top-1 z-10 min-w-[128px] rounded-[12px] bg-[var(--glass-bg-strong)] px-3 py-2 text-[12.5px] whitespace-nowrap shadow-[0_8px_24px_-8px_rgba(16,16,40,.35),inset_0_0_0_1px_var(--glass-hairline)] backdrop-blur-xl"
            style={at < n / 2 ? { left: `calc(${x(at)}% + 14px)` } : { right: `calc(${100 - x(at)}% + 14px)` }}
          >
            <div className="text-ink-2">
              {name(at)}
              {hourly && ' UTC'}
            </div>
            {shown.people !== null && (
              <div className="mt-1 flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-[3px] bg-[var(--iris-1)]" />
                <span className="font-semibold text-ink tabular-nums">{shown.people}</span>
                <span className="text-ink-2">{at === now ? 'so far' : hourly ? 'today' : shown.people === 1 ? 'person' : 'people'}</span>
              </div>
            )}
            <div className="mt-0.5 flex items-center gap-2">
              <span className="h-0.5 w-2.5 rounded-full bg-[var(--ink-3)]" />
              <span className="font-semibold text-ink tabular-nums">{shown.before}</span>
              <span className="text-ink-2">{twin(at)}</span>
            </div>
          </div>
        )}
      </div>
      <div className="relative mt-2 ml-7 h-4 text-[11.5px] text-ink-3 tabular-nums" aria-hidden>
        {labels.map((i) => (
          <span key={i} className={`absolute -translate-x-1/2 whitespace-nowrap ${wide(i)}`} style={{ left: `${x(i)}%` }}>
            {tick(i)}
          </span>
        ))}
      </div>

      <details className="mt-4 text-[13px]">
        <summary className="cursor-pointer text-ink-2">{hourly ? 'Hour by hour' : 'Each day'}</summary>
        <table className="mt-2 w-full max-w-[460px] text-left tabular-nums">
          <thead className="text-[12px] text-ink-2">
            <tr>
              <th className="py-1 font-medium">{hourly ? 'Hour (UTC)' : 'Day'}</th>
              <th className="py-1 text-right font-medium">People</th>
              <th className="py-1 text-right font-medium">{hourly ? 'Yesterday' : `${range} days before`}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr key={p.at} className="border-t border-[var(--ink-5)]">
                <td className="py-1 text-ink-2">{name(i)}</td>
                <td className="py-1 text-right text-ink">{p.people ?? '—'}</td>
                <td className="py-1 text-right text-ink">{p.before}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
