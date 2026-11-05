'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { WorldCard } from '@/components/orb/WorldCard';
import type { WorldCard as WorldCardData } from '@/lib/types';
import { TITLE } from './pulse/ui';

/** Worlds kept out of Explore: hide more by their links, or let one back in. */
export function HiddenWorlds({ worlds }: { worlds: WorldCardData[] }) {
  const router = useRouter();
  const { key } = useParams<{ key: string }>();
  const [links, setLinks] = useState('');
  const [note, setNote] = useState('');
  const hide = async (refs: string, hidden: boolean) => {
    const r = await fetch(`/lab/${key}/hide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worlds: refs, hidden }) });
    const ids = r.ok ? ((await r.json()) as { ids: string[] }).ids : null;
    setNote(ids ? `${ids.length} ${ids.length === 1 ? 'world' : 'worlds'} ${hidden ? 'hidden' : 'back in Explore'}.` : await r.text());
    if (ids?.length) router.refresh();
    return !!ids;
  };
  return (
    <main className="mx-auto w-full max-w-[1320px] px-4 pt-[max(28px,env(safe-area-inset-top))] pb-[max(48px,env(safe-area-inset-bottom))] sm:px-8 sm:pt-10 lg:px-12">
      <h1 className={TITLE}>Hidden worlds</h1>
      <p className="mt-3 text-[14.5px] text-ink-2">
        {worlds.length} worlds hidden. They still play by link. Curated ones stay out of Explore; one made on Orb is listed under “hidden” after Explore’s worlds while it’s very poor (under 2 plays and 5 changes), and comes back once people play it or its maker keeps building.
      </p>
      <form
        className="mt-6 flex max-w-[640px] flex-col gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (links.trim() && (await hide(links, true))) setLinks('');
        }}
      >
        <textarea
          value={links}
          onChange={(e) => setLinks(e.target.value)}
          rows={3}
          placeholder="Links or ids of worlds to hide, one per line"
          className="rounded-[12px] border border-[var(--ink-5)] bg-transparent px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-3 focus:border-[var(--ink-3)]"
        />
        <div className="flex items-center gap-3">
          <button type="submit" className="h-9 rounded-full bg-[var(--ink)] px-4 text-[13.5px] font-medium text-[var(--paper)] disabled:opacity-40" disabled={!links.trim()}>
            Hide from Explore
          </button>
          {note && <span className="text-[13px] text-ink-2">{note}</span>}
        </div>
      </form>
      <div className="mt-8 grid grid-cols-1 gap-x-5 gap-y-8 min-[520px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 xl:gap-x-6">
        {worlds.map((w) => (
          <div key={w.id}>
            <WorldCard world={w} onOpen={(id) => router.push(`/w/${encodeURIComponent(id)}`)} />
            <button type="button" onClick={() => void hide(w.id, false)} className="mt-2 text-[13px] text-ink-2 underline-offset-2 hover:text-ink hover:underline">
              Back into Explore
            </button>
          </div>
        ))}
      </div>
    </main>
  );
}
