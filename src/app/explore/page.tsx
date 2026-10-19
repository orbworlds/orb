import type { Metadata } from 'next';
import Shell from '@/components/Shell';

export const metadata: Metadata = {
  title: 'Explore worlds',
  description: 'Play games, wander worlds and remix toys made by people on Orb.',
};

export default function ExplorePage() {
  return <Shell mode="explore" />;
}
