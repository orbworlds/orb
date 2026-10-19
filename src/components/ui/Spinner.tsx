export function Spinner({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 rounded-full ${className}`}
      style={{
        width: size,
        height: size,
        background: 'var(--iris-conic)',
        WebkitMask: `radial-gradient(farthest-side, transparent calc(100% - ${Math.max(2, size / 7)}px), #000 calc(100% - ${Math.max(2, size / 7)}px))`,
        mask: `radial-gradient(farthest-side, transparent calc(100% - ${Math.max(2, size / 7)}px), #000 calc(100% - ${Math.max(2, size / 7)}px))`,
        animation: 'orb-spin .9s linear infinite',
      }}
    />
  );
}
