'use client';
// Links from the open-source games' repositories on GitHub (scripts/publish-games.mjs, the kit's
// `orb share`). Both leave the address at once, so they aren't passed on or acted on twice, and
// both end in a tap of the person's own, never in a copy made by just opening a link:
//   ?remix             on a world's page: its chat opens, where the welcome line offers Make my own copy
//   ?import=<repo>     anywhere: the You tab opens with the repository in its import form
import { useEffect, useRef } from 'react';
import { track } from '@/lib/analytics';
import { useUi } from './ui';
import { useWorld } from './world';

function take(): { remix: boolean; repo: string | null } {
  const url = new URL(window.location.href);
  const remix = url.searchParams.has('remix');
  const raw = url.searchParams.get('import');
  if (!remix && raw === null) return { remix: false, repo: null };
  url.searchParams.delete('remix');
  url.searchParams.delete('import');
  try {
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  } catch {
    /* acted on anyway */
  }
  const repo = raw?.trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '').replace(/\/+$/, '') ?? '';
  return { remix, repo: /^[\w.-]{1,100}\/[\w.-]{1,100}(\/tree\/[^\s?#]{1,200})?$/.test(repo) ? `https://github.com/${repo}` : null };
}

export function useGitHubLinks(): void {
  const asked = useRef<{ remix: boolean; repo: string | null } | null>(null);
  const world = useWorld((s) => s.world);
  const status = useWorld((s) => s.status);
  const canEdit = useWorld((s) => s.canEdit);
  const isExternal = useWorld((s) => s.isExternal);

  useEffect(() => {
    // Once per page: a second run (React's development double effects) would find the address already clean.
    if (asked.current) return;
    asked.current = take();
    const repo = asked.current.repo;
    if (!repo) return;
    track('import_link', { repo: repo.slice(19, 140) });
    const u = useUi.getState();
    u.setHeroDone(true);
    u.setImportUrl(repo);
    u.openPanel('you', 'full');
  }, []);

  useEffect(() => {
    const a = asked.current;
    if (!a?.remix || status !== 'ready' || !world) return;
    a.remix = false;
    if (isExternal || canEdit || !world.forkable) return;
    track('remix_link', { world_id: world.id });
    useUi.getState().openPanel('chat', 'half');
  }, [status, world, canEdit, isExternal]);
}
