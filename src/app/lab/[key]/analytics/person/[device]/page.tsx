import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { person, type PersonDetail, type PersonEvent, TIMELINE, type WorldRef } from '@/server/analytics';
import type { PropValue } from '@/server/events';
import { LAB_KEY } from '@/server/lab';
import { ready } from '@/server/schema';
import { ago, CARD, clock, type Column, dayLabel, duration, LINK, MAIN, personName, Section, seenOn, Stat, Table, TITLE } from '../../../pulse/ui';

// One person on the analytics page (by their device's public id): who they are, the worlds they
// own, and what they did, visit by visit — the latest visit first, each read top to bottom.

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Person' };

const WORLDS: Column<PersonDetail['worlds'][number]>[] = [
  {
    label: 'World',
    cell: (w) => (
      <a href={w.href} className={`${LINK} font-medium`}>
        {w.name}
      </a>
    ),
  },
  { label: 'Made', cell: (w) => `${dayLabel(w.createdAt)}${w.remix ? ' · remix' : ''}` },
  { label: 'Versions', num: true, cell: (w) => w.version },
  { label: 'Plays', num: true, cell: (w) => w.plays },
  { label: 'Likes', num: true, cell: (w) => w.likes },
];

const Muted = ({ children }: { children: ReactNode }) => <span className="text-ink-3">{children}</span>;
const World = ({ w }: { w: WorldRef | null }) =>
  w ? (
    <a href={w.href} className={LINK}>
      {w.name ?? 'a deleted world'}
    </a>
  ) : (
    <>a world</>
  );
const text = (v: PropValue | undefined) => (v === undefined || v === null ? '' : String(v));
const quote = (v: PropValue | undefined) => `“${text(v)}”`;
const PROMPTED: Record<string, string> = { hero: 'home screen', chat: 'chat', suggestion: 'a suggestion' };

