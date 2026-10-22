'use client';
// The Orb expanded: a 400px glass panel beside the Orb, anchored at the bottom and only as tall as
// what it holds (desktop; on home, under the header's Orb), or a bottom sheet with a grab handle
// (phones). It grows out of the Orb and collapses back into it; the Orb stays where it was, and a
// tap on it closes the panel again.
// Header: tabs Chat · You and a close ("—") on desktop; on phones the handle (tap: taller or
// smaller) and a swipe down. Esc closes it wherever focus is on the page (a world's frame keeps its
// own keys); on home, so does a click outside it. The world's row shows above the chat only.
// Chat stays mounted while You shows, so scroll position and the draft survive.
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/Button';
import { useIsMobile, useUi, type PanelTab } from '@/state/ui';
import { ORB_MARGIN, ORB_SIZE } from './Orb';

const PANEL_W = 400;
const PANEL_INSET = 16;
/** Between the Orb and its panel. */
const ORB_GAP = 12;
/** On home: under the header's row. */
const HOME_TOP = 64;
/** How far into the screen the open panel reaches from its edge in a world (with the Orb beside it). */
export const PANEL_REACH = ORB_MARGIN + ORB_SIZE + ORB_GAP + PANEL_W;
/** A move this long is a drag of the sheet, not a tap. */
const DRAG_THRESHOLD = 6;

const TABS: { id: PanelTab; label: string; icon: string }[] = [
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'you', label: 'You', icon: 'user' },
];

