'use client';
// The viewer's plan and credits (GET /api/billing), shared by the You tab, the chat and the plans
// sheet; and the way to Stripe (a checkout for Pro or a credit pack, the customer portal).

import { useEffect } from 'react';
import { create } from 'zustand';
import { track } from '@/lib/analytics';
import { api, ApiError } from '@/lib/api';
import type { BillingInfo } from '@/lib/types';
import { useSession } from '@/components/orb/AccountCard';
import { toast } from './toast';
import { useUi } from './ui';

type Status = 'idle' | 'loading' | 'ready' | 'error';

interface BillingState {
  info: BillingInfo | null;
  status: Status;
  /** The Stripe page being opened: 'pro', a pack's id or 'portal'. */
  going: string | null;
  /** Fetch the plan and credits (deduped; `force` fetches again). */
  load(force?: boolean): Promise<BillingInfo | null>;
  /** A build used credits: show them gone until the next load. */
  spent(credits: number): void;
  /** Go to Stripe's checkout for Pro or a credit pack. */
  checkout(item: string, where: string): Promise<void>;
  /** Go to Stripe's portal (cancel Pro, card, invoices). */
  portal(): Promise<void>;
  /** Put what the account earned in its worlds' shops into its building (top-up credits). */
  buildWithEarnings(): Promise<void>;
  /** Go to Stripe to set up payouts (in `country` the first time), or to the payout dashboard. */
  payoutSetup(country: string | null): Promise<void>;
  payoutDashboard(): Promise<void>;
  /** Cash out all that's payable to the account's payout account. */
  cashOut(): Promise<void>;
}

let pending: Promise<BillingInfo | null> | null = null;

const here = () => `${location.pathname}${location.search}`;

export const useBilling = create<BillingState>((set, get) => ({
  info: null,
  status: 'idle',
  going: null,
  load(force = false) {
    if (!force && get().status === 'ready') return Promise.resolve(get().info);
    if (pending && !force) return pending;
    if (!get().info) set({ status: 'loading' });
    const p = api
      .billing()
      .then((info) => {
        if (pending === p) set({ info, status: 'ready' });
        return info;
      })
      .catch(() => {
        if (pending === p) set({ status: get().info ? 'ready' : 'error' });
        return get().info;
      })
      .finally(() => {
        if (pending === p) pending = null;
      });
    pending = p;
    return p;
  },
  spent(credits) {
    const info = get().info;
    if (!info || !(credits > 0)) return;
    const fromPlan = Math.min(credits, Math.max(0, info.credits.monthly - info.credits.used));
    const fromBonus = Math.min(credits - fromPlan, Math.max(0, info.credits.bonus ?? 0));
    set({
      info: {
        ...info,
        credits: { ...info.credits, left: info.credits.left - credits, used: info.credits.used + fromPlan, bonus: info.credits.bonus - fromBonus, topup: info.credits.topup - (credits - fromPlan - fromBonus) },
      },
    });
  },
  async checkout(item, where) {
    if (get().going) return;
    set({ going: item });
    track('checkout_start', { item, where });
    try {
      const { url } = await api.checkout(item, here());
      window.location.assign(url);
    } catch (e) {
      set({ going: null });
      if (e instanceof ApiError && e.code === 'account_required') {
        useUi.getState().setPlans(false);
        useUi.getState().requestSignup();
        toast('Create your free account first — then go Pro.');
        return;
      }
      toast(e instanceof ApiError && e.status < 500 ? e.message : 'Couldn’t open the checkout. Try again in a moment.', 'error');
      if (e instanceof ApiError && e.status === 409) void get().load(true);
    }
  },
  async portal() {
    if (get().going) return;
    set({ going: 'portal' });
    track('billing_portal');
    try {
      const { url } = await api.portal(here());
      window.location.assign(url);
    } catch (e) {
      set({ going: null });
      toast(e instanceof ApiError && e.status < 500 ? e.message : 'Couldn’t open your billing. Try again in a moment.', 'error');
    }
  },
  async payoutSetup(country) {
    if (get().going) return;
    set({ going: 'payout-setup' });
    track('payout_setup', { country });
    try {
      const { url } = await api.payoutSetup(country, here());
      window.location.assign(url);
    } catch (e) {
      set({ going: null });
      toast(e instanceof ApiError && e.status < 500 ? e.message : 'Couldn’t open Stripe. Try again in a moment.', 'error');
    }
  },
  async payoutDashboard() {
    if (get().going) return;
    set({ going: 'payout-dashboard' });
    try {
      const { url } = await api.payoutDashboard(here());
      window.location.assign(url);
    } catch (e) {
      set({ going: null });
      toast(e instanceof ApiError && e.status < 500 ? e.message : 'Couldn’t open your payouts. Try again in a moment.', 'error');
    }
  },
  async cashOut() {
    if (get().going) return;
    set({ going: 'payout' });
    try {
      const { payout, billing } = await api.cashOut();
      set({ info: billing, status: 'ready', going: null });
      track('payout', { credits: payout.credits, currency: payout.currency });
      toast(
        payout.requested
          ? `${money(payout.amount, payout.currency)} requested ✨ Orb checks every cash-out, usually within two working days, then Stripe pays it to your bank.`
          : payout.pending
          ? `${money(payout.amount, payout.currency)} is being sent — it shows here in a moment.`
          : `${money(payout.amount, payout.currency)} is on its way to your bank ✨ (Stripe pays out within a few days)`,
        'success',
      );
    } catch (e) {
      set({ going: null });
      toast(e instanceof ApiError && e.message ? e.message : 'Couldn’t cash out just now. Your earnings are safe: try again in a moment.', 'error');
      void get().load(true);
    }
  },
  async buildWithEarnings() {
    const before = get().info?.earnings?.credits ?? 0;
    if (get().going || !(before > 0)) return;
    set({ going: 'earnings' });
    try {
      const info = await api.buildWithEarnings();
      set({ info, status: 'ready', going: null });
      track('earnings_use', { credits: before });
      toast(`${formatCredits(before)} credits are yours to build with ✨`, 'success');
    } catch (e) {
      set({ going: null });
      toast(e instanceof ApiError && e.status < 500 ? e.message : 'Couldn’t do that just now. Try again in a moment.', 'error');
    }
  },
}));

/** An amount of a currency: "€56.00". */
export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

// Signing in or out changes whose credits they are.
useSession.subscribe((s, prev) => {
  if ((s.me?.user?.id ?? null) === (prev.me?.user?.id ?? null) || useBilling.getState().status === 'idle') return;
  void useBilling.getState().load(true);
});

/** The plan and credits (loads them on first use). */
export function useCredits() {
  const info = useBilling((s) => s.info);
  const status = useBilling((s) => s.status);
  useEffect(() => {
    void useBilling.getState().load();
  }, []);
  return { info, status };
}

/** "Nov 12" */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** 1234.5 → "1,234"; 0.4 → "0" (credits shown as whole numbers, never below zero). */
export function formatCredits(n: number): string {
  return Math.max(0, Math.floor(n + 1e-9)).toLocaleString('en-US');
}

/** "1 credit", "1,234 credits" (whole credits, never below zero). */
export function creditsText(n: number): string {
  const shown = formatCredits(n);
  return `${shown} ${shown === '1' ? 'credit' : 'credits'}`;
}

/** "about 20 builds" for this many credits. */
export function aboutBuilds(credits: number, typical: number): string {
  const n = Math.max(1, Math.round(credits / Math.max(1, typical) / (credits >= 500 ? 10 : 1)) * (credits >= 500 ? 10 : 1));
  return `about ${n.toLocaleString('en-US')} builds`;
}
