'use client';

import { useRouter } from 'next/navigation';
import { WorldCard } from '@/components/orb/WorldCard';
import type { WorldCard as WorldCardData } from '@/lib/types';
import { TITLE } from './pulse/ui';

export function HiddenWorlds({ worlds }: { worlds: WorldCardData[] }) {
  const router = useRouter();
  return (
    <main className="mx-auto w-full max-w-[1320px] px-4 pt-[max(28px,env(safe-area-inset-top))] pb-[max(48px,env(safe-area-inset-bottom))] sm:px-8 sm:pt-10 lg:px-12">
      <h1 className={TITLE}>Hidden worlds</h1>
      <p className="mt-3 text-[14.5px] text-ink-2">
        {worlds.length} worlds kept out of Explore. They still play by link.
      </p>
      <div className="mt-8 grid grid-cols-1 gap-x-5 gap-y-8 min-[520px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 xl:gap-x-6">
        {worlds.map((w) => (
          <WorldCard key={w.id} world={w} onOpen={(id) => router.push(`/w/${encodeURIComponent(id)}`)} />
        ))}
      </div>
    </main>
  );
}
