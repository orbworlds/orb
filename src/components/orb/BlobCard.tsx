'use client';
// "Your blob" in the You tab: the character others see you as in worlds. A color to pick (free) and
// Orb's things to wear, bought with credits (src/lib/looks.ts): tap one to try it on, then get it.

import { useEffect, useState } from 'react';
import { BLOB_COLORS, cleanWear, LOOK_ITEMS, lookItem, type LookItem } from '@/lib/looks';
import { getPlayerColor } from '@/lib/local';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { formatCredits } from '@/state/billing';
import { useLooks } from '@/state/looks';
import { useUi } from '@/state/ui';
import { useWorld } from '@/state/world';
import { useMe } from './AccountCard';
import { Blob } from './Blob';
import { groupClass, SectionHeader, Skeleton, useHydrated } from './WorldCard';

export function BlobCard() {
  const hydrated = useHydrated();
  const { signedIn } = useMe();
  const player = useWorld((s) => s.me);
  const view = useLooks((s) => s.view);
  const busy = useLooks((s) => s.busy);
  const [trying, setTrying] = useState<string | null>(null);
  const [short, setShort] = useState<string | null>(null);
  useEffect(() => {
    void useLooks.getState().load();
  }, []);

  const header = <SectionHeader id="orb-blob-h" title="Your blob" />;
  if (!hydrated) {
    return (
      <section aria-labelledby="orb-blob-h">
        {header}
        <Skeleton className="h-[236px] rounded-[18px]" />
      </section>
    );
  }

  const color = player?.color ?? getPlayerColor();
  const owned = new Set(view?.owned ?? []);
  const wearing = signedIn ? (view?.look.wear ?? player?.wears ?? []) : [];
  const tried = trying ? lookItem(trying) : undefined;
  const shown = tried ? cleanWear([...wearing, tried.id]) : wearing;

  const pick = (it: LookItem) => {
    setShort(null);
    if (!owned.has(it.id)) return setTrying(trying === it.id ? null : it.id);
    setTrying(null);
    void useLooks.getState().wear(wearing.includes(it.id) ? wearing.filter((x) => x !== it.id) : cleanWear([...wearing, it.id]));
  };
  const buy = async (it: LookItem) => {
    const r = await useLooks.getState().buy(it);
    if (r.ok) return setTrying(null);
    if (r.code === 'account_required') return useUi.getState().requestSignup();
    setShort(r.message);
  };

  return (
    <section aria-labelledby="orb-blob-h">
      {header}
      <div className={`${groupClass} p-4`}>
        <div className="flex items-center gap-4">
          <div className="grid h-[118px] w-[96px] shrink-0 place-items-center rounded-[16px] bg-[var(--field-bg)]" data-orb-blob={shown.join(' ')}>
            <Blob color={color} wear={shown} size={74} label={`Your blob${shown.length ? ` wearing ${shown.map((id) => lookItem(id)?.name).join(' and ')}` : ''}`} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] leading-snug text-ink-2">How others see you in worlds. Pick a color, and get things to wear with your credits.</p>
            <div role="radiogroup" aria-label="Color" className="mt-2.5 flex flex-wrap gap-1.5">
              {BLOB_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={c === color}
                  aria-label={`Color ${c}`}
                  onClick={() => void useLooks.getState().setColor(c)}
                  className={`h-6 w-6 rounded-full transition-transform duration-150 active:scale-90 ${c === color ? 'shadow-[0_0_0_2px_var(--glass-bg-strong),0_0_0_4px_var(--ink)]' : 'shadow-[inset_0_0_0_1px_rgba(0,0,0,.08)]'}`}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-5 gap-2">
          {LOOK_ITEMS.map((it) => {
            const mine = owned.has(it.id);
            const worn = wearing.includes(it.id);
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => pick(it)}
                disabled={!!busy}
                aria-pressed={mine ? worn : trying === it.id}
                aria-label={`${it.name}: ${worn ? 'wearing' : mine ? 'yours' : `${it.price} credits`}`}
                title={it.name}
                className={`flex flex-col items-center rounded-[14px] bg-[var(--glass-bg-strong)] px-1 pt-1 pb-1.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ink)_8%,transparent)] transition-[transform,box-shadow] duration-200 active:scale-[.97] disabled:opacity-60 ${worn || trying === it.id ? 'shadow-[inset_0_0_0_2px_var(--ink)]' : 'hover:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ink)_18%,transparent)]'}`}
              >
                <Blob color={color} wear={[it.id]} size={44} label={it.name} head />
                <span className="mt-0.5 flex items-center gap-0.5 text-[11px] font-medium text-ink-2 tabular-nums">
                  {busy === it.id ? <Spinner size={10} /> : mine ? <Icon name="check" size={11} /> : <Icon name="coins" size={11} />}
                  {worn ? 'On' : mine ? 'Yours' : it.price}
                </span>
              </button>
            );
          })}
        </div>

        {tried && !owned.has(tried.id) && (
          <div className="mt-3 flex items-center gap-3 rounded-[14px] bg-[var(--field-bg)] px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-medium text-ink tabular-nums">
                {tried.name} · {tried.price} credits
              </div>
              <div className="text-[12px] leading-snug text-ink-2">
                {short ?? (signedIn ? `Yours in every world${view?.credits != null ? ` · you have ${formatCredits(view.credits)}` : ''}` : 'Make a free account to get it.')}
              </div>
            </div>
            {!signedIn ? (
              <Button variant="primary" size="sm" onClick={() => useUi.getState().requestSignup()} className="shrink-0">
                Create account
              </Button>
            ) : short ? (
              <Button variant="glass" size="sm" icon="plus" onClick={() => useUi.getState().setPlans(true)} className="shrink-0">
                Top up
              </Button>
            ) : (
              <Button variant="iris" size="sm" onClick={() => void buy(tried)} disabled={!!busy} className="shrink-0">
                {busy === tried.id && <Spinner size={13} />}
                Get it
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
