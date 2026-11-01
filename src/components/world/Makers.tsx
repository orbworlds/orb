'use client';
// The others making a world with you right now (SPEC §2 "Making a world together"), each as their
// blob — its color and what it wears, as in worlds — glowing while their build changes the world:
// a few of them in the world bar, and over the chat's box, who is building and what.

import { Blob } from '@/components/orb/Blob';
import { hash } from '@/components/orb/WorldCard';
import { PLAYER_COLORS } from '@/lib/looks';
import type { WorldMaker } from '@/lib/types';
import { useTogether } from '@/state/together';

const colorOf = (m: WorldMaker): string => m.look.color ?? PLAYER_COLORS[hash(m.id) % PLAYER_COLORS.length];

/** "Ana", "Ana and Ben", "Ana and 3 others". */
function names(list: WorldMaker[]): string {
  if (list.length <= 2) return list.map((m) => m.name).join(' and ');
  return `${list[0].name} and ${list.length - 1} others`;
}

/** One maker as their blob's head, glowing while they build. */
function MakerBlob({ maker, size }: { maker: WorldMaker; size: number }) {
  return (
    <span className={`relative isolate inline-flex shrink-0 ${maker.building ? 'maker-building' : ''}`} title={maker.building ? `${maker.name} is building: ${maker.building}` : `${maker.name} is here`}>
      <Blob color={colorOf(maker)} wear={maker.look.wear} size={size} face label={maker.name} />
    </span>
  );
}

/** A few of the others here (those building first), for the world bar. */
export function MakersHere({ max = 4 }: { max?: number }) {
  const makers = useTogether((s) => s.makers);
  if (!makers.length) return null;
  const more = makers.length - max;
  const label = `${names(makers)} ${makers.length === 1 ? 'is' : 'are'} making it with you`;
  return (
    <span className="-my-1 flex shrink-0 items-center gap-1" role="img" aria-label={label} title={label}>
      <span className="flex items-end -space-x-1">
        {makers.slice(0, max).map((m) => (
          <MakerBlob key={m.id} maker={m} size={21} />
        ))}
      </span>
      {more > 0 && <span className="text-[11.5px] font-medium text-ink-2 tabular-nums">+{more}</span>}
    </span>
  );
}

/** Over the chat's box while others build: who, and (one of them) what. Nobody waits: their changes and yours go in together. */
export function BuildingNote() {
  const makers = useTogether((s) => s.makers);
  const building = makers.filter((m) => m.building);
  if (!building.length) return null;
  const one = building.length === 1 ? building[0] : null;
  return (
    <p className="animate-fade-up flex min-w-0 items-center gap-2 px-2 pb-1.5 text-[12.5px] text-ink-2" role="status">
      <span className="-my-1 flex shrink-0 items-end -space-x-1">
        {building.slice(0, 3).map((m) => (
          <MakerBlob key={m.id} maker={m} size={21} />
        ))}
      </span>
      <span className="min-w-0 truncate">
        {one ? (
          <>
            {one.name} is building: <span className="text-ink">{one.building}</span>
          </>
        ) : (
          `${names(building)} are building`
        )}
      </span>
    </p>
  );
}
