'use client';
// "Plan" section of the You tab: the plan, the credits left and when they refresh, what your
// worlds' shops earned you, and the way to more: an account, Pro, a top-up, or managing billing in
// Stripe's portal.

import { track } from '@/lib/analytics';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { useState } from 'react';
import type { BillingInfo } from '@/lib/types';
import { creditsText, formatCredits, money, shortDate, useBilling, useCredits } from '@/state/billing';
import { useUi } from '@/state/ui';
import { useWorld } from '@/state/world';
import { groupClass, SectionHeader, Skeleton, useHydrated } from './WorldCard';

/** How much of this period's plan credits is left, as a bar. */
export function CreditsMeter({ left, total }: { left: number; total: number }) {
  const share = total > 0 ? Math.min(1, Math.max(0, left / total)) : 0;
  return (
    <div
      role="meter"
      aria-label="Credits left this month"
      aria-valuemin={0}
      aria-valuemax={Math.round(total)}
      aria-valuenow={Math.max(0, Math.round(left))}
      className="h-1.5 w-full overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--ink)_8%,transparent)]"
    >
      <div className={`h-full rounded-full transition-[width] duration-500 ease-[var(--ease)] ${share < 0.15 ? 'bg-[var(--bad)]' : 'bg-[color-mix(in_oklab,var(--ink)_45%,transparent)]'}`} style={{ width: `${Math.max(share > 0 ? 3 : 0, share * 100)}%` }} />
    </div>
  );
}

