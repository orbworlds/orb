import type { Metadata } from 'next';
import type { WorldFull } from '@/lib/types';

/** What a world's page says in a tab and a link preview: "<Name> by <maker> · Orb", its description. */
export function worldMetadata(world: WorldFull | null): Metadata {
  if (!world) return { title: { absolute: 'A world on Orb' }, robots: { index: false } };
  const description = world.description || `A world by ${world.authorName} on Orb. Play it, then remix it by chatting.`;
  return {
    title: world.authorName ? `${world.name} by ${world.authorName}` : world.name,
    description,
    alternates: world.path ? { canonical: `/${world.path}` } : undefined,
    openGraph: { title: world.name, description, type: 'website' },
    twitter: { card: 'summary_large_image', title: world.name, description },
  };
}
