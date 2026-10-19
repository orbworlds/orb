import type { MetadataRoute } from 'next';
import { SITE } from '@/lib/site';
import { ready } from '@/server/schema';
import { listedPaths } from '@/server/worlds';

// Read at request time (crawlers fetch it rarely): builds never need the database for it.
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages: MetadataRoute.Sitemap = [
    { url: SITE, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE}/explore`, changeFrequency: 'daily', priority: 0.9 },
    { url: `${SITE}/pricing`, changeFrequency: 'monthly', priority: 0.5 },
  ];
  try {
    const worlds = await listedPaths(await ready());
    return [...pages, ...worlds.map((w) => ({ url: `${SITE}/${w.path}`, ...(w.updatedAt ? { lastModified: w.updatedAt } : {}) }))];
  } catch (e) {
    console.error('[orb] sitemap worlds failed', e);
    return pages;
  }
}
