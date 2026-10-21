'use client';
// What people share and take with them: a world's address, with ?with=<your handle> when you're
// signed in, so the person opening it is told who brought them and can add them as a friend in one
// tap (src/state/invites.ts), and ?room= for a room of it; copying a link; a world's files as a
// .zip; and the one-time parameters links carry in (?with=, ?remix, ?import=, ?billing=).
import { track } from '@/lib/analytics';
import { api, worldHref } from '@/lib/api';
import { useSession } from '@/components/orb/AccountCard';
import { toast } from './toast';

export function shareUrl(world: { id: string; path?: string | null }, room?: string | null): string {
  const url = new URL(worldHref(world), window.location.origin);
  const handle = useSession.getState().me?.user?.handle;
  if (handle) url.searchParams.set('with', handle);
  if (room) url.searchParams.set('room', room);
  return url.toString();
}

/**
 * Read these parameters of the page's address and take them out of it (when any is there), so a
 * link is neither passed on when the page is shared nor acted on twice. `?remix` reads as ''.
 */
export function takeParams(...names: string[]): (string | null)[] {
  const url = new URL(window.location.href);
  const values = names.map((n) => url.searchParams.get(n));
  if (values.every((v) => v === null)) return values;
  for (const n of names) url.searchParams.delete(n);
  try {
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  } catch {
    /* acted on anyway */
  }
  return values;
}

/** Copy a link: say `copied` when it worked, else show the link itself. Whether it was copied. */
export async function copyLink(url: string, copied: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url);
    toast(copied, 'success');
    return true;
  } catch {
    toast(url);
    return false;
  }
}

/** "Cloud Castle!" → "cloud-castle" */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'world';
}

/** Copy to the clipboard, with a fallback for older browsers. Resolves false when it couldn't. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers / denied permission: fall back to a hidden textarea.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Save the file at `url` (an object URL) as `name`. */
export function saveFile(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Save the world's files as a .zip (GET /api/worlds/:id/zip). */
export async function downloadZip(world: { id: string; name: string }): Promise<void> {
  let blob: Blob;
  try {
    blob = await api.worldZip(world.id);
  } catch {
    toast('Couldn’t download this world. Try again in a moment.', 'error');
    return;
  }
  track('world_download', { world_id: world.id });
  const url = URL.createObjectURL(blob);
  saveFile(url, `${slugify(world.name)}.zip`);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