function site(url: string | null): string {
  try {
    return url ? new URL(url).host.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

function describe(e: PersonEvent): ReactNode {
  const p = e.props ?? {};
  const w = <World w={e.world} />;
  const inWorld = e.world && <> in {w}</>;
  switch (e.name) {
    case 'page_view': {
      const from = [site(e.referrer), p.utm_source && `utm_source ${text(p.utm_source)}`].filter(Boolean).join(', ');
      return (
        <>
          {p.landing ? 'Came to' : 'Went to'} <span className="font-mono text-[12.5px]">{e.path ?? '?'}</span>
          {from && <Muted> from {from}</Muted>}
        </>
      );
    }
    case 'world_open':
      return (
        <>
          Opened {w} <Muted>({p.source === 'home' ? `start screen${p.tab === 'mine' ? ', theirs' : ''}` : text(p.source).replace(/_/g, ' ') || 'other'})</Muted>
        </>
      );
    case 'world_leave':
      return (
        <>
          {duration(Number(p.seconds) || 0)} in {w}
          {p.why === 'hidden' && <Muted> · then the tab went out of sight</Muted>}
        </>
      );
    case 'prompt_send':
      return (
        <>
          {p.is_new_world ? 'Asked for a new world:' : 'Asked'} {quote(p.text)}
          <Muted>
            {' · '}
            {[PROMPTED[text(p.where)] ?? text(p.where), p.provider === 'free' ? 'free builder' : text(p.provider), text(p.model), p.mode === 'ask' ? 'a question' : ''].filter(Boolean).join(' · ')}
          </Muted>
        </>
      );
    case 'build_done': {
      const what = p.status === 'error' ? 'Build failed' : p.status === 'stopped' ? 'Stopped a build' : p.saved === false ? 'Finished without changes' : 'Build finished';
      const steps = typeof p.steps === 'number' && p.steps > 0 ? `${p.steps} ${p.steps === 1 ? 'step' : 'steps'}` : '';
      const how = [typeof p.seconds === 'number' ? duration(p.seconds) : '', steps, p.repair ? 'a repair' : '', p.background ? 'in the background' : '', p.error ? quote(p.error) : ''].filter(Boolean).join(' · ');
      return (
        <>
          {what}
          {inWorld}
          {how && <Muted> · {how}</Muted>}
        </>
      );
    }
    case 'build_undo':
      return <>Undid a build{inWorld}</>;
    case 'remix':
      return (
        <>
          Remixed <World w={e.from} /> into {w} <Muted>({p.how === 'build' ? 'by building on it' : 'with Remix'})</Muted>
        </>
      );
    case 'like':
      return (
        <>
          {p.liked === false ? 'Unliked' : 'Liked'} {w}
        </>
      );
    case 'history_restore':
      return (
        <>
          Brought back version {text(p.version)} of {w}
        </>
      );
    // No longer tracked: these two can go once the 180-day retention has aged the rows out (mid-April 2027).
    case 'code_open':
      return <>Opened the code{inWorld}</>;
    case 'code_save':
      return <>Saved code{inWorld}</>;
    case 'explore_open':
      return 'Opened Explore';
    case 'explore_filter':
      return <>Explore: {text(p.filter)}</>;
    case 'explore_search':
      return (
        <>
          Searched Explore for {quote(p.q)} <Muted>· {p.results === null || p.results === undefined ? 'no answer' : `${text(p.results)} found`}</Muted>
        </>
      );
    case 'share_open':
      return <>Opened sharing{inWorld}</>;
    case 'share_copy':
      return (
        <>
          {p.how === 'native' ? 'Shared' : 'Copied the link to'} {w}
        </>
      );
    case 'world_import':
      return (
        <>
          Imported {w} <Muted>({text(p.files)} files)</Muted>
        </>
      );
    case 'sign_up':
      return 'Made an account';
    case 'sign_in':
      return 'Signed in';
    case 'sign_out':
      return 'Signed out';
    case 'key_added':
      return <>Added their own {text(p.provider)} key</>;
    case 'template_pick':
      return <>Picked the {text(p.template)} template</>;
    case 'home_tab':
      return <>On the start screen, switched to {p.tab === 'mine' ? 'their own worlds' : 'popular worlds'}</>;
    case 'error_toast':
      return <>Saw an error: {quote(p.text)}</>;
    default: {
      const rest = Object.entries(p)
        .map(([k, v]) => `${k} ${text(v)}`)
        .join(' · ');
      return (
        <>
          <span className="font-mono text-[12.5px]">{e.name}</span>
          {inWorld}
          {rest && <Muted> · {rest}</Muted>}
        </>
      );
    }
  }
}

/** The timeline (newest first) cut into visits, each in the order it happened. */
function visits(timeline: PersonEvent[]): PersonEvent[][] {
  const out: PersonEvent[][] = [];
  for (const e of timeline) {
    const last = out[out.length - 1];
    if (last && last[0].session === e.session) last.push(e);
    else out.push([e]);
  }
  return out.map((v) => v.reverse());
}

function Visit({ events }: { events: PersonEvent[] }) {
  const first = events[0];
  const last = events[events.length - 1];
  const length = (Date.parse(last.at) - Date.parse(first.at)) / 1000;
  return (
    <li className={CARD}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] text-ink-2">
        <span className="font-medium text-ink">{dayLabel(first.at)}</span>
        <span>
          {clock(first.at)}–{clock(last.at)} · {duration(length)} · {seenOn(first.mobile, first.country)}
        </span>
      </div>
      <ol className="mt-2 flex flex-col">
        {events.map((e) => (
          <li key={e.id} className="flex gap-3 border-t border-[var(--ink-5)] py-1.5 text-[14px] first:border-t-0" title={e.props ? JSON.stringify(e.props) : undefined}>
            <span className="w-11 shrink-0 text-[12.5px] leading-[21px] text-ink-3 tabular-nums">{clock(e.at)}</span>
            <span className="min-w-0 break-words text-ink">{describe(e)}</span>
          </li>
        ))}
      </ol>
    </li>
  );
}

export default async function PersonPage({ params }: { params: Promise<{ key: string; device: string }> }) {
  const { key, device } = await params;
  if (key !== LAB_KEY) notFound();
  const p = await person(await ready(), device);
  if (!p) notFound();
  return (
    <main className={MAIN}>
      <Link href={`/lab/${key}/analytics`} className="text-[13.5px] text-ink-2 hover:text-ink">
        ← Analytics
      </Link>
      <h1 className={`${TITLE} mt-4`}>{personName(p)}</h1>
      <p className="mt-3 text-[14.5px] text-ink-2">
        {[p.signedIn ? 'Has an account' : 'No account', seenOn(p.mobile, p.country), `first came ${ago(p.now, p.firstAt)}`, `last seen ${ago(p.now, p.lastAt)}`].join(' · ')}
        <span className="ml-2 font-mono text-[12.5px] text-ink-3" title="Their device’s public id (the You tab shows the first 8)">
          {p.id}
        </span>
      </p>

      <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Visits" value={p.visits} />
        <Stat label="Prompts" value={p.prompts} />
        <Stat label="Builds" value={p.builds} />
        <Stat label="Worlds" value={p.worlds.length} />
      </div>

      {p.worlds.length > 0 && (
        <Section title="Their worlds">
          <Table rows={p.worlds} columns={WORLDS} rowKey={(w) => w.id} minWidth={520} />
        </Section>
      )}

      <Section title="What they did" about={`${p.events > TIMELINE ? `The latest ${TIMELINE} of their ${p.events} events` : `All ${p.events} of their events`}: the latest visit first (UTC).`}>
        <ol className="flex flex-col gap-3">
          {visits(p.timeline).map((v) => (
            <Visit key={v[0].id} events={v} />
          ))}
        </ol>
      </Section>
    </main>
  );
}
