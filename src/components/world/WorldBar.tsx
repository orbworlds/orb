'use client';
// The world's row at the top of the Orb panel (nothing floats over the world itself, whose own UI
// often lives in the corners): the way back to Explore (on a phone, at the sheet's full height), its
// name, and its maker and what it was remixed from (and who's here). Owners rename (inline or under
// "⋯"), share, and find the rest under "⋯"; visitors like and remix.
import { track } from '@/lib/analytics';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, IconButton } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Menu, type MenuEntry } from '@/components/ui/Menu';
import { Modal } from '@/components/ui/Modal';
import { api } from '@/lib/api';
import type { WorldFull, WorldRepo } from '@/lib/types';
import { PersonAvatar } from '@/components/orb/People';
import { formatCount, platformName } from '@/components/orb/WorldCard';
import { useFriends } from '@/state/friends';
import { useClip } from '@/state/clips';
import { copyLink, downloadZip, shareUrl } from '@/state/share';
import { toast } from '@/state/toast';
import { useIsMobile, useUi } from '@/state/ui';
import { useWorld } from '@/state/world';
import { RemixesSheet } from './RemixesSheet';

export interface WorldBarActions {
  onExplore(): void;
  onShare(): void;
  onHistory(): void;
  onOpenWorld(id: string): void;
  /** Start a new chat about this world (while the current one has messages and nothing builds). */
  onNewChat?(): void;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Fullscreen the whole app (the world fills the screen; the Orb stays reachable). */
function canFullscreen(): boolean {
  return typeof document !== 'undefined' && !!document.documentElement.requestFullscreen;
}
function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen?.();
  else void document.documentElement.requestFullscreen?.().catch(() => toast("Fullscreen isn't available here."));
}

/** Share a world's link: the phone's share sheet when available, else (or when it can't open) copy it. */
async function shareWorldLink(world: WorldFull): Promise<void> {
  const url = shareUrl(world);
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ title: world.name, url });
      track('share_copy', { world_id: world.id, how: 'native', where: 'bar' });
      return;
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return; // cancelled
  }
  if (await copyLink(url, 'Link copied')) track('share_copy', { world_id: world.id, how: 'copy', where: 'bar' });
}

function repoStatus(r: WorldRepo): string {
  if (r.state === 'error') return r.note || 'Sync stopped: try Sync now';
  if (r.state === 'readonly') return 'Updates from GitHub only (can’t push)';
  return r.push ? 'Synced both ways' : 'Updates from GitHub only';
}

/** Sync now, put the world on GitHub, or stop syncing; a new version that came in is shown. */
async function githubAction(w: WorldFull, action: 'sync' | 'create' | 'unlink'): Promise<void> {
  try {
    const { world: next } = action === 'unlink' ? await api.unlinkGitHub(w.id) : await api.worldGitHub(w.id, action);
    const st = useWorld.getState();
    if (st.world?.id !== next.id) return;
    if (next.version > st.world.version && next.tree) st.adoptVersion({ worldId: next.id, version: next.version, tree: next.tree, code: next.code ?? '', name: next.name });
    useWorld.setState((s) => (s.world?.id === next.id ? { world: { ...s.world, repo: next.repo ?? null } } : {}));
    if (action === 'unlink') toast('No longer synced with GitHub (the repository stays)');
    else if (action === 'create') toast(`On GitHub as ${next.repo?.repo ?? 'a private repository'}`, 'success');
    else if (next.repo?.state === 'error') toast(next.repo.note || 'GitHub sync failed', 'error');
    else toast(next.version > w.version ? `Brought in from GitHub: version ${next.version}` : 'In sync with GitHub', 'success');
  } catch (e) {
    toast(e instanceof Error ? e.message : 'GitHub sync failed', 'error');
  }
}

