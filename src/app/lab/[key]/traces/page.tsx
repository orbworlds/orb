import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LAB_KEY } from '@/server/lab';
import { ready } from '@/server/schema';
import { listTraces, traceProviders, traceTotals, type TraceFilter, type TraceKind } from '@/server/traces';
import { ago, bytes, CARD, duration, KINDS, num, short, Status, tokenLine, when } from './ui';

// Every AI build's trace (src/server/traces.ts), newest first: who asked for what, with which
// model, how it went and what it cost. Each opens on its whole timeline; all export as JSON lines.

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Traces', robots: { index: false, follow: false } };

const PER_PAGE = 50;
const STATUSES: Array<[string | undefined, string]> = [
  [undefined, 'All'],
  ['running', 'Running'],
  ['done', 'Done'],
  ['failed', 'Failed'],
  ['cancelled', 'Stopped'],
];

function Chips({ label, value, options, href }: { label: string; value?: string; options: Array<[string | undefined, string]>; href: (v: string | undefined) => string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-[64px] shrink-0 text-[12.5px] text-ink-3">{label}</span>
      {options.map(([v, text]) => {
        const on = (value ?? '') === (v ?? '');
        return (
          <Link
            key={text}
            href={href(v)}
            aria-current={on ? 'true' : undefined}
            className={`rounded-full px-3 py-1 text-[13px] transition-colors ${on ? 'bg-ink text-paper' : 'bg-[var(--chip-bg)] text-ink-2 shadow-[inset_0_0_0_1px_var(--ink-5)] hover:bg-[var(--chip-bg-hover)] hover:text-ink'}`}
          >
            {text}
          </Link>
        );
      })}
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[12.5px] text-ink-2">{label}</div>
      <div className="mt-0.5 text-[22px] leading-tight font-semibold text-ink tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-ink-3">{sub}</div>}
    </div>
  );
}

async function load(filter: TraceFilter, page: number) {
  const db = await ready();
  const [list, totals, providers] = await Promise.all([listTraces(db, filter, page - 1, PER_PAGE), traceTotals(db, filter), traceProviders(db)]);
  return { ...list, totals, providers, now: Date.now() };
}

