import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import Shell from '@/components/Shell';
import { ready } from '@/server/schema';
import { getPublicWorld, isWorldId } from '@/server/worlds';
import { worldMetadata } from './world-metadata';

// A world page. The server renders public metadata (title, description, OG image) for link
// previews; the client then loads the full world with the device key to learn ownership and to
// reach private worlds. An id no world has is the site's 404.

const load = cache(async (id: string) => {
  if (!isWorldId(id)) return { world: null, missing: true };
  try {
    const world = await getPublicWorld(id);
    if (world) return { world, missing: false };
    // A private world: only its maker's browser can open it, so the page asks again from there.
    const rows = await (await ready()).query(`select 1 from orb_worlds where id = $1`, [id]);
    return { world: null, missing: rows.length === 0 };
  } catch (e) {
    console.error('[orb] getPublicWorld failed', e);
    return { world: null, missing: false };
  }
});

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { world, missing } = await load((await params).id);
  if (missing) notFound();
  return worldMetadata(world);
}

export default async function WorldPage({ params }: Params) {
  const { id } = await params;
  const { world, missing } = await load(id);
  if (missing) notFound();
  // Code is fetched again client-side (with ownership); avoid shipping it twice in the HTML.
  const initial = world ? { ...world, code: null } : null;
  return <Shell mode="world" worldId={id} initialWorld={initial} />;
}