export function OrbPanel({
  home,
  chat,
  you,
  header,
  youBadge = 0,
}: {
  /** On home, where the Orb sits in the page's header (top right): the panel opens under it. */
  home: boolean;
  chat: ReactNode;
  you: ReactNode;
  /** World info + actions, shown above the chat. */
  header?: ReactNode;
  /** New things waiting in the You tab (friend requests, invites). */
  youBadge?: number;
}) {
  const { panelOpen: open, tab, detent, orb, closePanel, setTab, setDetent } = useUi();
  const mobile = useIsMobile();
  const ref = useRef<HTMLElement>(null);
  const sheetDrag = useRef<{ id: number; y0: number; t0: number; dy: number; moved: boolean } | null>(null);
  const dragged = useRef(false);

  // Esc closes the panel wherever focus is on the page (keys inside a world's frame stay there; a
  // dialog over it, a menu or an edit takes its own Esc first). On home, so does a click outside it,
  // once the page has handled it, unless that click asked something of the Orb (its toggle, Sign in,
  // a world opening) or was in a dialog or menu. In a world, clicking the world leaves it open, as
  // people try the world while they chat.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      closePanel();
    };
    // (Where it was is read before the page handles it: that may take the clicked element away. A
    // press that began in the panel, like a text selection dragged out of it, isn't a click outside.)
    let before: unknown = null;
    let pressedIn = false;
    const onPress = (e: Event) => (pressedIn = !!ref.current?.contains(e.target as Node));
    const onClickStart = (e: Event) => {
      const t = e.target as Element | null;
      const outside = home && !pressedIn && !!t?.closest && !ref.current?.contains(t) && !t.closest('[role="dialog"], [role="menu"]');
      pressedIn = false;
      before = outside ? useUi.getState() : null;
    };
    const onClick = () => before && useUi.getState() === before && closePanel();
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPress, true);
    window.addEventListener('click', onClickStart, true);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPress, true);
      window.removeEventListener('click', onClickStart, true);
      window.removeEventListener('click', onClick);
    };
  }, [open, home, closePanel]);

  // Collapsing with focus inside would strand keyboard focus on a hidden element.
  useEffect(() => {
    if (!open && ref.current?.contains(document.activeElement)) (document.activeElement as HTMLElement | null)?.blur();
  }, [open]);

  // --- phones: the sheet is as tall as what it holds; a change of detent animates from the last height --
  const shownHeight = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      shownHeight.current = el.offsetHeight;
      document.documentElement.style.setProperty('--sheet-h', `${el.offsetHeight}px`); // toasts sit above it (Toaster)
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    const from = shownHeight.current;
    if (!el || !mobile || !open || !from || from === el.offsetHeight) return;
    el.animate([{ height: `${from}px` }, { height: `${el.offsetHeight}px` }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }, [detent, mobile, open]);

  // --- phones: drag the sheet down to collapse (or up to grow); a tap on its header toggles the height --
  const onHandleDown = (e: PointerEvent<HTMLElement>) => {
    dragged.current = false;
    if (!mobile || e.button !== 0 || (e.target as HTMLElement).closest('button:not([data-grab])')) return;
    sheetDrag.current = { id: e.pointerId, y0: e.clientY, t0: performance.now(), dy: 0, moved: false };
  };
  const onHandleMove = (e: PointerEvent<HTMLElement>) => {
    const d = sheetDrag.current;
    const el = ref.current;
    if (!d || d.id !== e.pointerId || !el) return;
    d.dy = e.clientY - d.y0;
    if (!d.moved) {
      if (Math.abs(d.dy) < DRAG_THRESHOLD) return;
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      el.dataset.dragging = '';
    }
    // Resist upward pulls, follow downward ones.
    el.style.transform = `translate3d(0, ${d.dy > 0 ? d.dy : d.dy * 0.25}px, 0)`;
  };
  const onHandleUp = (e: PointerEvent<HTMLElement>) => {
    const d = sheetDrag.current;
    const el = ref.current;
    sheetDrag.current = null;
    if (!d?.moved || d.id !== e.pointerId || !el) return;
    dragged.current = true; // the click this drag ends in is no tap
    delete el.dataset.dragging;
    el.style.transform = '';
    const v = d.dy / Math.max(1, performance.now() - d.t0); // px per ms
    // From full height, a drag down settles at half unless it goes most of the way (or flicks).
    if (d.dy < -40 || v < -0.5) setDetent('full');
    else if (detent === 'full' ? d.dy > el.offsetHeight * 0.6 || v > 1.2 : d.dy > 90 || v > 0.7) closePanel();
    else if (detent === 'full' && (d.dy > 60 || v > 0.35)) setDetent('half');
  };
  // The height changes on the click, once the finger is up, so nothing under it gets the tap.
  const onHeaderClick = (e: MouseEvent<HTMLElement>) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    if (!mobile || (e.target as HTMLElement).closest('button:not([data-grab])')) return;
    setDetent(detent === 'full' ? 'half' : 'full');
  };

  // --- geometry ------------------------------------------------------------------------------
  // Beside the Orb (which stays, to close it again), or on home under the header's Orb. The panel
  // grows out of the Orb: transform-origin = the Orb's center in panel coordinates.
  const right = home || orb.side === 'right';
  const side = home ? PANEL_INSET : ORB_MARGIN + ORB_SIZE + ORB_GAP;
  const orbY = `(var(--safe-t) + ${ORB_MARGIN + ORB_SIZE / 2}px + (100vh - var(--safe-t) - var(--safe-b) - ${ORB_MARGIN * 2 + ORB_SIZE}px) * ${orb.y.toFixed(4)})`;
  const origin = home
    ? 'calc(100% - 28px) -32px'
    : `${right ? `calc(100% + ${ORB_GAP + ORB_SIZE / 2}px)` : `${-(ORB_GAP + ORB_SIZE / 2)}px`} calc(100% - (100vh - var(--safe-b) - ${PANEL_INSET}px - ${orbY}))`;
  const top = `calc(var(--safe-t) + ${HOME_TOP}px)`;

  const desktopStyle: CSSProperties = {
    ...(home ? { top } : { bottom: `calc(var(--safe-b) + ${PANEL_INSET}px)` }),
    [right ? 'right' : 'left']: `calc(${right ? 'var(--safe-r)' : 'var(--safe-l)'} + ${side}px)`,
    width: PANEL_W,
    maxWidth: `calc(100vw - ${side + PANEL_INSET}px)`,
    maxHeight: home ? `calc(100dvh - ${top} - var(--safe-b) - ${PANEL_INSET}px)` : `calc(100dvh - var(--safe-t) - var(--safe-b) - ${PANEL_INSET * 2}px)`,
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
  // Above the on-screen keyboard (src/lib/viewport.ts), never taller than what's visible, and as tall
  // as what it holds: up to about three quarters of the screen (half, the world's row and the chat),
  // or nearly all of it (full, which adds the way back to Explore).
  const visible = 'calc(var(--vvh, 100dvh) - var(--safe-t) - 12px)';
  const mobileStyle: CSSProperties = {
    left: 0,
    right: 0,
    bottom: 'var(--kb, 0px)',
    maxHeight: `min(${detent === 'full' ? 92 : 74}dvh, ${visible})`,
    borderRadius: 'var(--r-panel) var(--r-panel) 0 0',
    paddingBottom: 'max(0px, calc(var(--safe-b) - var(--kb, 0px)))',
    transform: open ? 'none' : 'translate3d(0, 104%, 0)',
    visibility: open ? 'visible' : 'hidden',
    pointerEvents: open ? 'auto' : 'none',
    transition: open ? 'transform 480ms var(--ease), bottom 200ms var(--ease), visibility 0s' : 'transform 360ms var(--ease-soft), visibility 0s linear 380ms',
  };

  const activeIndex = TABS.findIndex((t) => t.id === tab);
  return (
    <aside
      ref={ref}
      aria-label="Orb"
      inert={!open}
      className="glass-strong fixed z-50 flex flex-col overflow-hidden data-[dragging]:!transition-none"
      // Nearly opaque, so the panel reads the same over any world (and what sits on it matches it).
      style={{ ...(mobile ? mobileStyle : desktopStyle), '--glass-bg-strong': 'color-mix(in oklab, var(--paper) 94%, transparent)' } as CSSProperties}
    >
      <header
        className="relative shrink-0 touch-none select-none px-3 pt-1 pb-2 sm:touch-auto sm:pt-3"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        onClick={onHeaderClick}
      >
        {mobile && (
          <button
            type="button"
            data-grab=""
            aria-label={detent === 'full' ? 'Make the panel smaller' : 'Make the panel taller'}
            className="mx-auto -mb-1 flex h-7 w-24 items-center justify-center"
          >
            <span className="h-[5px] w-9 rounded-full bg-ink-4" />
          </button>
        )}
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Orb sections" className="relative grid flex-1 grid-cols-2 rounded-full bg-[var(--field-bg)] p-[3px]">
            <span
              aria-hidden="true"
              className="absolute top-[3px] bottom-[3px] left-[3px] rounded-full bg-[var(--glass-bg-strong)] shadow-[0_1px_2px_rgba(0,0,0,.08),0_4px_12px_-4px_rgba(20,20,60,.18)] transition-transform duration-[380ms] ease-[var(--ease)] dark:bg-white/[.12]"
              style={{ width: 'calc((100% - 6px) / 2)', transform: `translateX(${activeIndex * 100}%)` }}
            />
            {TABS.map((t) => {
              const selected = t.id === tab;
              const badge = t.id === 'you' ? youBadge : 0;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-label={badge ? `${t.label} (${badge} new)` : undefined}
                  onClick={() => setTab(t.id)}
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

          {!mobile && <IconButton icon="minimize" label="Close" size={40} onClick={closePanel} />}
        </div>
      </header>

      {tab === 'chat' && header}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <section
          role="tabpanel"
          aria-label="Chat"
          className={`flex flex-col transition-opacity duration-200 ${tab === 'chat' ? 'min-h-0 flex-1' : 'invisible absolute inset-0 opacity-0'}`}
        >
          {chat}
        </section>
        {tab === 'you' && (
          <section role="tabpanel" aria-label="You" className="animate-fade-in scroll-soft min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {you}
          </section>
        )}
      </div>
    </aside>
  );
}
