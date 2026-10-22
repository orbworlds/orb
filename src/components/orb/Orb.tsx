'use client';
// The Orb: Orb's signature — a living iridescent sphere and the only always-on-screen control.
// Drag it anywhere (pointer events, tap-vs-drag threshold); on release it springs to the nearest
// left/right edge inside the safe area and remembers where it lives. Tap (or Enter/Space) opens
// the panel, which grows out of the Orb's position. On phones, past the start screen, it tucks half
// behind its edge so it never sits on a world's own buttons or Explore's tiles.
import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useUi, type OrbSide } from '@/state/ui';

export const ORB_SIZE = 56;
/** Gap between the Orb and the screen edge (inside the safe area). */
export const ORB_MARGIN = 18;
const DRAG_THRESHOLD = 6;
/** How much of a tucked Orb shows past its edge. */
const TUCKED_SHOWN = 30;

/** The sphere itself — reused by the floating Orb, the panel's mini orb, avatars and loaders. */
export function OrbSphere({ size = ORB_SIZE, building = false, glow = true, className = '' }: { size?: number; building?: boolean; glow?: boolean; className?: string }) {
  return (
    <span className={`orb inline-block shrink-0 ${className}`} style={{ width: size, height: size }} data-building={building ? '' : undefined} aria-hidden="true">
      <span className="orb-body">
        {glow && <span className="orb-glow" />}
        <span className="orb-ring" />
        <span className="orb-core">
          <span className="orb-swirl" />
          <span className="orb-swirl-2" />
          <span className="orb-shade" />
          <span className="orb-spec" />
          <span className="orb-rim" />
        </span>
      </span>
    </span>
  );
}

/** CSS position of the docked Orb (top-left corner), in viewport terms; `tucked`: half behind its edge. */
export function dockedOrbStyle(side: OrbSide, y: number, tucked = false): { left: string; top: string } {
  const free = `(100% - var(--safe-t) - var(--safe-b) - ${ORB_MARGIN * 2 + ORB_SIZE}px)`;
  const left = tucked
    ? side === 'left' ? `calc(var(--safe-l) - ${ORB_SIZE - TUCKED_SHOWN}px)` : `calc(100% - var(--safe-r) - ${TUCKED_SHOWN}px)`
    : side === 'left' ? `calc(var(--safe-l) + ${ORB_MARGIN}px)` : `calc(100% - var(--safe-r) - ${ORB_MARGIN + ORB_SIZE}px)`;
  return {
    left,
    top: `calc(var(--safe-t) + ${ORB_MARGIN}px + ${free} * ${y.toFixed(4)})`,
  };
}

