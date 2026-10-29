'use client';
// Keeps chats in sync with the person's account when they're signed in (passkey). Anonymous
// people keep chats in this browser only. Local saves are pushed (debounced per thread); on
// sign-in and app start the account's chats are merged in (newer wins).
import { deviceHeaders } from './api';
import { listChats, loadChatMessages, mergeRemoteChat, onChatSaved } from './local';
import { setSaveSync } from './savesync';
import type { ChatMessage, ChatThread } from './types';

let signedIn = false;
let unsubscribe: (() => void) | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** The account keeps a chat of up to 600 KB (/api/chats/:id): the oldest messages' photos give way first. */
const MAX_SYNC = 560_000;
function fitted(messages: ChatMessage[]): ChatMessage[] {
  const out = messages.slice(-120);
  let size = JSON.stringify(out).length;
  for (let i = 0; size > MAX_SYNC && i < out.length; i++) {
    if (!out[i].photos) continue;
    size -= JSON.stringify(out[i].photos).length;
    out[i] = { ...out[i], photos: undefined };
  }
  return out;
}

async function push(threadId: string): Promise<void> {
  const t = listChats().find((c) => c.id === threadId);
  if (!t) return;
  const messages = loadChatMessages(threadId);
  if (!messages.length) return;
  await fetch(`/api/chats/${encodeURIComponent(threadId)}`, {
    method: 'PUT',
    headers: deviceHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ worldId: t.worldId, title: t.title, messages: fitted(messages), updatedAt: t.updatedAt }),
  }).catch(() => {});
}

function schedule(threadId: string): void {
  if (!signedIn) return;
  clearTimeout(timers.get(threadId));
  timers.set(threadId, setTimeout(() => void push(threadId), 2500));
}

/** Pull the account's chats into this browser (newer ones win). */
async function pull(): Promise<void> {
  try {
    const res = await fetch('/api/chats', { headers: deviceHeaders() });
    if (!res.ok) return;
    const { chats } = (await res.json()) as { chats: Array<{ thread: ChatThread; messages: ChatMessage[] }> };
    const merged: string[] = [];
    for (const c of chats) if (mergeRemoteChat(c.thread, c.messages)) merged.push(c.thread.id);
    if (merged.length && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('orb:chats-merged', { detail: merged }));
  } catch {
    /* offline: the next start pulls again */
  }
}

/**
 * Call with the current sign-in state (on start, after sign-in/up, after sign-out). With uploadAll,
 * settles once the uploads have. Game progress follows the account the same way (./savesync.ts).
 */
export async function setChatSync(isSignedIn: boolean, opts: { uploadAll?: boolean } = {}): Promise<void> {
  void setSaveSync(isSignedIn);
  signedIn = isSignedIn;
  if (!isSignedIn) {
    unsubscribe?.();
    unsubscribe = null;
    return;
  }
  unsubscribe ??= onChatSaved(schedule);
  await pull();
  if (opts.uploadAll) await Promise.all(listChats().slice(0, 100).map((t) => push(t.id)));
}
