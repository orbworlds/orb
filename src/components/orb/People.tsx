'use client';
// How people show up around Orb: an avatar (with a green dot while they're online) and the line
// that says where a friend is.

import type { Friend, Person } from '@/lib/types';
import { Avatar } from '@/components/ui/Avatar';
import { hash, timeAgo } from './WorldCard';

const COLORS = ['#8b7bff', '#5ec8ff', '#ffb38a', '#ff8fc8', '#7ee0b8', '#ffd36e', '#a0a8ff', '#ff9e7a'];

/** The same color for the same person everywhere. */
const colorFor = (seed: string) => COLORS[hash(seed) % COLORS.length];

export function PersonAvatar({ person, size = 36, online = false }: { person: Pick<Person, 'id' | 'name'>; size?: number; online?: boolean }) {
  const dot = Math.max(8, Math.round(size * 0.3));
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar name={person.name} color={colorFor(person.id)} size={size} />
      {online && (
        <span
          aria-hidden="true"
          className="absolute right-0 bottom-0 rounded-full bg-[var(--ok)] shadow-[0_0_0_2px_var(--glass-bg-strong,white)]"
          style={{ width: dot, height: dot }}
        />
      )}
    </span>
  );
}

/** "Playing Cloud Castle", "Making Moon Base", "Online", "Last seen 2 hours ago"… */
export function whereIs(f: Pick<Friend, 'world' | 'own' | 'online' | 'seenAt'>): string {
  if (f.world) return `${f.own ? 'Making' : 'Playing'} ${f.world.name}`;
  if (f.online) return 'Online';
  if (f.seenAt) return `Last seen ${timeAgo(f.seenAt)}`;
  return 'Not on Orb lately';
}
