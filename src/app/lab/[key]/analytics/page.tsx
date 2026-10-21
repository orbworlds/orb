import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { analytics, type AnalyticsDay, type AnalyticsPerson, type AnalyticsWorld, type Range } from '@/server/analytics';
import { LAB_KEY } from '@/server/lab';
import { ready } from '@/server/schema';
import { ago, Bar, CARD, type Column, countryName, dayLabel, duration, LINK, MAIN, percent, personName, Section, seenOn, Stat, Table, TITLE } from '../pulse/ui';

// Who comes to Orb and what they do there, from Orb's own events (src/server/analytics.ts): the
// last 7 days, or 30 with ?days=30, in UTC days. Everyone links to their own timeline (./person).

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Analytics' };

const DAYS: Column<AnalyticsDay>[] = [
  { label: 'Day', cell: (d) => dayLabel(d.day) },
  { label: 'Visitors', num: true, cell: (d) => d.visitors },
  { label: 'New', num: true, cell: (d) => d.newVisitors },
  { label: 'Visits', num: true, cell: (d) => d.visits },
  { label: 'Page views', num: true, cell: (d) => d.pageViews },
  { label: 'World opens', num: true, cell: (d) => d.opens },
  { label: 'Prompts', num: true, cell: (d) => d.prompts },
  { label: 'Builds', num: true, cell: (d) => d.builds },
  { label: 'Time in worlds', num: true, cell: (d) => (d.playSeconds ? duration(d.playSeconds) : 0) },
];

const WORLDS: Column<AnalyticsWorld>[] = [
  {
    label: 'World',
    cell: (w) => (
      <a href={w.href} className={`${LINK} font-medium`}>
        {w.name ?? 'Deleted world'}
      </a>
    ),
  },
  { label: 'By', cell: (w) => w.author ?? '—' },
  { label: 'Opens', num: true, cell: (w) => w.opens },
  { label: 'People', num: true, cell: (w) => w.people },
  { label: 'Time in it', num: true, cell: (w) => (w.playSeconds ? duration(w.playSeconds) : 0) },
  { label: 'Prompts', num: true, cell: (w) => w.prompts },
  { label: 'Likes', num: true, cell: (w) => w.likes },
  { label: 'Opened from', cell: (w) => <span className="text-[13px]">{w.sources.map(([s, n]) => `${s.replace(/_/g, ' ')} ${n}`).join(' · ') || '—'}</span> },
];

const people = (key: string, now: number): Column<AnalyticsPerson>[] => [
  {
    label: 'Person',
    cell: (p) => (
      <span className="flex items-center gap-1.5">
        <Link href={`/lab/${key}/analytics/person/${p.id}`} className={`${LINK} font-medium`}>
          {personName(p)}
        </Link>
        {p.signedIn && <span className="rounded-full bg-[var(--ink-5)] px-1.5 py-px text-[11px] text-ink-2">account</span>}
      </span>
    ),
  },
  { label: 'First came', cell: (p) => dayLabel(p.firstAt) },
  { label: 'Last seen', cell: (p) => ago(now, p.lastAt) },
  { label: 'Visits', num: true, cell: (p) => p.visits },
  { label: 'Prompts', num: true, cell: (p) => p.prompts },
  { label: 'Builds', num: true, cell: (p) => p.builds },
  { label: 'Worlds', num: true, cell: (p) => p.worlds },
  { label: 'On', cell: (p) => seenOn(p.mobile, p.country) },
];

function RangeSwitch({ base, range }: { base: string; range: Range }) {
  const pill = (r: Range, label: string) => (
    <Link
      href={r === 7 ? base : `${base}?days=${r}`}
      aria-current={r === range ? 'page' : undefined}
      className={`rounded-full px-3 py-1 text-[13px] ${r === range ? 'bg-ink text-paper' : 'text-ink-2 hover:bg-[var(--hover)] hover:text-ink'}`}
    >
      {label}
    </Link>
  );
  return (
    <span className="inline-flex rounded-full bg-[var(--ink-5)] p-0.5">
      {pill(7, '7 days')}
      {pill(30, '30 days')}
    </span>
  );
}

