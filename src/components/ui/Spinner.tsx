export function Spinner({ size = 16 }: { size?: number }) {
  const ring = Math.max(2, size / 7);
  const mask = `radial-gradient(farthest-side, transparent calc(100% - ${ring}px), #000 calc(100% - ${ring}px))`;
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: 'var(--iris-conic)', WebkitMask: mask, mask, animation: 'orb-spin .9s linear infinite' }}
    />
  );
}
