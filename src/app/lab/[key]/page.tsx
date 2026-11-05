import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LAB_KEY } from '@/server/lab';
import { ready } from '@/server/schema';
import { listWorlds } from '@/server/worlds';
import { HiddenWorlds } from './HiddenWorlds';

// A secret page with the worlds kept out of Explore: curated ones that don't hold up (seeds marked
// `hidden`), and people's worlds hidden by hand here or by the script check. They still play by link;
// this lists them for a second look, hides more by their links, and lets one back in.

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Hidden worlds' };

export default async function HiddenWorldsPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (key !== LAB_KEY) notFound();
  const db = await ready();
  const { worlds } = await listWorlds(db, { deviceHash: null, deviceId: null, userId: null }, { sort: 'featured', hidden: true, limit: 200 });
  return <HiddenWorlds worlds={worlds} />;
}
