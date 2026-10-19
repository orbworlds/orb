'use client';
// The Orb expanded: a 400px glass panel docked on the Orb's side (desktop) or a bottom sheet with a
// grab handle (mobile). It grows out of the Orb's position and collapses back into it.
// Header: mini orb (tap = collapse) · segmented tabs Chat · Explore · You · minimize.
// Chat stays mounted while another tab shows, so scroll position and the draft survive.
import { useEffect, useRef, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/Button';
import { useIsMobile, useUi, type PanelTab } from '@/state/ui';
import { ORB_MARGIN, ORB_SIZE, OrbSphere } from './Orb';

const PANEL_W = 400;
const PANEL_INSET = 16;

export function OrbPanel({
  building,
  chat,
  you,
  header,
  youBadge = 0,
  onExplore,
}: {
  building: boolean;
  chat: ReactNode;
  you: ReactNode;
  /** World info + actions, shown above every tab. */
  header?: ReactNode;
  /** New things waiting in the You tab (friend requests, invites). */
  youBadge?: number;
  onExplore(): void;
}) {
  const { panelOpen: open, tab, detent, orb, closePanel, setTab, setDetent } = useUi();
  const mobile = useIsMobile();
  const ref = useRef<HTMLElement>(null);
  const sheetDrag = useRef<{ id: number; y0: number; t0: number; dy: number } | null>(null);

  // Esc collapses the panel when focus is inside it (sheets and menus handle their own Esc first).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (ref.current?.contains(document.activeElement)) {
        e.preventDefault();
        closePanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closePanel]);

  // Collapsing with focus inside would strand keyboard focus on a hidden element.
  useEffect(() => {
    if (!open && ref.current?.contains(document.activeElement)) (document.activeElement as HTMLElement | null)?.blur();
  }, [open]);

  // --- mobile: swipe the sheet down to collapse (or up to expand) -----------------------------
  const onHandleDown = (e: PointerEvent<HTMLElement>) => {
    if (!mobile || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button:not([data-grab])')) return;
    sheetDrag.current = { id: e.pointerId, y0: e.clientY, t0: performance.now(), dy: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: PointerEvent<HTMLElement>) => {
    const d = sheetDrag.current;
    const el = ref.current;
    if (!d || d.id !== e.pointerId || !el) return;
    d.dy = e.clientY - d.y0;
    el.style.transition = 'none';
    // Resist upward pulls, follow downward ones.
    el.style.transform = `translate3d(0, ${d.dy > 0 ? d.dy : d.dy * 0.25}px, 0)`;
  };
  const onHandleUp = (e: PointerEvent<HTMLElement>) => {
    const d = sheetDrag.current;
    const el = ref.current;
    sheetDrag.current = null;
    if (!d || d.id !== e.pointerId || !el) return;
    el.style.transition = '';
    el.style.transform = '';
    const v = d.dy / Math.max(1, performance.now() - d.t0); // px per ms
    if (Math.abs(d.dy) < 6) {
      // A tap on the handle toggles between the two heights.
      setDetent(detent === 'full' ? 'half' : 'full');
    } else if (d.dy < -40 || v < -0.5) {
      setDetent('full');
    } else if (d.dy > 0) {
      const far = d.dy > (detent === 'full' ? 220 : 90) || v > 0.7;
      if (far) closePanel();
      else if (detent === 'full' && (d.dy > 60 || v > 0.35)) setDetent('half');
    }
  };

  // --- geometry ------------------------------------------------------------------------------
  const right = orb.side === 'right';
  const orbCenterFromEdge = ORB_MARGIN - PANEL_INSET + ORB_SIZE / 2;
  // The panel grows out of the Orb: transform-origin = the Orb's center in panel coordinates.
  const origin = `${right ? `calc(100% - ${orbCenterFromEdge}px)` : `${orbCenterFromEdge}px`} calc(${orbCenterFromEdge}px + (100% - ${orbCenterFromEdge * 2}px) * ${orb.y.toFixed(4)})`;

  const desktopStyle: CSSProperties = {
    top: `calc(var(--safe-t) + ${PANEL_INSET}px)`,
    bottom: `calc(var(--safe-b) + ${PANEL_INSET}px)`,
    [right ? 'right' : 'left']: `calc(${right ? 'var(--safe-r)' : 'var(--safe-l)'} + ${PANEL_INSET}px)`,
    width: PANEL_W,
    maxWidth: `calc(100vw - ${PANEL_INSET * 2}px)`,
    borderRadius: 'var(--r-panel)',
    transformOrigin: origin,
    transform: open ? 'none' : 'scale(.14)',
    opacity: open ? 1 : 0,
    filter: open ? 'none' : 'blur(6px)',
    visibility: open ? 'visible' : 'hidden',
    pointerEvents: open ? 'auto' : 'none',
    transition: open
      ? 'transform 520ms var(--ease), opacity 260ms var(--ease), filter 380ms var(--ease), visibility 0s'
      : 'transform 380ms var(--ease-soft), opacity 300ms var(--ease-soft) 40ms, filter 300ms var(--ease-soft), visibility 0s linear 400ms',
  };
  const mobileStyle: CSSProperties = {
    left: 0,
    right: 0,
    // Above the on-screen keyboard (src/lib/viewport.ts), never taller than what's visible.
    bottom: 'var(--kb, 0px)',
    height: `min(${detent === 'full' ? '74dvh' : '46dvh'}, calc(var(--vvh, 100dvh) - var(--safe-t) - 12px))`,
    borderRadius: 'var(--r-panel) var(--r-panel) 0 0',
    paddingBottom: 'max(0px, calc(var(--safe-b) - var(--kb, 0px)))',
    transform: open ? 'none' : 'translate3d(0, 104%, 0)',
    visibility: open ? 'visible' : 'hidden',
    pointerEvents: open ? 'auto' : 'none',
    transition: open
      ? 'transform 480ms var(--ease), height 420ms var(--ease), bottom 200ms var(--ease), visibility 0s'
      : 'transform 360ms var(--ease-soft), height 420ms var(--ease), visibility 0s linear 380ms',
  };

  const tabs: { id: PanelTab | 'explore'; label: string; icon: string }[] = [
    { id: 'chat', label: 'Chat', icon: 'chat' },
    { id: 'explore', label: 'Explore', icon: 'compass' },
    { id: 'you', label: 'You', icon: 'user' },
  ];
  const activeIndex = tab === 'chat' ? 0 : 2;

  return (
    <aside
      ref={ref}
      aria-label="Orb"
      inert={!open}
      className="glass-strong fixed z-50 flex flex-col overflow-hidden"
      style={mobile ? mobileStyle : desktopStyle}
    >
      <header
        className="relative shrink-0 touch-none select-none px-3 pt-2.5 pb-2 sm:touch-auto sm:pt-3"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
      >
        {mobile && (
          <button
            type="button"
            data-grab=""
            aria-label={detent === 'full' ? 'Make the panel smaller' : 'Make the panel taller'}
            className="mx-auto -mt-1 mb-1.5 flex h-4 w-14 items-center justify-center"
          >
            <span className="h-[5px] w-9 rounded-full bg-ink-4" />
          </button>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={closePanel}
            aria-label="Collapse Orb"
            title="Collapse"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-transform duration-300 ease-[var(--ease-spring)] hover:scale-105 active:scale-95"
          >
            <OrbSphere size={30} building={building} glow={false} />
          </button>

          <div role="tablist" aria-label="Orb sections" className="relative grid flex-1 grid-cols-3 rounded-full bg-[var(--field-bg)] p-[3px]">
            <span
              aria-hidden="true"
              className="absolute top-[3px] bottom-[3px] left-[3px] rounded-full bg-[var(--glass-bg-strong)] shadow-[0_1px_2px_rgba(0,0,0,.08),0_4px_12px_-4px_rgba(20,20,60,.18)] transition-transform duration-[380ms] ease-[var(--ease)] dark:bg-white/[.12]"
              style={{ width: 'calc((100% - 6px) / 3)', transform: `translateX(${activeIndex * 100}%)` }}
            />
            {tabs.map((t, i) => {
              const selected = t.id !== 'explore' && i === activeIndex;
              const badge = t.id === 'you' ? youBadge : 0;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-label={badge ? `${t.label} (${badge} new)` : undefined}
                  onClick={() => (t.id === 'explore' ? onExplore() : setTab(t.id))}
                  className={`relative z-10 flex h-9 items-center justify-center gap-1.5 rounded-full text-[13px] font-medium transition-colors duration-200 ${selected ? 'text-ink' : 'text-ink-2 hover:text-ink'}`}
                >
                  <Icon name={t.icon} size={15} strokeWidth={selected ? 2 : 1.75} />
                  {t.label}
                  {badge > 0 && (
                    <span aria-hidden="true" className="animate-pop flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-[var(--iris-4)] px-1 text-[10.5px] leading-none font-semibold text-white tabular-nums">
                      {badge > 9 ? '9+' : badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <IconButton icon={mobile ? 'chevron-down' : 'minimize'} label="Minimize" size={40} onClick={closePanel} />
        </div>
      </header>

      {header}

      <div className="relative min-h-0 flex-1">
        <section
          role="tabpanel"
          aria-label="Chat"
          className="absolute inset-0 flex flex-col transition-opacity duration-200"
          style={tab === 'chat' ? undefined : { opacity: 0, visibility: 'hidden', pointerEvents: 'none' }}
        >
          {chat}
        </section>
        {tab === 'you' && (
          <section role="tabpanel" aria-label="You" className="animate-fade-in scroll-soft absolute inset-0 overflow-y-auto overscroll-contain">
            {you}
          </section>
        )}
      </div>
    </aside>
  );
}