export default async function AnalyticsPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<{ days?: string | string[] }> }) {
  const { key } = await params;
  if (key !== LAB_KEY) notFound();
  const range: Range = (await searchParams).days === '30' ? 30 : 7;
  const a = await analytics(await ready(), range);
  const t = a.totals;
  const f = a.funnel;
  const opens = a.days.reduce((s, d) => s + d.opens, 0);
  const steps: Array<[string, number]> = [
    ['Came for the first time', f.came],
    ['Opened a world', f.opened],
    ['Sent a prompt', f.prompted],
    ['Finished a build', f.built],
    ['Came back another day', f.cameBack],
  ];
  const most = (xs: number[]) => Math.max(0, ...xs);
  const deviceTotal = a.devices.phone + a.devices.computer + a.devices.unknown;
  return (
    <main className={MAIN}>
      <h1 className={TITLE}>Analytics</h1>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[14.5px] text-ink-2">
        <span>The last {range} days (UTC), from Orb’s own events.</span>
        <RangeSwitch base={`/lab/${key}/analytics`} range={range} />
        <Link href={`/lab/${key}/pulse`} className={LINK}>
          Pulse
        </Link>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Visitors" value={t.visitors} sub={`${t.newVisitors} new · ${t.visitors - t.newVisitors} returning`} />
        <Stat label="Visits" value={t.visits} sub={t.visits ? `${duration(t.medianVisitSeconds)} median · ${duration(t.avgVisitSeconds)} average` : 'None yet'} />
        <Stat label="Page views" value={t.pageViews} sub={t.visits ? `${(t.pageViews / t.visits).toFixed(1)} a visit` : 'None yet'} />
        <Stat label="Time in worlds" value={duration(t.playSeconds)} sub={`${opens} world opens`} />
      </div>

      <Section title="Day by day">
        <Table rows={a.days} columns={DAYS} rowKey={(d) => d.day} minWidth={760} footer={`${t.events} events in all. New: first time on Orb. A visit is one tab, until it’s been out of sight for 30 minutes.`} />
      </Section>

      <Section title="New people, step by step" about={`Everyone who first came in these ${range} days, and how many got to each step (and the ones before it).`}>
        <div className={CARD}>
          {steps.map(([label, n], i) => (
            <Bar key={label} label={label} value={n} of={f.came} note={i > 0 ? percent(n, f.came) : undefined} />
          ))}
        </div>
      </Section>

      <Section title="Worlds" about="Most opened first. People: everyone who was in it (making a world doesn’t count as opening it). Time in it counts while it’s on screen.">
        <Table rows={a.worlds} columns={WORLDS} rowKey={(w) => w.id} minWidth={820} />
      </Section>

      <div className="mt-10 grid gap-3 md:grid-cols-3">
        <div className={CARD}>
          <h2 className="text-[15px] font-semibold text-ink">Where visits come from</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-3">The site that linked, or utm_source</p>
          <div className="mt-3">
            {a.sources.length === 0 && <p className="text-[14px] text-ink-2">Nothing so far.</p>}
            {a.sources.map((s) => (
              <Bar key={s.source} label={s.source} value={s.visits} of={most(a.sources.map((x) => x.visits))} note={`${s.people} ${s.people === 1 ? 'person' : 'people'}`} />
            ))}
          </div>
        </div>
        <div className={CARD}>
          <h2 className="text-[15px] font-semibold text-ink">Phones and computers</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-3">People</p>
          <div className="mt-3">
            <Bar label="Phone" value={a.devices.phone} of={deviceTotal} note={percent(a.devices.phone, deviceTotal)} />
            <Bar label="Computer" value={a.devices.computer} of={deviceTotal} note={percent(a.devices.computer, deviceTotal)} />
            {a.devices.unknown > 0 && <Bar label="Unknown" value={a.devices.unknown} of={deviceTotal} note={percent(a.devices.unknown, deviceTotal)} />}
          </div>
        </div>
        <div className={CARD}>
          <h2 className="text-[15px] font-semibold text-ink">Countries</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-3">People</p>
          <div className="mt-3">
            {a.countries.length === 0 && <p className="text-[14px] text-ink-2">Nothing so far.</p>}
            {a.countries.map((c) => (
              <Bar key={c.country ?? '-'} label={countryName(c.country)} value={c.people} of={most(a.countries.map((x) => x.people))} />
            ))}
          </div>
        </div>
      </div>

      <Section title="Events" about="What was tracked, most first (the list is in SPEC.md).">
        <Table
          rows={a.events}
          columns={[
            { label: 'Event', cell: (e) => <span className="font-mono text-[13px] text-ink">{e.name}</span> },
            { label: 'Times', num: true, cell: (e) => e.count },
            { label: 'People', num: true, cell: (e) => e.people },
          ]}
          rowKey={(e) => e.name}
          minWidth={360}
        />
      </Section>

      <Section title="People" about={`Everyone seen in these ${range} days, latest first. A person is a browser on a device, named after their account or the name they gave Orb.`}>
        <Table rows={a.people} columns={people(key, a.now)} rowKey={(p) => p.id} minWidth={860} />
      </Section>
    </main>
  );
}
