'use client';
// Plans: Free and Pro, and credit packs for any account. A dialog over the world, opened from the
// You tab, the chat when credits run low, a world's shop, and /pricing.

import { useEffect, type ReactNode } from 'react';
import type { BillingInfo } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { aboutBuilds, creditsText, formatCredits, shortDate, useBilling, useCredits } from '@/state/billing';
import { toast } from '@/state/toast';
import { useUi } from '@/state/ui';
import { useMe } from './AccountCard';
import { groupClass, Skeleton } from './WorldCard';

export function PlansSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const { info, status } = useCredits();
  const { signedIn } = useMe();
  useEffect(() => {
    if (open) void useBilling.getState().load(true);
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={<span id="orb-plans-title">Plans</span>} width={680}>
      {info ? (
        <Plans info={info} signedIn={signedIn} onClose={onClose} />
      ) : status === 'error' ? (
        <p className="text-[14px] text-ink-2">Couldn’t load the plans. Try again in a moment.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-[200px] rounded-[20px]" />
          <Skeleton className="h-[200px] rounded-[20px]" />
        </div>
      )}
    </Modal>
  );
}

function Plans({ info, signedIn, onClose }: { info: BillingInfo; signedIn: boolean; onClose(): void }) {
  const p = info.plans;
  const c = info.credits;
  const going = useBilling((s) => s.going);
  const pro = info.plan === 'pro';
  const signUp = (then?: string) => {
    onClose();
    useUi.getState().requestSignup();
    if (then) toast(then);
  };
  const standing = (when: string) => `${creditsText(c.left)} left · ${when}`;

  return (
    <>
      <p className="text-[14px] leading-relaxed text-ink-2">Credits pay for the AI that builds your worlds, and for things you get in worlds. A typical build uses about {p.typicalBuild}.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Plan name="Free" usd={0} credits={p.free} typical={p.typicalBuild} current={info.plan === 'free'} status={info.plan === 'free' ? standing(`more on ${shortDate(c.periodEnd)}`) : undefined}>
          {info.plan === 'guest' && (
            <Button variant="primary" className="w-full" onClick={() => signUp()}>
              Create a free account
            </Button>
          )}
        </Plan>
        <Plan
          name="Pro"
          usd={p.pro.usd}
          credits={p.pro.credits}
          typical={p.typicalBuild}
          current={pro}
          extra="Everything in Free, with more credits."
          status={pro ? standing(c.cancelAt ? `ends ${shortDate(c.cancelAt)}` : `renews ${shortDate(c.periodEnd)}`) : undefined}
        >
          {pro ? (
            info.manage && (
              <Button variant="glass" className="w-full" disabled={!!going} onClick={() => void useBilling.getState().portal()}>
                {going === 'portal' && <Spinner size={15} />}
                Manage plan
              </Button>
            )
          ) : (
            <Button
              variant="iris"
              className="w-full"
              disabled={!info.payments || !!going}
              onClick={() => (signedIn ? void useBilling.getState().checkout('pro', 'plans') : signUp('Create your free account first — then go Pro.'))}
            >
              {going === 'pro' && <Spinner size={15} />}
              {info.payments ? 'Go Pro' : 'Coming soon'}
            </Button>
          )}
        </Plan>
      </div>

      {info.payments && (
        <section aria-labelledby="orb-topups" className={`${groupClass} mt-3 p-4`}>
          <h3 id="orb-topups" className="text-[14px] font-medium text-ink">
            Top up{c.topup > 0 && <span className="font-normal text-ink-2"> · {formatCredits(c.topup)} top-up credits left</span>}
          </h3>
          <div className="mt-2.5 grid grid-cols-3 gap-2">
            {p.topups.map((pack) => (
              <button
                key={pack.id}
                type="button"
                disabled={!!going}
                onClick={() => (signedIn ? void useBilling.getState().checkout(pack.id, 'plans') : signUp('Create your free account first — then buy credits.'))}
                className="rounded-[14px] bg-[var(--glass-bg-strong)] px-3 py-2.5 text-left shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ink)_8%,transparent)] transition-[transform,box-shadow] duration-200 hover:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ink)_16%,transparent)] active:scale-[.98] disabled:opacity-55"
              >
                <span className="flex items-center justify-between gap-2 text-[14px] font-semibold text-ink tabular-nums">
                  ${pack.usd}
                  {going === pack.id && <Spinner size={13} />}
                </span>
                <span className="block text-[12.5px] text-ink-2 tabular-nums">{formatCredits(pack.credits)} credits</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <p className="mt-4 text-[13px] leading-snug text-ink-2">
        <span className="font-medium text-ink">Make money with your worlds.</span> Add a shop to a world you made: when players buy things with credits they paid for, you get {Math.round(p.shopShare * 100)}%.
      </p>
      <p className="mt-3 text-[12.5px] leading-snug text-ink-3">Credits refresh every month; top-ups stay until used. Cancel anytime.</p>
    </>
  );
}

function Plan({
  name,
  usd,
  credits,
  typical,
  current,
  status,
  extra,
  children,
}: {
  name: string;
  usd: number;
  credits: number;
  typical: number;
  current: boolean;
  status?: string;
  extra?: string;
  children?: ReactNode;
}) {
  return (
    <section aria-label={name} className={`${groupClass} flex flex-col p-5 ${current ? 'shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--ink)_28%,transparent)]' : ''}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[16px] font-semibold text-ink">{name}</h3>
        {current && <span className="text-[12.5px] text-ink-2">Your plan</span>}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="font-display text-[42px] leading-none tracking-[-0.02em] text-ink tabular-nums">${usd.toLocaleString('en-US')}</span>
        <span className="text-[13px] text-ink-2">a month</span>
      </div>
      <p className="mt-3 text-[14px] text-ink">
        <span className="font-medium tabular-nums">{formatCredits(credits)} credits</span> a month <span className="text-ink-3">· {aboutBuilds(credits, typical)}</span>
      </p>
      {extra && <p className="mt-1 text-[13px] leading-snug text-ink-2">{extra}</p>}
      {status && <p className="mt-3 text-[12.5px] text-ink-2 tabular-nums">{status}</p>}
      {children && <div className="mt-auto pt-4">{children}</div>}
    </section>
  );
}
