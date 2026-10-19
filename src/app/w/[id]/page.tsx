import type { Metadata } from 'next';
import Shell from '@/components/Shell';
import { getPublicWorld } from '@/server/worlds';

// A world page. The server renders public metadata (title, description, OG image) for link
// previews; the client then loads the full world with the device key to learn ownership and to
// reach private worlds.

async function load(id: string) {
  try {
    return await getPublicWorld(id);
  } catch (e) {
    console.error('[orb] getPublicWorld failed', e);
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const world = await load(id);
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

export default async function WorldPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const world = await load(id);
  // Code is fetched again client-side (with ownership); avoid shipping it twice in the HTML.
  const initial = world ? { ...world, code: null } : null;
  return <Shell mode="world" worldId={id} initialWorld={initial} />;
}
