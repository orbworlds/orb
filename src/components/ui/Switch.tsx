'use client';

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange(v: boolean): void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40 ${checked ? 'bg-ink' : 'bg-ink-4'}`}
    >
      <span
        className="absolute top-[3px] left-[3px] h-5 w-5 rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,.25)] transition-transform duration-300 ease-[var(--ease-spring)]"
        style={{ transform: checked ? 'translateX(18px)' : 'none' }}
      />
    </button>
  );
}
