'use client';
// History sheet: every saved version of a world (newest first) with the prompt that made it.
// "Restore" hands the version back to the caller (which loads + saves it) and closes.

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { WorldVersionInfo } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Modal } from '@/components/ui/Modal';
import { Skeleton, timeAgo } from '../orb/WorldCard';

interface LoadState {
  key: string;
  versions: WorldVersionInfo[];
  error: boolean;
}

export function HistorySheet({ open, onClose, worldId, currentVersion, onRestore }: { open: boolean; onClose(): void; worldId: string; currentVersion: number; onRestore(version: number): void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={480}
      title={
        <span className="flex items-center gap-2">
          <Icon name="history" size={17} className="text-ink-2" />
          History
        </span>
      }
    >
      {open && (
        <HistoryBody
          worldId={worldId}
          currentVersion={currentVersion}
          onRestore={(v) => {
            onRestore(v);
            onClose();
          }}
        />
      )}
    </Modal>
  );
}

function HistoryBody({ worldId, currentVersion, onRestore }: { worldId: string; currentVersion: number; onRestore(v: number): void }) {
  const [nonce, setNonce] = useState(0);
  // Refetch when the world or its current version changes while open.
  const key = `${worldId}:${currentVersion}:${nonce}`;
  const [state, setState] = useState<LoadState | null>(null);
  const current = state?.key === key ? state : null;

  useEffect(() => {
    let alive = true;
    api
      .versions(worldId)
      .then((r) => alive && setState({ key, versions: [...r.versions].sort((a, b) => b.version - a.version), error: false }))
      .catch(() => alive && setState({ key, versions: [], error: true }));
    return () => {
      alive = false;
    };
  }, [key, worldId]);

  if (!current)
    return (
      <div aria-busy="true" aria-label="Loading history" className="flex flex-col gap-1 pb-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-start gap-3.5 px-2 py-3">
            <Skeleton className="h-6 w-11 shrink-0 rounded-full" />
            <div className="flex-1">
              <Skeleton className="h-3.5 w-4/5 rounded-full" />
              <Skeleton className="mt-2 h-3 w-1/4 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    );

  if (current.error)
    return (
      <div className="flex flex-col items-center px-4 py-8 text-center">
        <p className="text-[14px] font-medium text-ink">Couldn’t load the history</p>
        <p className="mt-1 text-[13px] text-ink-2">Check your connection and try again.</p>
        <Button variant="glass" size="sm" icon="refresh" className="mt-4" onClick={() => setNonce((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );

  if (!current.versions.length)
    return (
      <div className="flex flex-col items-center px-4 py-8 text-center">
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--field-bg)] text-ink-2">
          <Icon name="history" size={19} />
        </span>
        <p className="text-[14px] font-medium text-ink">No history yet</p>
        <p className="mt-1 max-w-[280px] text-[13px] leading-snug text-ink-2">Every build saves a version here, so you can always go back.</p>
      </div>
    );

  const oldest = current.versions[current.versions.length - 1]?.version;

  return (
    <div className="pb-1">
      <p className="mb-2 px-1 text-[13px] text-ink-2">Every build is saved. Go back to any version.</p>
      <ol className="relative">
        {current.versions.map((v, i) => {
          const isCurrent = v.version === currentVersion;
          const last = i === current.versions.length - 1;
          const note = v.prompt?.trim() || (v.version === oldest ? 'First version' : 'Saved version');
          return (
            <li key={v.version} className={`group relative flex items-start gap-3.5 rounded-[14px] px-2 py-3 transition-colors ${isCurrent ? 'bg-[color-mix(in_oklab,var(--iris-1)_9%,transparent)]' : 'hover:bg-[color-mix(in_oklab,var(--ink)_4%,transparent)]'}`}>
              {/* timeline rail */}
              {!last && <span aria-hidden="true" className="absolute top-[38px] bottom-[-10px] left-[29px] w-px bg-[color-mix(in_oklab,var(--ink)_10%,transparent)]" />}
              <span
                className={`relative z-[1] flex h-6 min-w-11 shrink-0 items-center justify-center rounded-full px-2 font-mono text-[12px] font-medium tabular-nums ${
                  isCurrent ? 'text-white shadow-[0_4px_12px_-4px_rgba(139,123,255,.7)] [background:var(--iris)]' : 'bg-[var(--glass-bg-strong)] text-ink-2 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ink)_10%,transparent)]'
                }`}
              >
                v{v.version}
              </span>
              <div className="min-w-0 flex-1 pt-[2px]">
                <p className={`line-clamp-2 text-[14px] leading-snug break-words ${v.prompt?.trim() ? 'text-ink' : 'text-ink-2 italic'}`} title={v.prompt || undefined}>
                  {note}
                </p>
                <p className="mt-1 text-[12.5px] text-ink-3">
                  <time dateTime={v.createdAt} title={new Date(v.createdAt).toLocaleString()}>
                    {timeAgo(v.createdAt)}
                  </time>
                  {isCurrent && <span className="font-medium text-ink-2"> · Current</span>}
                </p>
              </div>
              {!isCurrent && (
                <Button variant="glass" size="sm" icon="undo" className="shrink-0 self-center" onClick={() => onRestore(v.version)} aria-label={`Restore version ${v.version}`}>
                  Restore
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
