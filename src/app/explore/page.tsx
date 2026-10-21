import type { Metadata } from 'next';
import Shell from '@/components/Shell';

export const metadata: Metadata = {
  title: 'Explore worlds',
  description: 'Play games, wander worlds and remix toys made by people on Orb.',
};

// The home page at its worlds, all of them, as the address asks (?filter=…&sort=…&q=…): the server
// renders the same filter, sort and search the browser starts with.
export default async function ExplorePage({ searchParams }: PageProps<'/explore'>) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return <Shell mode="explore" explore={{ filter: one(sp.filter), sort: one(sp.sort), q: one(sp.q)?.slice(0, 100) }} />;
}
