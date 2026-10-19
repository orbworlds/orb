'use client';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { IconButton } from './Button';

/** Centered glass dialog (bottom sheet on small screens), named by its title. Closes on Esc and backdrop click. */
export function Modal({ open, onClose, title, children, width = 440 }: { open: boolean; onClose(): void; title?: ReactNode; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  // Focus the dialog when it opens (not on every parent render) and give focus back on close.
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      before?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined}>
      <div className="absolute inset-0 bg-[rgba(10,10,20,.28)] backdrop-blur-[2px] animate-fade-up" onClick={onClose} />
      <div
        ref={ref}
        tabIndex={-1}
        className="glass-strong animate-pop relative m-0 max-h-[88vh] w-full overflow-auto rounded-t-[var(--r-panel)] p-5 outline-none sm:m-4 sm:rounded-[var(--r-panel)] scroll-soft"
        style={{ maxWidth: width }}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div id={titleId} className="text-[15px] font-semibold">{title}</div>
          <IconButton icon="x" label="Close" size={32} onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}
