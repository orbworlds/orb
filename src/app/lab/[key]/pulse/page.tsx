import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LAB_KEY } from '@/server/lab';
import { payoutRequests } from '@/server/payouts';
import { pulse, type PulseDay, type PulseProblem } from '@/server/pulse';
import { ready } from '@/server/schema';
import { ago, CARD, LINK, MAIN, Section, Table, TITLE, type Column } from './ui';
import { PayoutRequests } from './PayoutRequests';

// How Orb is doing: the last 7 days, the free builder, and problems worth a look (with alerts in
// a chat when ORB_ALERT_WEBHOOK is set). Who came and what they did: ../analytics.

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Pulse' };

const usd = (n: number) => `$${n.toFixed(2)}`;

const COLUMNS: Column<PulseDay>[] = [
  { label: 'Day', cell: (d) => d.day },
  { label: 'Visitors', num: true, cell: (d) => d.visitors },
  { label: 'New worlds', num: true, cell: (d) => d.started },
  { label: 'Built by AI', num: true, cell: (d) => d.built },
  { label: 'Remixes', num: true, cell: (d) => d.remixes },
  { label: 'Builds', num: true, cell: (d) => d.builds },
  { label: 'Failed builds', num: true, cell: (d) => d.failed },
  { label: 'Accounts', num: true, cell: (d) => d.accounts },
  { label: 'Free builder $', num: true, cell: (d) => usd(d.spend) },
];

function Problems({ list, now }: { list: PulseProblem[]; now: number }) {
  if (list.length === 0) return <p className={`${CARD} text-[14px] text-ink-2`}>Nothing so far.</p>;
  return (
    <ul className="flex flex-col gap-3">
      {list.map((e) => (
        <li key={`${e.kind}-${e.firstAt}-${e.message}`} className={CARD}>
          <div className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] text-ink-2">
            <span className="font-medium text-ink">{e.kind}</span>
            {e.path && <span>{e.path}</span>}
            <span>
              · {e.count}× · last {ago(now, e.lastAt)} · first {ago(now, e.firstAt)}
            </span>
          </div>
          <div className="mt-1 text-[14px] break-words text-ink">{e.message}</div>
          {e.detail && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[12.5px] text-ink-2">Details</summary>
              <pre className="mt-2 overflow-x-auto font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-2">{e.detail}</pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

export default async function PulsePage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (key !== LAB_KEY) notFound();
  const db = await ready();
  const [p, requests] = await Promise.all([pulse(db), payoutRequests(db).catch(() => [])]);
  const down = p.builder.lastDown && p.now - Date.parse(p.builder.lastDown.at) < 30 * 60_000 ? p.builder.lastDown : null;
  return (
    <main className={MAIN}>
      <h1 className={TITLE}>Pulse</h1>
      <p className="mt-3 text-[14.5px] text-ink-2">
        The last 7 days (UTC). Who came and what they did:{' '}
        <Link href={`/lab/${key}/analytics`} className={LINK}>
          Analytics
        </Link>
        . Every build, step by step:{' '}
        <Link href={`/lab/${key}/traces`} className={LINK}>
          Traces
        </Link>
        .
      </p>

      <section className={`${CARD} mt-8 flex items-start gap-3`}>
        <span aria-hidden className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${down ? 'bg-[var(--bad)]' : 'bg-[var(--ok)]'}`} />
        <div className="min-w-0 text-[14px] text-ink">
          <div className="font-medium">{down ? 'The free builder is down' : 'Free builder'}</div>
          <div className="mt-0.5 text-ink-2">
            {p.builder.backend} · {p.builder.model}
            {p.builder.lastDown ? ` · last refused ${ago(p.now, p.builder.lastDown.at)}: ${p.builder.lastDown.message}` : ' · never refused'}
          </div>
          <div className="mt-0.5 text-ink-2">
            Today (UTC): {usd(p.builder.today.all)} of the {usd(p.builder.budget.dailyUsd)} budget · without an account {usd(p.builder.today.anon)} of {usd(p.builder.budget.anonUsd)} · paid for with credits people bought {usd(p.builder.today.paid)}
          </div>
        </div>
      </section>

      <section className={`${CARD} mt-4 flex items-start gap-3`}>
        <span aria-hidden className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${p.plans.payments ? 'bg-[var(--ok)]' : 'bg-ink-4'}`} />
        <div className="min-w-0 text-[14px] text-ink">
          <div className="font-medium">Plans</div>
          <div className="mt-0.5 text-ink-2">
            {!p.plans.payments ? 'No Stripe key yet (STRIPE_SECRET_KEY): Pro says “Coming soon”' : p.plans.testMode ? 'Stripe sandbox (test cards): on the live site only ORB_STRIPE_TEST_ACCOUNTS can pay' : 'Stripe is set up'} · {p.plans.pro} on Pro{p.plans.ending ? ` (${p.plans.ending} ending)` : ''} · {p.plans.packs} credit pack{p.plans.packs === 1 ? '' : 's'} sold ({Math.round(p.plans.packCredits).toLocaleString('en-US')} credits)
          </div>
        </div>
      </section>

      <Section title="Payout requests" about="Makers cashing out what their worlds earned. Look at who bought: many players, no one buyer most of it, worlds people play.">
        <PayoutRequests requests={requests} />
      </Section>

      <div className="mt-4">
        <Table
          rows={p.days}
          columns={COLUMNS}
          rowKey={(d) => d.day}
          minWidth={780}
          footer={`All time: ${p.totals.worlds} worlds by people · ${p.totals.accounts} accounts · ${p.totals.devices} devices · ${p.totals.plays} plays · ${p.totals.likes} likes`}
        />
      </div>

      <Section title="Server and builder" about="Errors in routes and page renders, and the free builder being refused, newest first.">
        <Problems list={p.problems.server} now={p.now} />
      </Section>
      <Section title="Pages" about="Crashes in Orb’s own pages, as browsers report them (worlds’ own errors aren’t here).">
        <Problems list={p.problems.pages} now={p.now} />
      </Section>
    </main>
  );
}
