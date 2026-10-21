'use client';
// Orb's own sheet for buying something in a world (orb.shop.buy): the item at the price from Orb's
// copy of the world's list, your credits, and Buy. The world only hears whether you got it.
import { useCallback, useEffect, useState } from 'react';
import { track } from '@/lib/analytics';
import { api, ApiError } from '@/lib/api';
import type { ShopView } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { AccountCard, useMe } from '@/components/orb/AccountCard';
import { Skeleton } from '@/components/orb/WorldCard';
import { formatCredits, useBilling } from '@/state/billing';
import { answerPurchase, useShop, type PurchaseAsk } from '@/state/shop';
import { apiMessage, toast } from '@/state/toast';
import { useUi } from '@/state/ui';

export function PurchaseSheet() {
  const ask = useShop((s) => s.ask);
  return (
    <Modal open={!!ask} onClose={() => answerPurchase({ ok: false, reason: 'cancelled' })} title="Get it with credits" width={420}>
      {ask && <PurchaseBody key={`${ask.worldId}:${ask.item}`} ask={ask} />}
    </Modal>
  );
}

const note = 'text-[13px] leading-snug text-ink-2';

function PurchaseBody({ ask }: { ask: PurchaseAsk }) {
  const { signedIn } = useMe();
  const [view, setView] = useState<ShopView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [short, setShort] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api
        .shop(ask.worldId)
        .then((v) => {
          setView(v);
          setError(null);
        })
        .catch(() => setError('Couldn’t reach the shop. Try again in a moment.')),
    [ask.worldId],
  );
  useEffect(() => {
    void load();
  }, [load, signedIn]);
  useEffect(() => track('shop_open', { world_id: ask.worldId, item: ask.item }), [ask.worldId, ask.item]);

  const item = view?.items.find((i) => i.id === ask.item);
  const owned = !!item && !!view?.owned.includes(item.id);

  const buy = async () => {
    if (!item || busy) return;
    setBusy(true);
    setShort(null);
    try {
      const r = await api.buy(ask.worldId, item.id, item.price);
      track('purchase', { world_id: ask.worldId, item: item.id, credits: r.charged, ok: true });
      toast(r.charged ? `You got ${item.name} ✨` : `${item.name} is yours to try ✨`, 'success');
      void useBilling.getState().load(true);
      answerPurchase({ ok: true });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'failed';
      track('purchase', { world_id: ask.worldId, item: item.id, ok: false, error: code });
      if (code === 'no_credits') setShort(e instanceof ApiError ? e.message : 'You need more credits.');
      else if (code === 'price_changed' || code === 'unknown_item') {
        setError(e instanceof ApiError ? e.message : 'That changed just now.');
        void load();
      } else setError(apiMessage(e, 'Couldn’t buy that. Try again in a moment.'));
    } finally {
      setBusy(false);
    }
  };
  const getCredits = () => {
    answerPurchase({ ok: false, reason: 'no_credits' });
    useUi.getState().setPlans(true);
  };

  if (!view)
    return error ? (
      <p className={note}>{error}</p>
    ) : (
      <div className="flex items-center gap-4" aria-busy="true">
        <Skeleton className="h-14 w-14 shrink-0 rounded-[16px]" />
        <div className="min-w-0 flex-1">
          <Skeleton className="h-4 w-1/2 rounded-full" />
          <Skeleton className="mt-2 h-3 w-3/4 rounded-full" />
        </div>
      </div>
    );
  if (!item)
    return (
      <div className="flex flex-col gap-4">
        <p className={note}>“{ask.worldName}” doesn’t sell that.</p>
        <Button variant="glass" onClick={() => answerPurchase({ ok: false, reason: 'unknown_item' })} className="self-start">
          OK
        </Button>
      </div>
    );

  const byOrb = ask.maker === 'orbworlds' || ask.maker === 'Orb';
  const paid = Math.min(item.price, view.paid ?? 0);
  const toMaker = paid >= item.price ? `It goes to ${ask.maker}, who made this world.` : paid > 0 ? `Part of it goes to ${ask.maker}, who made this world.` : `${ask.maker}, who made this world, earns when people pay with credits they bought.`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <span aria-hidden="true" className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[16px] bg-[var(--field-bg)] text-[30px]">
          {item.emoji ?? '✦'}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[16px] font-semibold text-ink">{item.name}</h3>
          {item.description && <p className={`mt-0.5 ${note}`}>{item.description}</p>}
          <p className="mt-1 text-[12.5px] text-ink-3">
            In “{ask.worldName}” by {ask.maker}
          </p>
        </div>
      </div>

      {owned ? (
        <>
          <p className={note}>You have it already.</p>
          <Button variant="primary" onClick={() => answerPurchase({ ok: true })} className="self-start">
            OK
          </Button>
        </>
      ) : !view.signedIn ? (
        <AccountCard variant="inline" where="shop" reason="Sign in to get things in worlds" onSignedIn={() => void load()} onCancel={() => answerPurchase({ ok: false, reason: 'sign_in' })} />
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-3 rounded-[14px] bg-[var(--field-bg)] px-4 py-3">
            <span className="text-[15px] font-semibold text-ink tabular-nums">{view.mine ? 'Free for you' : `${formatCredits(item.price)} credits`}</span>
            <span className="text-[12.5px] text-ink-2 tabular-nums">You have {formatCredits(view.credits ?? 0)}</span>
          </div>
          {error && <p className="text-[13px] text-[var(--bad)]">{error}</p>}
          {short && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-[13px] text-ink">{short}</p>
              <Button size="sm" variant="primary" onClick={getCredits} className="shrink-0">
                Get credits
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => void buy()} disabled={busy}>
              {busy && <Spinner size={14} />}
              {view.mine ? 'Try it — it’s your world' : `Buy for ${formatCredits(item.price)} credits`}
            </Button>
            <Button variant="ghost" onClick={() => answerPurchase({ ok: false, reason: 'cancelled' })} disabled={busy}>
              Not now
            </Button>
          </div>
          <p className="text-[12px] leading-snug text-ink-3">
            {view.mine ? 'Players pay the price you set. You can try your own things for free.' : byOrb ? 'It helps Orb keep building worlds.' : toMaker}
          </p>
        </>
      )}
    </div>
  );
}
