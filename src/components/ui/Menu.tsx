'use client';
// Small glass dropdown menu. Closes on outside press, Esc, Tab, item select, scrolling, or when focus
// moves into the world iframe. Arrow keys move between items. It opens on the page itself (a panel
// only as tall as what it holds doesn't clip it), under its button or, with more room there, above it.
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

/** Below this much room under its button, a menu opens above it (when there's more room there). */
const ROOM = 320;
const EDGE = 12;

interface MenuItem {
  kind?: 'item';
  label: ReactNode;
  icon?: string;
  /** Secondary text on the right (or under the label with `stacked`). */
  hint?: ReactNode;
  onSelect(): void;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  /** Show the hint as a second line under the label. */
  stacked?: boolean;
}
export type MenuEntry = MenuItem | { kind: 'label'; label: ReactNode } | { kind: 'separator' };

interface MenuTriggerProps {
  onClick(): void;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string;
}

export function Menu({
  items,
  renderTrigger,
  align = 'start',
  width = 248,
  className = '',
}: {
  /** Entries, or a function evaluated each time the menu opens (for fresh local data). */
  items: MenuEntry[] | (() => MenuEntry[]);
  renderTrigger(props: MenuTriggerProps, open: boolean): ReactNode;
  align?: 'start' | 'end';
  width?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<MenuEntry[]>([]);
  const [place, setPlace] = useState<{ style: CSSProperties; up: boolean }>({ style: {}, up: false });
  const wrap = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) (wrap.current?.querySelector('button') as HTMLButtonElement | null)?.focus();
  }, []);

  const toggle = () => {
    if (open) return close();
    setEntries(typeof items === 'function' ? items() : items);
    const r = wrap.current!.getBoundingClientRect();
    const below = innerHeight - r.bottom;
    const up = below < ROOM && r.top > below;
    const x = align === 'end' ? Math.min(r.right, innerWidth - EDGE) - width : r.left;
    setPlace({
      up,
      style: {
        ...(up ? { bottom: innerHeight - r.top + 8 } : { top: r.bottom + 8 }),
        left: Math.max(EDGE, Math.min(x, innerWidth - width - EDGE)),
        maxHeight: Math.min(520, (up ? r.top : below) - 8 - EDGE),
      },
    });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => !wrap.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node);
    const onDown = (e: PointerEvent) => outside(e) && close();
    const onScroll = (e: Event) => outside(e) && close(); // it stays where it opened
    const onBlur = () => close(); // focus went into the world iframe (or another window)
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onBlur);
    window.addEventListener('blur', onBlur);
    // Focus the first item for keyboard users.
    requestAnimationFrame(() => (list.current?.querySelector('[role=menuitem]:not([disabled])') as HTMLElement | null)?.focus({ preventScroll: true }));
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onBlur);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, close]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === 'Tab') return close(true); // from the button on, as if the menu had been next to it
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const els = Array.from(list.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled])') ?? []);
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : e.key === 'ArrowDown' ? (i + 1) % els.length : (i - 1 + els.length) % els.length;
    els[next].focus();
  };

  return (
    <span ref={wrap} className={`inline-flex ${className}`} onKeyDown={onKeyDown}>
      {renderTrigger({ onClick: toggle, 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': id }, open)}
      {open &&
        createPortal(
          <div
            ref={list}
            id={id}
            role="menu"
            className={`glass-strong animate-pop scroll-soft fixed z-[85] overflow-y-auto rounded-[18px] p-1.5 ${place.up ? (align === 'end' ? 'origin-bottom-right' : 'origin-bottom-left') : align === 'end' ? 'origin-top-right' : 'origin-top-left'}`}
            style={{ ...place.style, width, maxWidth: `calc(100vw - ${EDGE * 2}px)` }}
          >
            {entries.map((e, i) => {
              if (e.kind === 'separator') return <div key={i} role="separator" className="mx-2 my-1.5 h-px bg-ink-4" />;
              if (e.kind === 'label')
                return (
                  <div key={i} className="px-3 pt-2 pb-1 text-[11.5px] font-medium tracking-[.02em] text-ink-3">
                    {e.label}
                  </div>
                );
              return (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  disabled={e.disabled}
                  onClick={() => {
                    close();
                    e.onSelect();
                  }}
                  className={`flex w-full items-center gap-3 rounded-[12px] px-3 text-left text-[14px] outline-none transition-colors duration-150 hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none disabled:opacity-40 ${e.stacked ? 'min-h-12 py-1.5' : 'min-h-10'} ${e.danger ? 'text-[var(--bad)]' : 'text-ink'}`}
                >
                  {e.icon && <Icon name={e.icon} size={16} className={e.danger ? '' : 'text-ink-2'} />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{e.label}</span>
                    {e.stacked && e.hint && <span className="block truncate text-[12px] text-ink-3">{e.hint}</span>}
                  </span>
                  {!e.stacked && e.hint && <span className="shrink-0 text-[12px] text-ink-3">{e.hint}</span>}
                  {e.checked && <Icon name="check" size={15} className="shrink-0 text-ink-2" />}
                </button>
              );
            })}
          </div>,
        document.body,
      )}
    </span>
  );
}
