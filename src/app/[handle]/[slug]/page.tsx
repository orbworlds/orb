import type { Metadata } from 'next';
import Shell from '@/components/Shell';
import { resolvePath } from '@/server/paths';
import { ready } from '@/server/schema';
import { getPublicWorld } from '@/server/worlds';

// A world at its readable URL, GitHub style: /<owner>/<world> (e.g. /orb/wish-lanterns).
// Same page as /w/<id>; any path the world ever had still leads here.

async function load(handle: string, slug: string) {
  try {
    const id = await resolvePath(await ready(), handle.toLowerCase(), slug.toLowerCase());
    if (!id) return { id: null, world: null };
    return { id, world: await getPublicWorld(id) };
  } catch (e) {
    console.error('[orb] world path lookup failed', e);
    return { id: null, world: null };
  }
}

type Params = { params: Promise<{ handle: string; slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle, slug } = await params;
  const { world } = await load(handle, slug);
  if (!world) return { title: { absolute: 'A world on Orb' }, robots: { index: false } };
  const description = world.description || `A world by ${world.authorName} on Orb. Play it, then remix it by chatting.`;
  return {
    title: world.name,
    description,
    alternates: world.path ? { canonical: `/${world.path}` } : undefined,
    openGraph: { title: world.name, description, type: 'website' },
    twitter: { card: 'summary_large_image', title: world.name, description },
  };
}

export default async function WorldPathPage({ params }: Params) {
  const { handle, slug } = await params;
  const { id, world } = await load(handle, slug);
  // Code is fetched again client-side (with ownership); avoid shipping it twice in the HTML.
  const initial = world ? { ...world, code: null } : null;
  // Not found here? The page looks the address up again from the browser (and says "not found"
  // only if that fails too).
  return <Shell mode="world" worldId={id ?? undefined} worldPath={id ? undefined : `${handle}/${slug}`} initialWorld={initial} />;
}