/** World name, author and actions. */
export function WorldBar({ visible, actions }: { visible: boolean; actions: WorldBarActions }) {
  const { world, canEdit, isExternal, rename, like, remix } = useWorld();
  // On a phone's half-height sheet, one row: the way back to Explore waits for the full height.
  const mobile = useIsMobile();
  const short = useUi((s) => s.detent) === 'half' && mobile;
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [madeOpen, setMadeOpen] = useState(false);
  const [remixesOpen, setRemixesOpen] = useState(false);
  const friends = useFriends((s) => s.data?.friends);
  const worldId = world?.id;
  const here = useMemo(() => (friends ?? []).filter((f) => f.world?.id === worldId), [friends, worldId]);
  // Everyone else in the world's room right now (friends among them), or at least the friends Orb knows are here.
  const roomCount = useWorld((s) => (s.people && s.people.worldId === worldId ? s.people.count : 0));
  const others = Math.max(roomCount, here.length);

  if (!visible || !world) return null;
  const w = world;
  const maker = makerOf(w);
  const strangers = others - here.length;
  // Who's here counts you too: with one other person here it says 2.
  const hereNames = ['You', ...here.map((f) => f.name), ...(strangers ? [`${strangers} other${strangers === 1 ? '' : 's'}`] : [])];
  const hereTitle = `${hereNames.slice(0, -1).join(', ')} and ${hereNames[hereNames.length - 1]} are here`;
  const native = w.kind === 'native';
  const owner = canEdit;

  const fullscreen: MenuEntry[] = canFullscreen() ? [{ label: 'Fullscreen', icon: 'maximize', onSelect: toggleFullscreen }] : [];
  const site: MenuEntry[] =
    isExternal && w.externalUrl
      ? [{ label: 'Original site', hint: hostOf(w.externalUrl), stacked: true, icon: 'external', onSelect: () => window.open(w.externalUrl!, '_blank', 'noopener,noreferrer') }]
      : [];
  const source: MenuEntry[] = w.sourceUrl
    ? [{ label: w.license ? `Source code · ${w.license}` : 'Source code', icon: 'github', onSelect: () => window.open(w.sourceUrl!, '_blank', 'noopener,noreferrer') }]
    : [];
  // A curated world's story: its maker's post (and how many saw it), the prompt they made it with.
  const origin = w.origin ?? null;
  const postWhere = [platformName(origin?.platform) && `on ${platformName(origin?.platform)}`, origin?.views ? `${formatCount(origin.views)} views` : null].filter(Boolean).join(' · ');
  const story: MenuEntry[] = [
    ...(origin?.prompt || origin?.madeWith ? [{ label: 'How it was made', hint: origin.prompt ? 'The prompt, in the maker’s words' : `With ${origin.madeWith}`, stacked: true, icon: 'sparkle', onSelect: () => setMadeOpen(true) }] : []),
    ...(origin?.postUrl ? [{ label: 'The maker’s post', hint: postWhere || hostOf(origin.postUrl), stacked: true, icon: 'external', onSelect: () => window.open(origin.postUrl!, '_blank', 'noopener,noreferrer') }] : []),
  ];
  const remove: MenuEntry = { label: 'Delete…', icon: 'trash', danger: true, onSelect: () => setConfirmDelete(true) };
  // A few seconds of the world as a video to post, with its address drawn in.
  const recordClip: MenuEntry = { label: 'Record a clip', icon: 'video', onSelect: () => void useClip.getState().record(w) };
  // Kept in sync with a GitHub repository (an import, or "Keep on GitHub"): where, how it's going, sync now, stop.
  const repo = w.repo;
  const github: MenuEntry[] = repo
    ? [
        { label: `GitHub · ${repo.repo}`, hint: repoStatus(repo), stacked: true, icon: 'github', onSelect: () => window.open(`https://github.com/${repo.repo}/tree/${encodeURIComponent(repo.branch)}`, '_blank', 'noopener,noreferrer') },
        { label: 'Sync with GitHub now', icon: 'refresh', onSelect: () => void githubAction(w, 'sync') },
        { label: 'Stop syncing with GitHub', icon: 'x', onSelect: () => void githubAction(w, 'unlink') },
      ]
    : [{ label: 'Keep on GitHub', icon: 'github', onSelect: () => void githubAction(w, 'create') }];
  // Where it came from and what came of it: the remix tree, both ways.
  const from = w.forkedFrom;
  const openFrom = () => {
    if (!from) return;
    track('world_open', { world_id: from.id, source: 'remixed_from' });
    actions.onOpenWorld(from.id);
  };
  const openRemixes = () => {
    track('remixes_open', { world_id: w.id, remixes: w.remixes });
    setRemixesOpen(true);
  };
  const lineage: MenuEntry[] = [
    ...(from ? [{ label: `Remixed from ${from.name}`, icon: 'remix', onSelect: openFrom }] : []),
    ...(w.remixes > 0 ? [{ label: `${w.remixes} ${w.remixes === 1 ? 'remix' : 'remixes'}`, icon: 'users', onSelect: openRemixes }] : []),
  ];
  const withLineage = (items: MenuEntry[]): MenuEntry[] => (lineage.length ? [...lineage, { kind: 'separator' }, ...items] : items);

  const newChat: MenuEntry[] = actions.onNewChat && !isExternal ? [{ label: 'New chat', icon: 'chat', onSelect: actions.onNewChat }] : [];
  // (Download .zip is in the owner's Share sheet.)
  const renameItem: MenuEntry = { label: 'Rename', icon: 'pencil', onSelect: () => setEditing(true) };
  const ownerItems = (): MenuEntry[] => {
    // An embedded world has no code here to copy or download.
    if (isExternal) return [renameItem, ...story, ...site, ...source, ...fullscreen, { kind: 'separator' }, remove];
    return withLineage([
      renameItem,
      ...newChat,
      { label: 'History', icon: 'history', onSelect: actions.onHistory },
      { label: 'Duplicate', icon: 'remix', onSelect: () => void remix() },
      recordClip,
      ...fullscreen,
      { kind: 'separator' },
      ...github,
      { kind: 'separator' },
      remove,
    ]);
  };
  const visitorItems = (): MenuEntry[] =>
    withLineage([
      ...newChat,
      ...story,
      ...(native ? [recordClip] : []),
      ...site,
      ...fullscreen,
      ...(native && w.forkable ? [{ label: 'Download .zip', icon: 'download', onSelect: () => void downloadZip(w) }] : []),
      ...source,
    ]);

  // Remix: your own copy, where Orb has the code (an embedded world runs on its maker's site).
  const showRemix = !owner && native && w.forkable;

  return (
    <>
      {!short && (
        <button
          type="button"
          onClick={actions.onExplore}
          // A phone's whole 44 px to tap, in the same room (it reaches into the gaps around it).
          className="mx-3 -mt-1.5 -mb-1 flex h-11 items-center gap-1 self-start rounded-full pr-2 pl-1 text-[13px] font-medium text-ink-2 transition-colors hover:text-ink sm:-mt-0.5 sm:mb-1 sm:h-8"
        >
          <Icon name="arrow-left" size={15} strokeWidth={2} />
          Explore
        </button>
      )}
      <div className="mx-3 mb-2 flex min-h-[52px] items-center gap-1 rounded-[18px] bg-[var(--field-bg)] py-1.5 pr-1.5 pl-3.5">
        <div className="mr-1 flex min-w-0 flex-1 flex-col justify-center">
          <div className="flex min-w-0 items-center gap-1.5">
            {editing ? (
              <RenameInput
                initial={w.name}
                onDone={(name) => {
                  setEditing(false);
                  if (name !== null) void rename(name);
                }}
              />
            ) : owner ? (
              <button
                type="button"
                onClick={() => setEditing(true)}
                title="Rename"
                className="-mx-1 min-w-0 truncate rounded-md px-1 text-left text-[15px] leading-5 font-semibold tracking-[-0.01em] text-ink hover:bg-[var(--hover)]"
              >
                {w.name}
              </button>
            ) : (
              <span className="min-w-0 truncate text-[15px] leading-5 font-semibold tracking-[-0.01em] text-ink">{w.name}</span>
            )}
            {w.visibility === 'private' && <Icon name="lock" size={13} className="shrink-0 text-ink-3" aria-label="Private" />}
          </div>
          {/* "by you · remixed from Glow Paint": the remix's credit gives way first when room is short. */}
          <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-3">
            {maker ? (
              <button type="button" onClick={() => useUi.getState().openProfile(maker)} title="See their profile" className={`min-w-0 truncate hover:text-ink-2 hover:underline ${from ? 'shrink-0' : ''}`}>
                by {owner ? 'you' : w.authorName || 'someone'}
              </button>
            ) : (
              <span className={`truncate ${from ? 'shrink-0' : ''}`}>by {owner ? 'you' : w.authorName || 'someone'}</span>
            )}
            {from && (
              <>
                <span aria-hidden="true">·</span>
                <button type="button" onClick={openFrom} title={`Open ${from.name}`} className="min-w-0 truncate hover:text-ink-2 hover:underline">
                  remixed from {from.name}
                </button>
              </>
            )}
            {others > 0 && (
              <span className="flex shrink-0 items-center gap-1 font-medium text-ink-2 tabular-nums" title={hereTitle}>
                {here.length > 0 ? (
                  <span aria-hidden="true" className="flex -space-x-1">
                    {here.slice(0, 3).map((f) => (
                      <PersonAvatar key={f.id} person={f} size={15} />
                    ))}
                  </span>
                ) : (
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#4ade80]" />
                )}
                <span aria-hidden="true">{others + 1}</span>
                <span className="sr-only">{hereTitle}</span>
              </span>
            )}
          </div>
        </div>

        <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-ink-4" />

        {owner ? (
          <Button size="sm" variant="ghost" icon="share" aria-label="Share" onClick={actions.onShare} className="h-10 shrink-0 px-3 text-ink">
            <span className="hidden sm:inline">Share</span>
          </Button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void like()}
              aria-pressed={w.liked}
              aria-label={w.liked ? 'Unlike' : 'Like'}
              className={`flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium tabular-nums transition-colors hover:bg-[var(--hover)] ${w.liked ? 'text-[#f0457e]' : 'text-ink-2 hover:text-ink'}`}
            >
              <Icon name="heart" size={17} fill={w.liked ? 'currentColor' : 'none'} className={w.liked ? 'animate-pop' : ''} key={String(w.liked)} />
              {w.likes > 0 && <span>{formatCount(w.likes)}</span>}
            </button>
            {showRemix && (
              <Button size="sm" variant="primary" icon="remix" onClick={() => void remix()} className="h-9 shrink-0 px-3.5">
                Remix
              </Button>
            )}
            <IconButton icon="share" label="Share" size={40} onClick={() => void shareWorldLink(w)} className="text-ink-2" />
          </>
        )}
        <Menu
          items={owner ? ownerItems : visitorItems}
          align="end"
          width={236}
          renderTrigger={(p, open) => <IconButton icon="more" label="More" size={40} {...p} className={open ? 'bg-[var(--hover)] text-ink' : 'text-ink-2'} />}
        />
      </div>

      <RemixesSheet world={remixesOpen ? w : null} onClose={() => setRemixesOpen(false)} onOpenWorld={actions.onOpenWorld} />
      {madeOpen && <HowItWasMade world={w} onClose={() => setMadeOpen(false)} />}
      {confirmDelete && <ConfirmDelete world={w} onClose={() => setConfirmDelete(false)} />}
    </>
  );
}

