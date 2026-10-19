'use client';
import { useToasts } from '@/state/toast';
import { Icon } from './Icon';

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[max(16px,env(safe-area-inset-top))] z-[90] flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div key={t.id} className="glass-strong animate-pop pointer-events-auto flex items-center gap-2.5 rounded-full py-2 pr-2 pl-4 text-[14px]" role="status">
          {t.tone === 'success' && <Icon name="check" size={16} className="text-[var(--ok)]" />}
          {t.tone === 'error' && <span className="h-2 w-2 rounded-full bg-[var(--bad)]" />}
          <span>{t.text}</span>
          {t.action && (
            <button className="rounded-full bg-ink px-3 py-1 text-[13px] font-medium text-paper" onClick={() => { t.action!.onClick(); dismiss(t.id); }}>
              {t.action.label}
            </button>
          )}
          {!t.action && <span className="w-2" />}
        </div>
      ))}
    </div>
  );
}