export function Orb({
  building,
  unread,
  hidden,
  tucked = false,
  onToggle,
}: {
  building: boolean;
  unread: boolean;
  /** Out of sight: home has it in its header, or a phone's sheet is open. */
  hidden: boolean;
  /** Half behind its edge (phones, while a world plays or Explore is open). */
  tucked?: boolean;
  /** Open its panel, or close it when it's open. */
  onToggle(): void;
}) {
  const { orb, orbLoaded, panelOpen, loadOrb, moveOrb } = useUi();
  const ref = useRef<HTMLButtonElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    loadOrb();
  }, [loadOrb]);

  const docked = dockedOrbStyle(orb.side, orb.y, tucked);

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    suppressClick.current = false; // a touch drag never fires the click that would reset it
    const r = e.currentTarget.getBoundingClientRect();
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, moved: false };
    // From the press on, so a quick flick that leaves the Orb before it moves still ends here.
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || d.id !== e.pointerId || !el) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return;
      d.moved = true;
      el.dataset.dragging = '';
    }
    const x = Math.min(Math.max(e.clientX - d.ox, 4), window.innerWidth - ORB_SIZE - 4);
    const top = Math.min(Math.max(e.clientY - d.oy, 4), window.innerHeight - ORB_SIZE - 4);
    el.style.left = `${x}px`;
    el.style.top = `${top}px`;
  };

  const endDrag = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    const el = ref.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId || !el || !d.moved) return;
    suppressClick.current = true;
    delete el.dataset.dragging;
    const r = el.getBoundingClientRect();
    const { top: minTop, bottom } = probe.current!.getBoundingClientRect();
    const maxTop = bottom - ORB_SIZE;
    const side: OrbSide = r.left + ORB_SIZE / 2 < window.innerWidth / 2 ? 'left' : 'right';
    const frac = maxTop > minTop ? (r.top - minTop) / (maxTop - minTop) : 1;
    const next = Math.min(1, Math.max(0, frac));
    // Spring from where it was dropped to the dock (React may not touch these if nothing changed).
    const target = dockedOrbStyle(side, next, tucked);
    el.style.left = target.left;
    el.style.top = target.top;
    moveOrb(side, next);
  };

  const onClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    onToggle();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    // Arrow keys nudge the Orb between edges for keyboard users.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      moveOrb(e.key === 'ArrowLeft' ? 'left' : 'right', orb.y);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveOrb(orb.side, orb.y + (e.key === 'ArrowUp' ? -0.1 : 0.1));
    }
  };

  const style: CSSProperties = {
    ...docked,
    width: ORB_SIZE,
    height: ORB_SIZE,
    opacity: hidden || !orbLoaded ? 0 : 1,
    transform: hidden ? 'scale(.55)' : 'none',
    pointerEvents: hidden ? 'none' : 'auto',
    visibility: hidden ? 'hidden' : 'visible',
    transition: hidden
      ? 'opacity 220ms var(--ease), transform 280ms var(--ease), visibility 0s linear 280ms, left 560ms var(--ease-spring), top 560ms var(--ease-spring)'
      : 'opacity 360ms var(--ease) 60ms, transform 460ms var(--ease-spring) 40ms, visibility 0s, left 560ms var(--ease-spring), top 560ms var(--ease-spring)',
    touchAction: 'none',
  };

  return (
    <>
      {/* Measures the safe-area-aware range the Orb may occupy (for drop → fraction). */}
      <span
        ref={probe}
        aria-hidden="true"
        className="pointer-events-none fixed invisible"
        style={{ left: 0, width: 1, top: `calc(var(--safe-t) + ${ORB_MARGIN}px)`, bottom: `calc(var(--safe-b) + ${ORB_MARGIN}px)` }}
      />
      <button
        ref={ref}
        type="button"
        aria-label={panelOpen ? 'Close Orb' : unread ? 'Open Orb (new message)' : 'Open Orb'}
        aria-expanded={panelOpen}
        title="Orb  ·  ⌘K"
        className="group fixed z-40 rounded-full outline-none select-none data-[dragging]:!transition-none data-[dragging]:cursor-grabbing"
        style={style}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <span className="block transition-transform duration-300 ease-[var(--ease-spring)] group-hover:scale-[1.06] group-active:scale-95 group-data-[dragging]:scale-110">
          <OrbSphere size={ORB_SIZE} building={building} />
        </span>
        {/* Open, it says what a tap does now. */}
        <span
          aria-hidden="true"
          className={`absolute inset-0 flex items-center justify-center text-white drop-shadow-[0_1px_3px_rgba(20,10,60,.55)] transition-[opacity,transform] duration-300 ease-[var(--ease)] ${panelOpen ? 'opacity-100' : 'scale-75 opacity-0'}`}
        >
          <Icon name="x" size={22} strokeWidth={2.4} />
        </span>
        {unread && (
          <span className="animate-pop absolute top-0.5 right-0.5 h-3 w-3 rounded-full bg-[var(--iris-4)] shadow-[0_0_0_2.5px_white,0_2px_6px_rgba(255,80,160,.5)]" aria-hidden="true" />
        )}
      </button>
    </>
  );
}
