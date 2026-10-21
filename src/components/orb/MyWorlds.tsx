'use client';
// "Your worlds" list in the You tab: worlds owned by this device / account (incl. private and
// untitled ones), as compact rows → onOpenWorld(id).

import { useEffect, useRef, useState } from 'react';
import { track } from '@/lib/analytics';
import { api, worldHref } from '@/lib/api';
import type { WorldCard } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { toast } from '@/state/toast';
import { useUi } from '@/state/ui';
import { useMe } from './AccountCard';
import { EmptyNote, groupClass, onPlainClick, playsLabel, SectionHeader, Skeleton, Thumb, timeAgo } from './WorldCard';

const PAGE = 12;
const MINE = { mine: true };
const LIKED = { liked: true };

interface ListState {
  key: string;
  worlds: WorldCard[];
  cursor?: string;
  error: boolean;
}

export function MyWorlds({ onOpenWorld, onNewWorld, liked = false }: { onOpenWorld(id: string): void; onNewWorld?(): void; /** Worlds the viewer ♥'d instead of their own. */ liked?: boolean }) {
  const { me, status: meStatus } = useMe();
  const [nonce, setNonce] = useState(0);
  const query = liked ? LIKED : MINE;
  // A ♥ anywhere refreshes the liked list.
  useEffect(() => {
    if (!liked) return;
    const on = () => setNonce((n) => n + 1);
    window.addEventListener('orb:likes-changed', on);
    return () => window.removeEventListener('orb:likes-changed', on);
  }, [liked]);
  // Refetch when the identity changes (signing in claims this device's worlds).
  const key = `${me?.user?.id ?? me?.deviceId ?? ''}:${nonce}`;
  const [state, setState] = useState<ListState | null>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const current = state?.key === key ? state : null;

  useEffect(() => {
    if (meStatus === 'loading' || meStatus === 'idle') return;
    let alive = true;
    api
      .listWorlds({ ...query, limit: PAGE })
      .then((r) => alive && setState({ key, worlds: r.worlds, cursor: r.nextCursor, error: false }))
      .catch(() => alive && setState({ key, worlds: [], error: true }));
    return () => {
      alive = false;
    };
  }, [key, meStatus, query]);

  const loadMore = async () => {
    if (!current?.cursor || more === 'loading') return;
    setMore('loading');
    try {
      const r = await api.listWorlds({ ...query, limit: PAGE, cursor: current.cursor });
      setState((s) => {
        if (!s || s.key !== key) return s;
        const seen = new Set(s.worlds.map((w) => w.id));
        return { ...s, worlds: [...s.worlds, ...r.worlds.filter((w) => !seen.has(w.id))], cursor: r.nextCursor };
      });
      setMore('idle');
    } catch {
      setMore('error');
    }
  };

  const count = current && !current.error ? current.worlds.length : 0;
  const open = (id: string) => {
    track('world_open', { world_id: id, source: liked ? 'liked' : 'my_worlds' });
    onOpenWorld(id);
  };

  return (
    <section aria-labelledby={liked ? 'orb-liked-h' : 'orb-mine-h'}>
      <SectionHeader
        id={liked ? 'orb-liked-h' : 'orb-mine-h'}
        title={liked ? 'Worlds you ♥' : 'Your worlds'}
        accessory={
          onNewWorld ? (
            <Button variant="glass" size="sm" icon="plus" onClick={onNewWorld} className="mb-0.5">
              New world
            </Button>
          ) : count > 0 ? (
            <span className="mb-0.5 text-[13px] text-ink-3 tabular-nums">{current?.cursor ? `${count}+` : count}</span>
          ) : undefined
        }
      />

      {!current ? (
        <div className={`${groupClass} p-1.5`} aria-busy="true" aria-label="Loading your worlds">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 px-2 py-2">
              <Skeleton className="h-[45px] w-[72px] shrink-0 rounded-[10px]" />
              <div className="min-w-0 flex-1">
                <Skeleton className="h-3.5 w-1/2 rounded-full" />
                <Skeleton className="mt-2 h-3 w-1/3 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      ) : current.error ? (
        <div className={`${groupClass} flex items-center gap-3 px-4 py-3.5`}>
          <p className="min-w-0 flex-1 text-[13px] text-ink-2">Couldn’t load your worlds.</p>
          <Button variant="glass" size="sm" icon="refresh" onClick={() => setNonce((n) => n + 1)}>
            Retry
          </Button>
        </div>
      ) : current.worlds.length === 0 ? (
        <EmptyNote icon="sparkle" title={liked ? 'No favorites yet' : 'No worlds yet'} text={liked ? 'Tap ♥ on worlds you love to keep them here.' : 'Your worlds will show up here.'} />
      ) : (
        <div className={`${groupClass} p-1.5`}>
          <ul>
            {current.worlds.map((w) => (
              <li key={w.id}>
                <WorldRow world={w} onOpen={open} />
              </li>
            ))}
          </ul>
          {current.cursor && (
            <div className="px-1 pt-1 pb-0.5">
              <button
                type="button"
                onClick={loadMore}
                disabled={more === 'loading'}
                className="flex h-9 w-full items-center justify-center gap-2 rounded-[12px] text-[13px] font-medium text-ink-2 transition-colors hover:bg-[color-mix(in_oklab,var(--ink)_5%,transparent)] hover:text-ink focus-visible:rounded-[12px]"
              >
                {more === 'loading' ? <Spinner size={14} /> : null}
                {more === 'error' ? 'Couldn’t load more — try again' : 'Show more'}
              </button>
            </div>
          )}
        </div>
      )}
      {!liked && <ImportRow onImported={onOpenWorld} />}
    </section>
  );
}

