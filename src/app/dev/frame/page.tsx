// Dev-only harness for the world runtime (WorldFrame + orb runtime + bridge).
// Used manually (sample worlds, event log) and by scripts/test-runtime.mjs (window.__orbHarness).
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Harness from './Harness';

export const metadata: Metadata = { title: 'Runtime harness', robots: { index: false, follow: false } };

export default async function DevFramePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const sp = await searchParams;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string') params[k] = v;
  return <Harness params={params} />;
}
