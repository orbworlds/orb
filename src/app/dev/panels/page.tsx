// Dev-only preview of the Explore / You / Share / History / Code panels with fixture data
// (used for design review screenshots). Not available in production.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Preview from './Preview';

export const metadata: Metadata = { title: 'Panels preview', robots: { index: false, follow: false } };

export default async function DevPanelsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const sp = await searchParams;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string') params[k] = v;
  return <Preview params={params} />;
}
