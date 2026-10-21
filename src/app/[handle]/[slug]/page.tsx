import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import Shell from '@/components/Shell';
import { resolvePath } from '@/server/paths';
import { ready } from '@/server/schema';
import { getPublicWorld } from '@/server/worlds';
import { worldMetadata } from '../../w/[id]/world-metadata';

// A world at its readable URL, GitHub style: /<owner>/<world> (e.g. /orb/wish-lanterns).
// Same page as /w/<id>; any path the world ever had still leads here. A path no world has (private
// ones included) is the site's 404.

const load = cache(async (handle: string, slug: string) => {
  try {
    const id = await resolvePath(await ready(), handle.toLowerCase(), slug.toLowerCase());
    return { id, world: id ? await getPublicWorld(id) : null, failed: false };
  } catch (e) {
    console.error('[orb] world path lookup failed', e);
    return { id: null, world: null, failed: true };
  }
});

type Params = { params: Promise<{ handle: string; slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle, slug } = await params;
  const { id, world, failed } = await load(handle, slug);
  if (!id && !failed) notFound();
  return worldMetadata(world);
}

export default async function WorldPathPage({ params }: Params) {
  const { handle, slug } = await params;
  const { id, world, failed } = await load(handle, slug);
  if (!id && !failed) notFound();
  // Code is fetched again client-side (with ownership); avoid shipping it twice in the HTML.
  const initial = world ? { ...world, code: null } : null;
  // The lookup failed? The page looks the address up again from the browser (and says "not found"
  // only if that fails too).
  return <Shell mode="world" worldId={id ?? undefined} worldPath={id ? undefined : `${handle}/${slug}`} initialWorld={initial} />;
}
