'use client';
// A world's remixes: the public ones their makers changed, newest first. Its remix tree one level
// down; each remix's bar says what it came from, so the tree can be walked both ways.
import { useEffect, useState } from 'react';
import { track } from '@/lib/analytics';
import { api } from '@/lib/api';
import type { WorldCard as WorldCardData } from '@/lib/types';
import { Modal } from '@/components/ui/Modal';
import { WorldCard, WorldCardSkeleton } from '@/components/orb/WorldCard';

export function RemixesSheet({ world, onClose, onOpenWorld }: { world: { id: string; name: string } | null; onClose(): void; onOpenWorld(id: string): void }) {
  return (
    <Modal open={!!world} onClose={onClose} title={world ? `Remixes of “${world.name}”` : 'Remixes'} width={520}>
      {world && (
        <RemixesBody
          key={world.id}
          id={world.id}
          onOpen={(id) => {
            track('world_open', { world_id: id, source: 'remixes' });
            onClose();
            onOpenWorld(id);
          }}
        />
      )}
    </Modal>
  );
}

const note = 'rounded-[18px] px-5 py-6 text-center text-[13px] text-ink-2 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ink)_10%,transparent)]';

function RemixesBody({ id, onOpen }: { id: string; onOpen(id: string): void }) {
  const [worlds, setWorlds] = useState<WorldCardData[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .remixes(id)
      .then((r) => live && setWorlds(r.worlds))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [id]);

  if (failed) return <p className={note}>Couldn’t load the remixes. Try again in a moment.</p>;
  if (!worlds)
    return (
      <div className="grid grid-cols-2 gap-x-4 gap-y-5" aria-busy="true">
        <WorldCardSkeleton />
        <WorldCardSkeleton />
      </div>
    );
  if (!worlds.length) return <p className={note}>No remixes yet. Remix it and make it your own!</p>;
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-5">
      {worlds.map((w) => (
        <WorldCard key={w.id} world={w} onOpen={onOpen} />
      ))}
    </div>
  );
}
