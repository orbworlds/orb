import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { LAB_KEY } from '@/server/lab';
import { ready } from '@/server/schema';
import { blobSha, getTrace, isTraceId, traceBlob, traceEvents, traceRounds } from '@/server/traces';
import { Timeline } from '../timeline';
import { ago, CARD, duration, Fold, KINDS, num, Pre, Status, tokenLine, when } from '../ui';

// One AI build's whole trace: who asked for what, with which model, how it went, then its
// timeline — the input, every step with its tool calls and results, looks with their screenshots,
// retries, versions saved, and how it ended.

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Trace', robots: { index: false, follow: false } };

function Fact({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[13.5px] break-words text-ink">{children}</dd>
    </div>
  );
}

async function load(id: string) {
  const db = await ready();
  const trace = await getTrace(db, id);
  if (!trace) return null;
  const [events, rounds] = await Promise.all([traceEvents(db, id), trace.groupId ? traceRounds(db, trace.groupId) : Promise.resolve([])]);
  const systemSha = blobSha((events.find((e) => e.type === 'input')?.payload as { system?: unknown } | null)?.system);
  const systemBlob = systemSha ? await traceBlob(db, systemSha) : null;
  return { trace, events, rounds, system: systemBlob ? new TextDecoder().decode(systemBlob.data) : null, now: Date.now() };
}

export default async function TracePage({ params }: { params: Promise<{ key: string; id: string }> }) {
  const { key, id } = await params;
  if (key !== LAB_KEY || !isTraceId(id)) notFound();
  const found = await load(id);
  if (!found) notFound();
  const { trace, events, rounds, system, now } = found;
  const lab = `/lab/${key}/traces`;
  const m = trace.meta;
  const effort = typeof m.effort === 'string' ? m.effort : null;
  const t = trace.tokens;
  const exportHref = `${lab}/export?id=${encodeURIComponent(trace.id)}`;
  return (
    <main className="mx-auto w-full max-w-[1000px] px-4 pt-[max(28px,env(safe-area-inset-top))] pb-[max(48px,env(safe-area-inset-bottom))] sm:px-8 sm:pt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={lab} className="text-[13.5px] text-ink-2 hover:text-ink">
          ← All traces
        </Link>
        <div className="flex items-center gap-3">
          <a href={exportHref} download className="inline-flex h-8 items-center rounded-full bg-[var(--chip-bg)] px-3.5 text-[13px] text-ink shadow-[inset_0_0_0_1px_var(--ink-4)] hover:bg-[var(--chip-bg-hover)]">
            Export JSONL
          </a>
          <a href={`${exportHref}&images=1`} download className="text-[12.5px] text-ink-2 underline decoration-[var(--ink-4)] underline-offset-2 hover:text-ink">
            with screenshots
          </a>
        </div>
      </div>

      <h1 className="mt-5 font-display text-[34px] leading-none tracking-[-0.015em] text-ink sm:text-[40px]">Trace</h1>
      <div className="mt-3 flex flex-wrap items-center gap-x-2 text-[14px] text-ink-2">
        <span className="text-ink">
          <Status status={trace.status} />
        </span>
        <span>· {[KINDS[trace.kind] ?? trace.kind, trace.mode === 'ask' ? 'ask' : '', m.repair ? 'repair round' : ''].filter(Boolean).join(' · ')}</span>
        <span>· {ago(now, trace.startedAt)}</span>
        {trace.durationMs != null && <span>· took {duration(trace.durationMs)}</span>}
      </div>

      <section className={`${CARD} mt-6`}>
        <p className="text-[15px] leading-relaxed break-words whitespace-pre-wrap text-ink">{trace.prompt || <span className="text-ink-3">(no prompt)</span>}</p>
        {trace.error && <p className="mt-3 rounded-[12px] bg-[color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-[13.5px] break-words text-[var(--bad)]">{trace.error}</p>}
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-[var(--ink-5)] pt-4 sm:grid-cols-4">
          <Fact label="Started" className="col-span-2 sm:col-span-1">
            <span title={trace.startedAt}>{when(trace.startedAt)}</span>
          </Fact>
          <Fact label="Who">
            {trace.who ?? <span className="text-ink-3">no name</span>}
            {trace.device && <span className="ml-1.5 font-mono text-[11.5px] text-ink-3">device {trace.device}</span>}
          </Fact>
          <Fact label="World">
            {trace.worldId ? (
              <Link href={`/w/${encodeURIComponent(trace.worldId)}`} target="_blank" className="underline decoration-[var(--ink-4)] underline-offset-2 hover:decoration-[var(--ink-2)]">
                {trace.worldName || trace.worldId}
              </Link>
            ) : (
              <span className="text-ink-3">—</span>
            )}
          </Fact>
          <Fact label="Model">
            {trace.model ?? '—'}
            <span className="text-ink-3">
              {' '}
              · {trace.provider}
              {effort ? ` · ${effort} effort` : ''}
            </span>
          </Fact>
          <Fact label="Steps">
            {trace.steps}
            {typeof m.looks === 'number' && <span className="text-ink-3"> · {m.looks === 1 ? '1 look' : `${num(m.looks)} looks`}</span>}
            {typeof m.versions === 'number' && <span className="text-ink-3"> · {m.versions === 1 ? '1 version saved' : `${num(m.versions)} versions saved`}</span>}
          </Fact>
          <Fact label="Tokens" className="col-span-2">
            {t.in || t.out ? tokenLine(t, true) : <span className="text-ink-3">none reported</span>}
          </Fact>
          <Fact label="Took">{trace.status === 'running' ? 'still running' : duration(trace.durationMs)}</Fact>
        </dl>
        {rounds.length > 1 && (
          <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-[var(--ink-5)] pt-4">
            <span className="mr-1 text-[12.5px] text-ink-3">Rounds of this chat turn</span>
            {rounds.map((r, i) =>
              r.id === trace.id ? (
                <span key={r.id} className="rounded-full bg-ink px-3 py-1 text-[12.5px] text-paper">
                  {i + 1} · {KINDS[r.kind] ?? r.kind} · {r.status}
                </span>
              ) : (
                <Link key={r.id} href={`${lab}/${encodeURIComponent(r.id)}`} className="rounded-full bg-[var(--chip-bg)] px-3 py-1 text-[12.5px] text-ink-2 shadow-[inset_0_0_0_1px_var(--ink-5)] hover:bg-[var(--chip-bg-hover)] hover:text-ink">
                  {i + 1} · {KINDS[r.kind] ?? r.kind} · {r.status}
                </Link>
              ),
            )}
          </div>
        )}
        <Fold summary="Everything on the trace’s row">
          <Pre>{JSON.stringify({ id: trace.id, groupId: trace.groupId, user: trace.user, endedAt: trace.endedAt, meta: trace.meta }, null, 2)}</Pre>
        </Fold>
      </section>

      <h2 className="mt-10 text-[17px] font-semibold text-ink">Timeline</h2>
      <p className="mt-1 text-[13.5px] text-ink-2">
        {num(events.length)} events. Times are since the start; long texts and tool inputs fold open.
      </p>
      {events.length === 0 ? <p className={`${CARD} mt-4 text-[14px] text-ink-2`}>Nothing recorded yet.</p> : <Timeline events={events} startedAt={trace.startedAt} lab={lab} kind={trace.kind} system={system} model={trace.model} />}
    </main>
  );
}
