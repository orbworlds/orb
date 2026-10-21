import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

type Variant = 'primary' | 'glass' | 'ghost' | 'iris';
type Size = 'sm' | 'md';

const base =
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium transition-[transform,background,box-shadow,opacity] duration-200 ease-[var(--ease)] active:scale-[.97] disabled:pointer-events-none disabled:opacity-45';
const variants: Record<Variant, string> = {
  primary: 'bg-ink text-paper shadow-[0_6px_20px_-6px_rgba(12,12,20,.45)] hover:opacity-90',
  glass: 'glass text-ink hover:bg-[var(--glass-bg-strong)]',
  ghost: 'text-ink-2 hover:bg-ink-4 hover:text-ink',
  // dark text, in both themes: white on the gradient's pale blue and peach is hard to read
  iris: 'font-semibold text-[#0c0c14] shadow-[0_8px_24px_-8px_rgba(139,123,255,.8)] [background:var(--iris)] hover:brightness-105',
};
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-10 px-4 text-[14px]',
};

export function Button({
  variant = 'glass',
  size = 'md',
  icon,
  children,
  className = '',
  ...rest
}: { variant?: Variant; size?: Size; icon?: IconName | string; children?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  size = 36,
  variant = 'ghost',
  className = '',
  ...rest
}: { icon: IconName | string; label: string; size?: number; variant?: Variant } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`${base} ${variants[variant]} shrink-0 ${className}`}
      style={{ width: size, height: size }}
      {...rest}
    >
      <Icon name={icon} size={Math.round(size * 0.48)} />
    </button>
  );
}
