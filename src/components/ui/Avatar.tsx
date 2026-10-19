export function Avatar({ name, color, size = 28 }: { name: string; color?: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `radial-gradient(circle at 30% 25%, rgba(255,255,255,.55), transparent 55%), ${color || 'var(--iris-1)'}`,
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.35)',
      }}
    >
      {initials}
    </span>
  );
}
