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

async function push(threadId: string): Promise<void> {
  const t = listChats().find((c) => c.id === threadId);
  if (!t) return;
  const messages = loadChatMessages(threadId);
  if (!messages.length) return;
  await fetch(`/api/chats/${encodeURIComponent(threadId)}`, {
    method: 'PUT',
    headers: deviceHeaders({ 'content-type': 'application/json' }),
    credentials: 'same-origin',
    body: JSON.stringify({ worldId: t.worldId, title: t.title, messages, updatedAt: t.updatedAt }),
  }).catch(() => {});
}

function schedule(threadId: string): void {
  if (!signedIn) return;
  clearTimeout(timers.get(threadId));
  timers.set(threadId, setTimeout(() => void push(threadId), 2500));
}

/** Pull the account's chats into this browser. Returns how many were new or newer. */
async function pull(): Promise<number> {
  try {
    const res = await fetch('/api/chats', { headers: deviceHeaders(), credentials: 'same-origin' });
    if (!res.ok) return 0;
    const { chats } = (await res.json()) as { chats: Array<{ thread: ChatThread; messages: ChatMessage[] }> };
    const merged: string[] = [];
    for (const c of chats) if (mergeRemoteChat(c.thread, c.messages)) merged.push(c.thread.id);
    if (merged.length && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('orb:chats-merged', { detail: merged }));
    return merged.length;
  } catch {
    return 0;
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