/** The handle of the person who made a world (null for Orb's own worlds and embedded websites). */
function makerOf(w: WorldFull): string | null {
  const handle = w.path?.split('/')[0];
  return handle && handle !== 'orb' && handle !== 'web' ? handle : null;
}

/** A curated world's story: the prompt its maker shared, and what they made it with. */
function HowItWasMade({ world: w, onClose }: { world: WorldFull; onClose(): void }) {
  const origin = w.origin;
  const author = origin?.authorUrl ? (
    <a href={origin.authorUrl} target="_blank" rel="noopener noreferrer" className="text-ink underline-offset-2 hover:underline">
      {w.authorName || origin.handle}
    </a>
  ) : (
    <span className="text-ink">{w.authorName || origin?.handle || 'its maker'}</span>
  );
  const madeWith = origin?.madeWith;
  return (
    <Modal open onClose={onClose} title={`How “${w.name}” was made`} width={480}>
      {origin?.prompt && (
        <blockquote className="max-h-[50vh] overflow-y-auto rounded-[14px] bg-[var(--field-bg)] px-4 py-3 text-[14px] leading-relaxed whitespace-pre-wrap text-ink italic">“{origin.prompt}”</blockquote>
      )}
      <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
        {origin?.prompt ? (
          <>
            The prompt it was made with, as {author} shared it{madeWith && `, with ${madeWith}`}.
          </>
        ) : (
          <>
            Made by {author}
            {madeWith && ` with ${madeWith}`}.
          </>
        )}
      </p>
      <div className="mt-5 flex justify-end gap-2">
        {origin?.postUrl && (
          <Button variant="glass" icon="external" onClick={() => window.open(origin.postUrl!, '_blank', 'noopener,noreferrer')}>
            The maker’s post
          </Button>
        )}
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}

function ConfirmDelete({ world: w, onClose }: { world: WorldFull; onClose(): void }) {
  const deleteWorld = useWorld((s) => s.deleteWorld);
  const [deleting, setDeleting] = useState(false);
  return (
    <Modal open onClose={() => !deleting && onClose()} title={`Delete “${w.name}”?`} width={400}>
      <p className="text-[14px] leading-relaxed text-ink-2">This removes the world and its link for everyone. Remixes others made stay theirs. This can’t be undone.</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={deleting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          className="!bg-[var(--bad)] !text-white"
          disabled={deleting}
          onClick={async () => {
            setDeleting(true);
            await deleteWorld();
            setDeleting(false);
            onClose();
          }}
        >
          {deleting ? 'Deleting…' : 'Delete world'}
        </Button>
      </div>
    </Modal>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone(name: string | null): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name && name.trim() ? name.trim() : null);
  };
  return (
    <input
      ref={ref}
      value={value}
      maxLength={80}
      aria-label="World name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(value);
        else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
      className="-mx-1 w-[min(240px,50vw)] rounded-md bg-[var(--field-bg-focus)] px-1 text-[15px] leading-5 font-semibold tracking-[-0.01em] text-ink shadow-[0_0_0_2px_color-mix(in_oklab,var(--iris-1)_45%,transparent)] outline-none"
    />
  );
}