/** Bring an open-source web project in from GitHub as a new world of your own. */
function ImportRow({ onImported }: { onImported(id: string): void }) {
  // A link asked for a repository (?import=, src/state/links.ts) and opened the You tab: it waits
  // in the form for a tap on Import.
  const [asked] = useState(() => useUi.getState().importUrl);
  const [open, setOpen] = useState(!!asked);
  const [url, setUrl] = useState(asked ?? '');
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!asked) return;
    useUi.getState().setImportUrl(null);
    requestAnimationFrame(() => form.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }, [asked]);
  const submit = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.importRepo(url.trim());
      track('world_import', { world_id: r.world.id, files: r.files });
      toast(`Imported “${r.world.name}” (${r.files} files) ✨`, 'success');
      if (r.warning) toast(r.warning, 'default');
      setOpen(false);
      setUrl('');
      onImported(r.world.id);
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Couldn’t import that repository.', 'error');
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-2 flex items-center gap-1.5 px-1 text-[12.5px] font-medium text-ink-2 hover:text-ink">
        <Icon name="code" size={13} /> Import a project from GitHub
      </button>
    );
  return (
    <form
      ref={form}
      className="mt-2 flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        autoFocus
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://github.com/owner/repo"
        aria-label="GitHub repository link"
        className="h-9 min-w-0 flex-1 rounded-[12px] bg-[var(--field-bg)] px-3 text-[13px] text-ink placeholder:text-ink-3"
      />
      <Button variant="glass" size="sm" type="submit" disabled={busy || !url.trim()}>
        {busy ? <Spinner size={14} /> : 'Import'}
      </Button>
    </form>
  );
}

function WorldRow({ world, onOpen }: { world: WorldCard; onOpen(id: string): void }) {
  const isPrivate = world.visibility === 'private';
  return (
    <a
      href={worldHref(world)}
      onClick={onPlainClick(() => onOpen(world.id))}
      className="group flex w-full items-center gap-3 rounded-[13px] px-2 py-2 text-left transition-colors duration-200 hover:bg-[color-mix(in_oklab,var(--ink)_5%,transparent)] focus-visible:rounded-[13px] focus-visible:outline-offset-0"
    >
      <Thumb src={world.thumbUrl} seed={world.id} name={world.name} initialSize={20} className="h-[45px] w-[72px] shrink-0 rounded-[10px]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-ink">{world.name || 'Untitled world'}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-ink-2">
          <span className="truncate">Edited {timeAgo(world.updatedAt)}</span>
          {world.plays > 0 && (
            <>
              <span aria-hidden="true" className="text-ink-3">
                ·
              </span>
              <span className="shrink-0 tabular-nums">{playsLabel(world.plays)}</span>
            </>
          )}
        </span>
      </span>
      <span
        className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-[3px] text-[11.5px] font-medium ${isPrivate ? 'bg-[var(--field-bg)] text-ink-2' : 'bg-[color-mix(in_oklab,var(--iris-2)_16%,transparent)] text-[color-mix(in_oklab,var(--iris-2)_55%,var(--ink))]'}`}
      >
        <Icon name={isPrivate ? 'lock' : 'globe'} size={11} strokeWidth={2} />
        {isPrivate ? 'Private' : 'Public'}
      </span>
    </a>
  );
}
