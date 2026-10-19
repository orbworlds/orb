// Moving to a new domain: the card a browser sees while its things travel from a former address
// to the new one (src/server/move.ts has the whole journey, docs/operations.md "Moving to a new domain").
import type { Metadata } from 'next';
import { safeTo } from '@/lib/move';
import { originsConfig } from '@/server/origins';
import Handoff, { type HandoffProps } from './Handoff';

export const metadata: Metadata = {
  title: { absolute: 'Orb' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const param = (v: string | string[] | undefined) => (typeof v === 'string' ? v : '');

export default async function MovePage({ searchParams }: PageProps<'/move'>) {
  const q = await searchParams;
  const o = originsConfig();
  const kind = param(q.passkey);
  const props: HandoffProps = {
    step: param(q.code) ? 'claim' : !param(q.s) ? 'start' : kind === 'signin' || kind === 'signup' ? 'passkey' : 'send',
    site: o.site,
    back: o.targets.includes(param(q.back)) ? param(q.back) : o.site,
    to: safeTo(param(q.to)),
    kind: kind === 'signup' ? 'signup' : 'signin',
    name: param(q.name).slice(0, 80),
    from: param(q.from),
    signingIn: kind === '1',
    dropped: param(q.dropped) === '1',
  };
  return <Handoff {...props} />;
}
