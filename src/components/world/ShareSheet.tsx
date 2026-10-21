'use client';
// Share sheet: link + copy (+ native share on phones), inviting friends, visibility (public /
// private — private needs an account, offered inline), "Allow remixing", GitHub link and
// "Download .zip". Changes are reported through onChange(patch); the caller persists them.

import { track } from '@/lib/analytics';
import { worldHref } from '@/lib/api';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Visibility, WorldFull } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { Switch } from '@/components/ui/Switch';
import { showFriends, useFriends } from '@/state/friends';
import { copyText, downloadZip, shareUrl } from '@/state/share';
import { apiMessage, toast } from '@/state/toast';
import { AccountCard, useMe } from '../orb/AccountCard';
import { PersonAvatar, whereIs } from '../orb/People';
import { groupClass } from '../orb/WorldCard';

export function ShareSheet({ open, onClose, world, onChange }: { open: boolean; onClose(): void; world: WorldFull; onChange(patch: Partial<WorldFull>): void }) {
  return (
    <Modal open={open} onClose={onClose} title="Share" width={460}>
      {open && <ShareBody key={world.id} world={world} onChange={onChange} />}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Helpers

function worldUrl(world: { id: string; path?: string | null }) {
  return typeof window === 'undefined' ? worldHref(world) : shareUrl(world);
}

function useCanNativeShare() {
  const [can] = useState(() => typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches);
  return can;
}

// ---------------------------------------------------------------------------------------------

function ShareBody({ world, onChange }: { world: WorldFull; onChange(patch: Partial<WorldFull>): void }) {
  const url = worldUrl(world);
  const displayUrl = url.replace(/^https?:\/\//, '');
  const [copied, setCopied] = useState(false);
  const canShare = useCanNativeShare();
  const { signedIn, status: meStatus } = useMe();
  // Private was chosen but needs an account first.
  const [pendingPrivate, setPendingPrivate] = useState(false);
  const repo = world.repo?.repo;
  const native = world.kind === 'native';
  const owner = world.canEdit;

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    if (await copyText(url)) {
      track('share_copy', { world_id: world.id, how: 'copy', where: 'sheet' });
      setCopied(true);
      toast('Link copied', 'success');
    } else toast('Couldn’t copy. Select the link & copy it yourself.', 'error');
  };

  const share = async () => {
    try {
      await navigator.share({ title: world.name, text: world.description || `${world.name} — made on Orb`, url });
      track('share_copy', { world_id: world.id, how: 'native', where: 'sheet' });
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') void copy();
    }
  };

  const setVisibility = (v: Visibility) => {
    if (v === world.visibility && !pendingPrivate) return;
    if (v === 'public') {
      setPendingPrivate(false);
      if (world.visibility !== 'public') onChange({ visibility: 'public' });
      return;
    }
    if (signedIn) onChange({ visibility: 'private' });
    else setPendingPrivate(true);
  };

  const shownVisibility: Visibility = pendingPrivate ? 'private' : world.visibility;
  const canDownload = native && !!world.code && (owner || world.forkable);

  return (
    <div className="flex flex-col gap-5">
      {/* Link */}
      <div>
        <div className={`${groupClass} flex items-center gap-2 py-1.5 pr-1.5 pl-3.5`}>
          <Icon name="link" size={16} className="shrink-0 text-ink-3" />
          <input
            readOnly
            value={displayUrl}
            aria-label="World link"
            onFocus={(e) => e.currentTarget.select()}
            className="h-9 min-w-0 flex-1 rounded-[8px] bg-transparent text-[14px] text-ink"
          />
          <Button variant="primary" size="sm" onClick={copy} className="min-w-[84px]" aria-live="polite">
            <Icon name={copied ? 'check' : 'copy'} size={15} />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        {canShare && (
          <Button variant="glass" icon="share" onClick={share} className="mt-2.5 w-full">
            Share…
          </Button>
        )}
        {shownVisibility === 'private' && owner && !pendingPrivate && <p className="mt-2 px-1 text-[12.5px] text-ink-2">This link only works for you while the world is private.</p>}
      </div>

      {signedIn && <InviteFriends world={world} />}

      {owner && (
        <>
          {/* Visibility */}
          <div>
            <div className="mb-2 px-1 text-[13px] font-medium text-ink-2" id="orb-vis-label">
              Visibility
            </div>
            <Segmented
              labelledBy="orb-vis-label"
              value={shownVisibility}
              onChange={setVisibility}
              options={[
                { value: 'public', label: 'Public', icon: 'globe' },
                { value: 'private', label: 'Private', icon: 'lock' },
              ]}
            />
            <p className="mt-2 min-h-[20px] px-1 text-[13px] leading-snug text-ink-2">
              {shownVisibility === 'public'
                ? `Anyone with the link can play. ${world.forkedFrom && world.version <= 1 ? 'Shows up in Explore once you change it.' : 'Shows up in Explore.'}`
                : 'Only you. Needs an account.'}
            </p>
            {pendingPrivate && !signedIn && meStatus !== 'loading' && (
              <div className="animate-fade-up mt-3 rounded-[18px] bg-[var(--glass-bg-strong)] p-4 shadow-[0_1px_2px_rgba(16,16,40,.05),0_8px_24px_-12px_rgba(16,16,40,.22),inset_0_0_0_1px_var(--glass-hairline)]">
                <AccountCard
                  variant="inline"
                  reason="Private worlds need an account"
                  onSignedIn={() => {
                    setPendingPrivate(false);
                    onChange({ visibility: 'private' });
                  }}
                  onCancel={() => setPendingPrivate(false)}
                />
              </div>
            )}
          </div>

          {/* Remixing */}
          {native && (
            <label className={`${groupClass} flex cursor-pointer items-start gap-3 px-4 py-3.5`}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[14px] font-medium text-ink">
                  <Icon name="remix" size={15} className="text-ink-2" />
                  Allow remixing
                </span>
                <span className="mt-1 block text-[13px] leading-snug text-ink-2">People can open the code and make their own version. Your original stays yours.</span>
              </span>
              <span className="pt-0.5">
                <Switch checked={world.forkable} onChange={(v) => onChange({ forkable: v })} label="Allow remixing" />
              </span>
            </label>
          )}
        </>
      )}

      {!owner && (
        <p className="px-1 text-[13px] leading-snug text-ink-2">
          Made by <span className="font-medium text-ink">{world.authorName || 'someone'}</span>.{' '}
          {native && world.forkable ? 'Remix it to make your own version.' : ''}
        </p>
      )}

      {/* Code */}
      {(canDownload || repo) && (
        <div className="-mx-1 flex flex-wrap gap-2 border-t border-[color-mix(in_oklab,var(--ink)_8%,transparent)] px-1 pt-4">
          {canDownload && (
            <Button variant="ghost" size="sm" icon="download" onClick={() => void downloadZip(world)}>
              Download .zip
            </Button>
          )}
          {repo && (
            <a
              href={`https://github.com/${repo}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-2 rounded-full px-3 text-[13px] font-medium text-ink-2 transition-colors hover:bg-ink-4 hover:text-ink focus-visible:rounded-full"
            >
              <Icon name="github" size={15} />
              View code on GitHub
              <Icon name="external" size={12} className="text-ink-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Invite friends: each gets a note with a button to join (a toast, if they're on Orb right now)

const INVITE_SHOWN = 5;

function InviteFriends({ world }: { world: WorldFull }) {
  const data = useFriends((s) => s.data);
  const [sent, setSent] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const friends = data?.friends ?? [];

  if (!data) return null;
  const heading = (
    <div className="mb-2 flex items-center gap-1.5 px-1 text-[13px] font-medium text-ink-2">
      <Icon name="users" size={15} />
      Invite friends
    </div>
  );
  if (!friends.length) {
    return (
      <div>
        {heading}
        <p className="px-1 text-[13px] leading-snug text-ink-2">
          Add friends and they can join you here.{' '}
          <button type="button" onClick={showFriends} className="font-medium text-ink hover:underline">
            Add friends
          </button>
        </p>
      </div>
    );
  }
  if (world.visibility !== 'public') {
    return (
      <div>
        {heading}
        <p className="px-1 text-[13px] leading-snug text-ink-2">Only you can open this world while it’s private. Make it public to invite friends.</p>
      </div>
    );
  }

  const invite = async (ids: string[], key: string) => {
    setBusy(key);
    try {
      await useFriends.getState().invite(world.id, ids);
      setSent((s) => ({ ...s, ...Object.fromEntries(ids.map((id) => [id, true])) }));
    } catch (e) {
      toast(apiMessage(e, 'Couldn’t send the invite. Try again in a moment.'), 'error');
    } finally {
      setBusy(null);
    }
  };
  const list = all ? friends : friends.slice(0, INVITE_SHOWN);
  const online = friends.filter((f) => f.online && f.world?.id !== world.id && !sent[f.id]);

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        {heading}
        {online.length > 1 && (
          <button type="button" onClick={() => void invite(online.map((f) => f.id), 'online')} disabled={!!busy} className="mb-2 px-1 text-[12.5px] font-medium text-ink hover:underline disabled:opacity-50">
            Invite everyone online
          </button>
        )}
      </div>
      <ul className={`${groupClass} p-1.5`}>
        {list.map((f) => {
          const there = f.world?.id === world.id;
          return (
            <li key={f.id} className="flex items-center gap-3 px-2 py-1.5">
              <PersonAvatar person={f} size={32} online={f.online} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-ink">{f.name}</span>
                <span className="block truncate text-[12px] text-ink-2">{there ? 'Here already' : whereIs(f)}</span>
              </span>
              {there ? null : sent[f.id] ? (
                <span className="flex shrink-0 items-center gap-1 px-2 text-[12.5px] font-medium text-[var(--ok)]">
                  <Icon name="check" size={14} strokeWidth={2.2} />
                  Invited
                </span>
              ) : (
                <Button size="sm" variant="glass" icon={busy === f.id ? undefined : 'send'} onClick={() => void invite([f.id], f.id)} disabled={!!busy} className="shrink-0">
                  {busy === f.id && <Spinner size={13} />}
                  Invite
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {friends.length > INVITE_SHOWN && (
        <button type="button" onClick={() => setAll(!all)} className="mt-1.5 px-1 text-[12.5px] font-medium text-ink-2 hover:text-ink">
          {all ? 'Show fewer' : `Show all ${friends.length} friends`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Segmented control (radiogroup with a sliding thumb)

interface SegOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

function Segmented<T extends string>({ value, onChange, options, labelledBy }: { value: T; onChange(v: T): void; options: SegOption<T>[]; labelledBy: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const j = (index + dir + options.length) % options.length;
    onChange(options[j].value);
    refs.current[j]?.focus();
  };
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className={`${groupClass} relative grid p-1`} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      <span
        aria-hidden="true"
        className="absolute top-1 bottom-1 left-1 rounded-[14px] bg-[var(--glass-bg-strong)] shadow-[0_1px_2px_rgba(16,16,40,.08),0_4px_12px_-4px_rgba(16,16,40,.2),inset_0_0_0_1px_var(--glass-hairline)] transition-transform duration-300 ease-[var(--ease-spring)]"
        style={{ width: `calc((100% - 8px) / ${options.length})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((o, i) => {
        const on = i === index;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={onKey}
            className={`relative z-[1] flex h-10 items-center justify-center gap-2 rounded-[14px] text-[14px] font-medium transition-colors duration-200 focus-visible:rounded-[14px] focus-visible:outline-offset-0 ${on ? 'text-ink' : 'text-ink-2 hover:text-ink'}`}
          >
            {o.icon && <Icon name={o.icon} size={16} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

