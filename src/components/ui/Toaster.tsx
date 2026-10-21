'use client';
// Toasts never print over a world's own hints: in a world they're a small bubble beside the Orb (the
// Orb speaks; beside its panel when that's open on a wide screen, above or below it on a phone, just
// above its sheet when that's open); elsewhere they sit at the bottom centre, above the safe area and
// the keyboard.
import type { CSSProperties } from 'react';
import { dockedOrbStyle, ORB_MARGIN, ORB_SIZE } from '@/components/orb/Orb';
import { useToasts } from '@/state/toast';
import type { OrbSide } from '@/state/ui';
import { Icon } from './Icon';

/** Where the Orb is, for toasts in a world: its side and height, and how far from the edge to keep (its panel). */
export interface ToastAnchor {
  side: OrbSide;
  y: number;
  /** Phones: above or below the Orb rather than beside it. */
  narrow: boolean;
  /** Distance from the screen edge to keep clear (the Orb, or its open panel). */
  clear: number;
}

/** `'sheet'`: just above the Orb's open sheet on a phone (OrbPanel keeps --sheet-h). */
function placement(at: ToastAnchor | 'sheet' | null): { style: CSSProperties; align: string } {
  if (!at) return { style: { left: 16, right: 16, bottom: 'calc(max(16px, var(--safe-b)) + var(--kb, 0px))' }, align: 'items-center' };
  if (at === 'sheet') return { style: { left: 16, right: 16, bottom: 'calc(var(--kb, 0px) + var(--sheet-h, 50dvh) + 10px)' }, align: 'items-center' };
  const orb = dockedOrbStyle(at.side, at.y);
  const below = at.y > 0.5; // a low Orb: the bubbles grow upward from it
  const edge = at.side === 'right' ? { right: `calc(var(--safe-r) + ${at.narrow ? ORB_MARGIN : at.clear + 10}px)` } : { left: `calc(var(--safe-l) + ${at.narrow ? ORB_MARGIN : at.clear + 10}px)` };
  const vertical = at.narrow
    ? below
      ? { bottom: `calc(100% - ${orb.top} + 10px)` }
      : { top: `calc(${orb.top} + ${ORB_SIZE + 10}px)` }
    : below
      ? { bottom: `calc(100% - ${orb.top} - ${ORB_SIZE}px)` }
      : { top: orb.top };
  return { style: { ...edge, ...vertical }, align: at.side === 'right' ? 'items-end' : 'items-start' };
}

export function Toaster({ anchor = null }: { anchor?: ToastAnchor | 'sheet' | null }) {
  const { toasts, dismiss } = useToasts();
  const { style, align } = placement(anchor);
  return (
    <div className={`pointer-events-none fixed z-[90] flex flex-col gap-2 ${align}`} style={style}>
      {toasts.map((t) => (
        <div
          key={t.id}
          className="glass-strong animate-pop pointer-events-auto flex max-w-[min(360px,calc(100vw-32px))] items-center gap-2.5 rounded-[18px] py-2 pr-2 pl-3.5 text-[14px] leading-snug"
          role="status"
        >
          {t.tone === 'success' && <Icon name="check" size={16} className="shrink-0 text-[var(--ok)]" />}
          {t.tone === 'error' && <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--bad)]" />}
          <span className="py-0.5">{t.text}</span>
          {t.action ? (
            <button
              className="shrink-0 rounded-full bg-ink px-3 py-1 text-[13px] font-medium text-paper"
              onClick={() => {
                t.action!.onClick();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : (
            <span className="w-1.5 shrink-0" />
          )}
        </div>
      ))}
    </div>
  );
}
