'use client';
// Makers' cash-out requests on Pulse (src/server/payouts.ts): what's behind each, and Orb's answer.
// Answering moves money, so it takes the admin token (ORB_ADMIN_TOKEN), asked once per tab, not the
// lab's key.

import { useState } from 'react';
import type { PayoutRequest } from '@/server/payouts';
import { CARD } from './ui';

const TOKEN = 'orb:admin-token';

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function PayoutRequests({ requests }: { requests: PayoutRequest[] }) {
  const [done, setDone] = useState<Record<string, string>>({});
  const answer = async (id: string, action: 'approve' | 'reject') => {
    let token = sessionStorage.getItem(TOKEN);
    if (!token) {
      token = window.prompt('Admin token (ORB_ADMIN_TOKEN)')?.trim() ?? '';
      if (!token) return;
    }
    const note = action === 'reject' ? (window.prompt('Why (kept with the payout)?') ?? '') : '';
    setDone((d) => ({ ...d, [id]: '…' }));
    const res = await fetch(`/api/admin/payouts/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': token }, body: JSON.stringify({ action, note }) });
    const body = (await res.json().catch(() => ({}))) as { status?: string; message?: string };
    if (res.status === 401) sessionStorage.removeItem(TOKEN);
    else sessionStorage.setItem(TOKEN, token);
    setDone((d) => ({ ...d, [id]: res.ok ? (body.status ?? 'done') : (body.message ?? `failed (${res.status})`) }));
  };
  if (!requests.length) return <p className={`${CARD} text-[14px] text-ink-2`}>None waiting.</p>;
  return (
    <ul className="flex flex-col gap-3">
      {requests.map((r) => (
        <li key={r.id} className={CARD}>
          <div className="flex flex-wrap items-baseline gap-x-2 text-[14px] text-ink">
            <span className="font-medium">{money(r.amount, r.currency)}</span>
            <span className="text-ink-2">
              {r.credits.toLocaleString('en-US')} credits · {r.user.handle ? `@${r.user.handle}` : r.user.name} · account since {r.user.createdAt.slice(0, 10)} · bank in {r.country} · asked {r.createdAt.slice(0, 10)}
            </span>
          </div>
          <div className="mt-1 text-[13px] text-ink-2">
            {r.sales.count} cashable sales from {r.sales.buyers} players · the biggest buyer {Math.round(r.sales.topBuyerShare * 100)}% of them
            {r.excluded > 0 ? ` · ${r.excluded.toLocaleString('en-US')} credits from their own accounts or flagged buyers (not paid out)` : ''}
            {r.reversed > 0 ? ` · ${r.reversed.toLocaleString('en-US')} credits reversed (refunds, disputes)` : ''}
          </div>
          {r.sales.worlds.length > 0 && (
            <div className="mt-1 text-[13px] text-ink-2">
              From{' '}
              {r.sales.worlds.map((w, i) => (
                <span key={w.id}>
                  {i ? ', ' : ''}
                  <a href={`/w/${encodeURIComponent(w.id)}`} target="_blank" rel="noreferrer" className="underline">
                    {w.name}
                  </a>{' '}
                  ({w.credits.toLocaleString('en-US')})
                </span>
              ))}
            </div>
          )}
          <div className="mt-2.5 flex items-center gap-2 text-[13px]">
            {done[r.id] ? (
              <span className="text-ink-2">{done[r.id]}</span>
            ) : (
              <>
                <button type="button" onClick={() => void answer(r.id, 'approve')} className="rounded-full bg-ink px-3 py-1 font-medium text-paper">
                  Approve and send
                </button>
                <button type="button" onClick={() => void answer(r.id, 'reject')} className="rounded-full px-3 py-1 text-ink-2 shadow-[inset_0_0_0_1px_var(--ink-5)]">
                  Reject
                </button>
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
