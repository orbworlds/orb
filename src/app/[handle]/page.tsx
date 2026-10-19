import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import Shell from '@/components/Shell';
import { isPathPart, RESERVED } from '@/server/paths';
import { ready } from '@/server/schema';

// A maker's page, GitHub style: /<handle> (e.g. /max-builds) opens their profile over the start
// screen. A handle no one has is the site's 404.

const maker = cache(async (raw: string): Promise<{ handle: string; name: string } | null> => {
  const handle = raw.toLowerCase();
  if (!isPathPart(handle) || RESERVED.has(handle)) return null;
  try {
    const db = await ready();
    const rows = await db.query<{ name: string | null }>(
      `select coalesce(u.name, d.name, (select w.author_name from orb_worlds w where w.handle = h.handle order by w.updated_at desc limit 1)) as name
       from orb_handles h left join orb_users u on u.id = h.owner_user left join orb_devices d on d.hash = h.owner_device
       where h.handle = $1`,
      [handle],
    );
    return rows[0] ? { handle, name: rows[0].name?.trim() || handle } : null;
  } catch (e) {
    // The browser looks the profile up again (and says so if it can't).
    console.error('[orb] profile lookup failed', e);
    return { handle, name: handle };
  }
});

type Params = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const found = await maker((await params).handle);
  if (!found) return { title: { absolute: 'Nothing out here · Orb' }, robots: { index: false } };
  const description = `Worlds by ${found.name} on Orb. Play them, add ${found.name} as a friend, then make your own by chatting.`;
  return {
    title: found.name,
    description,
    alternates: { canonical: `/${found.handle}` },
    openGraph: { title: `${found.name} on Orb`, description, type: 'profile' },
  };
}

export default async function ProfilePage({ params }: Params) {
  const found = await maker((await params).handle);
  if (!found) notFound();
  return <Shell mode="start" initialProfile={found.handle} />;
}
