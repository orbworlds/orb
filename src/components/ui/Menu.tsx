'use client';
// Small glass dropdown menu. Closes on outside press, Esc, Tab, item select, or when focus moves
// into the world iframe. Arrow keys move between items.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Icon } from './Icon';

export interface MenuItem {
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

export interface MenuTriggerProps {
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
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) close();
    };
    const onBlur = () => close(); // focus went into the world iframe (or another window)
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
    // Focus the first item for keyboard users.
    requestAnimationFrame(() => (list.current?.querySelector('[role=menuitem]:not([disabled])') as HTMLElement | null)?.focus({ preventScroll: true }));
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
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
    if (e.key === 'Tab') return close();
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const els = Array.from(list.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled])') ?? []);
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : e.key === 'ArrowDown' ? (i + 1) % els.length : (i - 1 + els.length) % els.length;
    els[next].focus();
  };

  return (
    <span ref={wrap} className={`relative inline-flex ${className}`} onKeyDown={onKeyDown}>
      {renderTrigger({ onClick: toggle, 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': id }, open)}
      {open && (
        <div
          ref={list}
          id={id}
          role="menu"
          className={`glass-strong animate-pop scroll-soft absolute top-[calc(100%+8px)] z-[60] max-h-[min(70vh,520px)] overflow-y-auto rounded-[18px] p-1.5 ${align === 'end' ? 'right-0 origin-top-right' : 'left-0 origin-top-left'}`}
          style={{ width, maxWidth: 'calc(100vw - 24px)' }}
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
        </div>
      )}
    </span>
  );
}
