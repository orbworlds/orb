import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="fixed inset-0 flex items-center justify-center p-6" style={{ background: 'linear-gradient(180deg, #b9c6f2 0%, #e7d6ef 55%, #fde3cf 100%)' }}>
      <div className="glass-strong rounded-[var(--r-panel)] p-8 text-center">
        <div
          aria-hidden
          className="mx-auto mb-4 h-11 w-11 rounded-full"
          style={{ background: 'radial-gradient(circle at 32% 28%, #fff 0, rgba(255,255,255,.4) 18%, transparent 42%), var(--iris-conic)', boxShadow: '0 8px 30px -6px rgba(139,123,255,.6)' }}
        />
        <h1 className="font-display text-[32px] leading-tight">Nothing out here</h1>
        <p className="mt-2 text-[14px] text-ink-2">This page drifted off into the clouds.</p>
        <Link href="/" className="mt-5 inline-flex h-10 items-center rounded-full bg-ink px-5 text-[14px] font-medium text-paper">
          Make a world
        </Link>
      </div>
    </main>
  );
}