/** Credits as US$ (a credit is a cent). */
const usd = (credits: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(credits / 100);

/** The prompt "Add a shop" puts in the chat, for a world of your own on screen. */
const ADD_SHOP = 'Add a shop where players can buy a few fun things for credits';

export function PlanCard() {
  const hydrated = useHydrated();
  const { info, status } = useCredits();
  const going = useBilling((s) => s.going);
  const ownWorld = useWorld((s) => s.status === 'ready' && !!s.world && s.canEdit && !s.isExternal && s.world.kind === 'native');
  const openPlans = () => useUi.getState().setPlans(true);
  const addShop = () => {
    const ui = useUi.getState();
    ui.setDraft(ADD_SHOP);
    ui.setTab('chat');
    ui.requestFocus();
    track('earn_add_shop', {});
  };

  const header = (
    <SectionHeader
      id="orb-plan-h"
      title="Plan"
      accessory={
        <button type="button" onClick={openPlans} className="mb-0.5 text-[13px] font-medium text-ink-2 hover:text-ink">
          See plans
        </button>
      }
    />
  );

  if (!hydrated || !info) {
    return (
      <section aria-labelledby="orb-plan-h">
        {header}
        {status === 'error' ? <div className={`${groupClass} p-4 text-[13px] text-ink-2`}>Couldn’t load your plan. Try again in a moment.</div> : <Skeleton className="h-[84px] rounded-[18px]" />}
      </section>
    );
  }

  const c = info.credits;
  if (info.plan === 'guest') {
    return (
      <section aria-labelledby="orb-plan-h">
        {header}
        <div className={`${groupClass} p-4 text-[13.5px] leading-snug text-ink-2`}>
          <button type="button" onClick={() => useUi.getState().requestSignup()} className="font-medium text-ink underline decoration-ink-4 underline-offset-[3px] hover:decoration-ink">
            Create a free account
          </button>{' '}
          to get {formatCredits(info.plans.free)} credits a month.
        </div>
      </section>
    );
  }

  const pro = info.plan === 'pro';
  const when = pro ? (c.cancelAt ? `Pro ends ${shortDate(c.cancelAt)}` : `Renews ${shortDate(c.periodEnd)}`) : `More on ${shortDate(c.periodEnd)}`;
  return (
    <section aria-labelledby="orb-plan-h">
      {header}
      <div className={`${groupClass} p-4`}>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-medium text-ink tabular-nums">
              {pro ? 'Pro' : 'Free'} · {creditsText(c.left)} left
            </div>
            <div className="truncate text-[12.5px] text-ink-2">
              {when}
              {c.topup > 0 ? ` · ${formatCredits(c.topup)} from top-ups` : ''}
              {c.bonus > 0 ? ` · ${formatCredits(c.bonus)} from your earnings` : ''}
              {c.pastDue ? ' · the last payment didn’t go through' : ''}
            </div>
          </div>
          {!pro && info.payments && (
            <Button variant="iris" size="sm" onClick={() => void useBilling.getState().checkout('pro', 'you')} disabled={!!going} className="shrink-0">
              {going === 'pro' && <Spinner size={13} />}
              Go Pro
            </Button>
          )}
        </div>
        <div className="mt-3">
          <CreditsMeter left={Math.max(0, c.monthly - c.used)} total={c.monthly} />
        </div>
        {info.earnings && (
          <div className="mt-3 rounded-[14px] bg-[var(--field-bg)] px-3 py-2.5">
            <div className="flex items-center gap-3">
              {info.earnings.total > 0 ? (
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] leading-snug font-medium text-ink tabular-nums">
                    {formatCredits(info.earnings.credits)} credits earned · ≈ {usd(info.earnings.credits)}
                    {info.earnings.total > info.earnings.credits ? ` · ${formatCredits(info.earnings.total)} in all` : ''}
                  </div>
                  <div className="text-[12px] leading-snug text-ink-2">{payoutLine(info.earnings.payouts, info.earnings.credits)}</div>
                </div>
              ) : (
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium text-ink">Make money with your worlds</div>
                  <div className="text-[12px] leading-snug text-ink-2">
                    Add a shop to a world you made: you get {Math.round(info.plans.shopShare * 100)}% of what players pay{info.earnings.payouts ? ', paid out to your bank' : ''}.
                  </div>
                </div>
              )}
              {info.earnings.credits > 0 ? (
                <Button variant="glass" size="sm" onClick={() => void useBilling.getState().buildWithEarnings()} disabled={!!going} className="shrink-0">
                  {going === 'earnings' && <Spinner size={13} />}
                  Build with them
                </Button>
              ) : (
                ownWorld && (
                  <Button variant="glass" size="sm" onClick={addShop} className="shrink-0">
                    Add a shop
                  </Button>
                )
              )}
            </div>
            {info.earnings.payouts && (info.earnings.credits > 0 || info.earnings.payouts.account !== 'none') && <CashOut payouts={info.earnings.payouts} earned={info.earnings.credits} />}
          </div>
        )}
        {(info.payments || info.manage) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {info.payments && (
              <Button variant="glass" size="sm" icon="plus" onClick={openPlans}>
                Top up
              </Button>
            )}
            {info.manage && (
              <Button variant="ghost" size="sm" onClick={() => void useBilling.getState().portal()} disabled={!!going}>
                {going === 'portal' && <Spinner size={13} />}
                Manage billing
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

type Payouts = NonNullable<NonNullable<BillingInfo['earnings']>['payouts']>;

/** Countries Stripe can pay makers in (the bank account's country; Stripe says if one won't work from Orb's). */
const PAYOUT_COUNTRIES = [
  'AT', 'AU', 'BE', 'BG', 'CA', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HK', 'HR', 'HU', 'IE', 'IT', 'JP',
  'LI', 'LT', 'LU', 'LV', 'MT', 'MX', 'NL', 'NO', 'NZ', 'PL', 'PT', 'RO', 'SE', 'SG', 'SI', 'SK', 'TH', 'AE', 'US',
];

/** Under the earnings: where cashing out stands. */
function payoutLine(p: Payouts | null | undefined, earned: number): string {
  if (!p) return 'From your worlds’ shops · cash payouts are coming';
  if (p.requested > 0) return `${formatCredits(p.requested)} on their way: Orb checks every cash-out, usually within two working days`;
  if (p.account === 'none') return earned > 0 ? `From your worlds’ shops · cash them out from ${formatCredits(p.minimum)} credits, or build with them` : 'From your worlds’ shops';
  if (canCashOut(p)) return `${formatCredits(p.payable)} ready to cash out`;
  if (earned <= 0) return p.paid > 0 ? `${formatCredits(p.paid)} credits paid out so far` : 'From your worlds’ shops';
  if (p.payable >= p.minimum) return `Cash out once ${p.minBuyers} different players have bought from you (${p.buyers} so far)`;
  return `${formatCredits(p.payable)} ready · sales clear after ${p.holdDays} days · cash out from ${formatCredits(p.minimum)}`;
}

const canCashOut = (p: Payouts) => p.payable >= p.minimum && p.buyers >= p.minBuyers && p.requested <= 0;

function CashOut({ payouts: p, earned }: { payouts: Payouts; earned: number }) {
  const going = useBilling((s) => s.going);
  const [asking, setAsking] = useState(false);
  const [country, setCountry] = useState(() => (p.country && PAYOUT_COUNTRIES.includes(p.country) ? p.country : ''));
  const names = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
  const sorted = PAYOUT_COUNTRIES.map((c) => ({ c, name: names?.of(c) ?? c })).sort((a, b) => a.name.localeCompare(b.name));
  const amount = p.currency && p.usdPer ? money(p.payable / 100 / p.usdPer, p.currency) : usd(p.payable);
  const b = useBilling.getState();

  if (p.account === 'none' && asking) {
    return (
      <form
        className="mt-2.5 flex flex-col gap-2 border-t border-[var(--ink-5)] pt-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (country) void b.payoutSetup(country);
        }}
      >
        <div className="text-[12px] leading-snug text-ink-2">Stripe pays you: it asks who you are and where your bank is, once. Where is your bank account?</div>
        <div className="flex items-center gap-2">
          <select
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            aria-label="Your bank account’s country"
            className="h-9 min-w-0 flex-1 rounded-[12px] bg-[var(--chip-bg)] px-2.5 text-[13px] text-ink outline-none"
          >
            <option value="" disabled>
              Country
            </option>
            {sorted.map(({ c, name }) => (
              <option key={c} value={c}>
                {name}
              </option>
            ))}
          </select>
          <Button variant="iris" size="sm" type="submit" disabled={!country || !!going} className="shrink-0">
            {going === 'payout-setup' && <Spinner size={13} />}
            Continue with Stripe
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-[var(--ink-5)] pt-2.5">
      {p.account === 'none' && (
        <Button variant="iris" size="sm" onClick={() => setAsking(true)}>
          Cash out
        </Button>
      )}
      {p.account === 'pending' && (
        <Button variant="iris" size="sm" onClick={() => void b.payoutSetup(null)} disabled={!!going}>
          {going === 'payout-setup' && <Spinner size={13} />}
          Finish payout setup
        </Button>
      )}
      {p.account === 'ready' && earned > 0 && p.requested <= 0 && (
        <Button variant="iris" size="sm" onClick={() => void b.cashOut()} disabled={!!going || !canCashOut(p)} title={canCashOut(p) ? undefined : `From ${formatCredits(p.minimum)} credits earned from ${p.minBuyers} players`}>
          {going === 'payout' && <Spinner size={13} />}
          {canCashOut(p) ? `Cash out ${amount}` : 'Cash out'}
        </Button>
      )}
      {p.account !== 'none' && (
        <Button variant="ghost" size="sm" onClick={() => void b.payoutDashboard()} disabled={!!going}>
          {going === 'payout-dashboard' && <Spinner size={13} />}
          Payouts
        </Button>
      )}
    </div>
  );
}
