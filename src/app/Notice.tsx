import type { ReactNode } from 'react';
import { OrbSphere } from '@/components/orb/Orb';

// The card Orb's own pages show instead of what was asked for: a page that isn't there
// (./not-found.tsx) or one that broke (./error.tsx). On the sky, in either scheme, like a missing world.
export function Notice({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <main className="sky fixed inset-0 flex items-center justify-center p-6">
      <div className="glass-strong animate-pop max-w-sm rounded-[var(--r-panel)] p-7 text-center">
        <OrbSphere size={44} className="mx-auto mb-4" />
        <h1 className="font-display text-[30px] leading-tight">{title}</h1>
        <p className="mt-2 text-[14px] text-ink-2">{text}</p>
        <div className="mt-5 flex justify-center gap-2">{children}</div>
      </div>
    </main>
  );
}
