import type { Metadata } from 'next';

export const metadata: Metadata = { robots: { index: false, follow: false } };

// The app keeps the page itself still (body doesn't scroll), so these long pages scroll here.
export default function LabLayout({ children }: { children: React.ReactNode }) {
  return <div className="fixed inset-0 overflow-y-auto overscroll-contain">{children}</div>;
}