export default async function TracesPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { key } = await params;
  if (key !== LAB_KEY) notFound();
  const sp = await searchParams;
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  const filter: TraceFilter = { status: one('status'), kind: one('kind'), provider: one('provider'), q: one('q') };
  const page = Math.max(1, Math.floor(Number(one('page')) || 1));
  const { traces, more, totals, providers, now } = await load(filter, page);
  const lab = `/lab/${key}/traces`;
  const query = (change: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ status: filter.status, kind: filter.kind, provider: filter.provider, q: filter.q, ...change })) if (v) q.set(k, v);
    return q.toString();
  };
  const href = (change: Record<string, string | undefined>) => {
    const q = query(change);
    return q ? `${lab}?${q}` : lab;
  };
  const filtered = Boolean(filter.status || filter.kind || filter.provider || filter.q);
  const exportQuery = query({});
  const exportHref = `${lab}/export${exportQuery ? `?${exportQuery}` : ''}`;
  return (
    <main className="mx-auto w-full max-w-[1240px] px-4 pt-[max(28px,env(safe-area-inset-top))] pb-[max(48px,env(safe-area-inset-bottom))] sm:px-8 sm:pt-10">
      <h1 className="font-display text-[36px] leading-none tracking-[-0.015em] text-ink sm:text-[42px]">Traces</h1>
      <p className="mt-3 max-w-[720px] text-[14.5px] text-ink-2">Every AI build, step by step: what it was asked, what it saw and what it did, with the tokens it took. Newest first.</p>

      <section className={`${CARD} mt-8 flex flex-wrap items-end gap-x-10 gap-y-4`}>
        <Fact label={filtered ? 'Traces shown' : 'Traces'} value={num(totals.traces)} />
        <Fact label="Tokens in" value={short(totals.tokens.in)} sub={totals.tokens.cacheRead ? `${short(totals.tokens.cacheRead)} from cache` : undefined} />
        <Fact label="Tokens out" value={short(totals.tokens.out)} sub={totals.tokens.reasoning ? `${short(totals.tokens.reasoning)} thinking` : undefined} />
        <Fact label="Stored" value={totals.bytes == null ? '—' : bytes(totals.bytes)} sub="all traces, with screenshots" />
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
          <a href={exportHref} download className="inline-flex h-9 items-center rounded-full bg-ink px-4 text-[13.5px] font-medium text-paper">
            Export JSONL
          </a>
          <a href={`${exportHref}${exportQuery ? '&' : '?'}images=1`} download className="text-[12.5px] text-ink-2 underline decoration-[var(--ink-4)] underline-offset-2 hover:text-ink">
            with screenshots
          </a>
        </div>
      </section>
      <p className="mt-2 px-1 text-[12px] text-ink-3">
        Export: the newest 200 {filtered ? 'traces shown' : 'traces'}, oldest first, one per line with all its events. For others, add <code className="font-mono">?since=2026-01-31</code> or <code className="font-mono">?limit=2000</code> to the export’s address.
      </p>

      <section className={`${CARD} mt-4 flex flex-col gap-2.5`}>
        <form action={lab} method="get" className="flex gap-2">
          {(['status', 'kind', 'provider'] as const).map((k) => filter[k] && <input key={k} type="hidden" name={k} value={filter[k]} />)}
          <input
            type="search"
            name="q"
            defaultValue={filter.q}
            placeholder="Words in the prompt"
            aria-label="Words in the prompt"
            className="h-9 min-w-0 flex-1 rounded-full bg-[var(--field-bg)] px-4 text-[14px] text-ink outline-none placeholder:text-ink-3 focus:bg-[var(--field-bg-focus)] focus:shadow-[inset_0_0_0_1px_var(--ink-4)]"
          />
          <button type="submit" className="h-9 shrink-0 rounded-full bg-ink px-4 text-[13.5px] font-medium text-paper">
            Search
          </button>
        </form>
        <Chips label="Status" value={filter.status} options={STATUSES} href={(v) => href({ status: v })} />
        <Chips label="Kind" value={filter.kind} options={[[undefined, 'All'], ...(Object.entries(KINDS) as Array<[TraceKind, string]>)]} href={(v) => href({ kind: v })} />
        {providers.length > 1 && <Chips label="Provider" value={filter.provider} options={[[undefined, 'All'], ...providers.map((p): [string, string] => [p, p])]} href={(v) => href({ provider: v })} />}
      </section>

      {traces.length === 0 ? (
        <p className={`${CARD} mt-4 text-[14px] text-ink-2`}>{filtered || page > 1 ? 'No traces match.' : 'No traces yet. Each AI build shows up here as it runs.'}</p>
      ) : (
        <section className={`${CARD} mt-4 overflow-x-auto px-0 py-2`}>
          <table className="w-full min-w-[1000px] text-left text-[13.5px] tabular-nums">
            <thead className="text-[12px] text-ink-2">
              <tr className="[&>th]:px-3 [&>th]:pt-2 [&>th]:pb-2 [&>th]:font-medium [&>th:first-child]:pl-5 [&>th:last-child]:pr-5">
                <th>When</th>
                <th>Who</th>
                <th>World</th>
                <th className="w-[32%]">Prompt</th>
                <th>Model</th>
                <th className="text-right">Steps</th>
                <th className="text-right">Tokens</th>
                <th className="text-right">Took</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((t) => {
                const open = `${lab}/${encodeURIComponent(t.id)}`;
                const tags = [KINDS[t.kind] ?? t.kind, t.mode === 'ask' ? 'ask' : '', t.meta.repair ? 'repair' : ''].filter(Boolean).join(' · ');
                return (
                  <tr key={t.id} className="border-t border-[var(--ink-5)] align-top hover:bg-[var(--hover)] [&>td]:px-3 [&>td]:py-2.5 [&>td:first-child]:pl-5 [&>td:last-child]:pr-5">
                    <td className="whitespace-nowrap">
                      <Link href={open} prefetch={false} title={when(t.startedAt)} className="text-ink hover:underline">
                        {ago(now, t.startedAt)}
                      </Link>
                      <div className="text-[12px] text-ink-3">{tags}</div>
                    </td>
                    <td className="max-w-[150px] break-words text-ink">{t.who ?? (t.device ? <span className="font-mono text-[12px] text-ink-2">device {t.device}</span> : <span className="text-ink-3">—</span>)}</td>
                    <td className="max-w-[170px]">
                      {t.worldId ? (
                        <Link href={`/w/${encodeURIComponent(t.worldId)}`} prefetch={false} target="_blank" className="line-clamp-2 break-words text-ink underline decoration-[var(--ink-4)] underline-offset-2 hover:decoration-[var(--ink-2)]">
                          {t.worldName || t.worldId}
                        </Link>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td>
                      <Link href={open} prefetch={false} className="line-clamp-2 break-words text-ink hover:underline">
                        {t.prompt || <span className="text-ink-3">(no prompt)</span>}
                      </Link>
                      {t.error && <div className="mt-0.5 line-clamp-2 text-[12.5px] break-words text-[var(--bad)]">{t.error}</div>}
                    </td>
                    <td className="max-w-[190px]">
                      <div className="break-words text-ink">{t.model ?? '—'}</div>
                      <div className="text-[12px] text-ink-3">{t.provider}</div>
                    </td>
                    <td className="text-right text-ink">{t.steps || '—'}</td>
                    <td className="text-right whitespace-nowrap text-ink" title={tokenLine(t.tokens, true)}>
                      {t.tokens.in || t.tokens.out ? (
                        <>
                          {short(t.tokens.in)} <span className="text-ink-3">/</span> {short(t.tokens.out)}
                        </>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className="text-right whitespace-nowrap text-ink">{t.status === 'running' ? <span className="text-ink-3">…</span> : duration(t.durationMs)}</td>
                    <td className="text-ink">
                      <Status status={t.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {(page > 1 || more) && (
        <nav className="mt-4 flex items-center justify-between px-1 text-[13.5px]">
          {page > 1 ? (
            <Link href={href({ page: page > 2 ? String(page - 1) : undefined })} className="text-ink underline decoration-[var(--ink-4)] underline-offset-2">
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="text-ink-3">Page {page}</span>
          {more ? (
            <Link href={href({ page: String(page + 1) })} className="text-ink underline decoration-[var(--ink-4)] underline-offset-2">
              Older →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
      <p className="mt-3 px-1 text-[12px] text-ink-3">Tokens: in / out. Hover a row’s tokens for cache and thinking.</p>
    </main>
  );
}
