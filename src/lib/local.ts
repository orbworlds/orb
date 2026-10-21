'use client';
// Browser-local persistence helpers. Everything here lives only in this browser.
// All accessors are safe to call during SSR (they return defaults) and never throw.

import { PLAYER_COLORS } from './looks';
import type { ChatMessage, ChatThread, ModelProvider, ModelSettings } from './types';

const K = {
  device: 'orb:device',
  name: 'orb:name',
  color: 'orb:color',
  model: 'orb:model',
  ai: 'orb:ai',
  chats: 'orb:chats',
  chat: (id: string) => `orb:chat:${id}`,
  worldStorage: (worldId: string) => `orb:ls:${worldId}`,
  /** When this browser last saved each world's storage (world id → epoch ms). */
  worldStorageAt: 'orb:ls-at',
  orbPos: 'orb:pos',
} as const;

function ls(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = ls()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJSON(key: string, value: unknown): void {
  const store = ls();
  if (!store) return;
  if (value === undefined || value === null) {
    try {
      store.removeItem(key);
    } catch {
      /* privacy mode */
    }
    return;
  }
  const text = JSON.stringify(value);
  // When the browser's storage is full, make room by dropping the messages of the oldest chats
  // (never the one being saved) and try again; tell the app if it still doesn't fit.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      store.setItem(key, text);
      return;
    } catch {
      if (!freeOldChats(key)) break;
    }
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('orb:storage-full'));
}

/** Remove the stored messages of the 10 oldest chats (keeping the chat list). False if none left. */
function freeOldChats(keep: string): boolean {
  const store = ls();
  if (!store) return false;
  const old = readJSON<ChatThread[]>(K.chats, [])
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .map((t) => K.chat(t.id))
    .filter((k) => k !== keep && store.getItem(k) !== null)
    .slice(0, 10);
  for (const k of old) store.removeItem(k);
  return old.length > 0;
}

function randomKey(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- Device identity --------------------------------------------------------

/** Secret device key sent as `x-orb-device`. Created on first use. */
export function getDeviceKey(): string {
  const s = ls();
  if (!s) return '';
  let key = s.getItem(K.device);
  if (!key) {
    key = randomKey();
    try {
      s.setItem(K.device, key);
    } catch {}
  }
  return key;
}

const ADJ = ['Misty', 'Sunny', 'Velvet', 'Cosmic', 'Gentle', 'Lucky', 'Dreamy', 'Brave', 'Quiet', 'Golden', 'Silver', 'Fuzzy', 'Little', 'Wild', 'Sleepy', 'Bright', 'Coral', 'Mossy', 'Starry', 'Snowy'];
const NOUN = ['Otter', 'Comet', 'Fox', 'Lantern', 'Willow', 'Pebble', 'Panda', 'Moth', 'Koi', 'Fern', 'Nova', 'Cloud', 'Wren', 'Maple', 'Orca', 'Lynx', 'Bramble', 'Ember', 'Puffin', 'Clover'];

/** Display name for anonymous creations (e.g. "Misty Otter"). */
export function getDisplayName(): string {
  const s = ls();
  if (!s) return 'Guest';
  let name = s.getItem(K.name);
  if (!name) {
    const r = new Uint32Array(2);
    crypto.getRandomValues(r);
    name = `${ADJ[r[0] % ADJ.length]} ${NOUN[r[1] % NOUN.length]}`;
    try {
      s.setItem(K.name, name);
    } catch {}
  }
  return name;
}

/** Forget the display name and pick a new guest name (after signing out). */
export function newDisplayName(): string {
  try {
    ls()?.removeItem(K.name);
  } catch {}
  return getDisplayName();
}

export function setDisplayName(name: string): void {
  try {
    ls()?.setItem(K.name, name.trim().slice(0, 40) || getDisplayName());
  } catch {}
}

export function getPlayerColor(): string {
  const s = ls();
  if (!s) return PLAYER_COLORS[0];
  let c = s.getItem(K.color);
  if (!c) {
    c = PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
    try {
      s.setItem(K.color, c);
    } catch {}
  }
  return c;
}

/** The blob color picked in the You tab (or the account's, on a device signing in). */
export function setPlayerColor(color: string): void {
  try {
    ls()?.setItem(K.color, color);
  } catch {}
}

// --- Model settings -----------------------------------------------------------

/**
 * AI settings: Orb's free AI by default; any number of the person's own providers can be
 * connected (one key + model each, remembered), and one of them is active.
 */
export type ByoProvider = Exclude<ModelProvider, 'free'>;
export interface AiConfig {
  active: ModelProvider;
  keys: Partial<Record<ByoProvider, string>>;
  models: Partial<Record<ByoProvider, string>>;
  /** Per provider, per model: chosen options (e.g. cursor → claude-sonnet-5-5 → { effort: 'high' }). */
  params?: Partial<Record<ByoProvider, Record<string, Record<string, string>>>>;
}

export function getAiConfig(): AiConfig {
  const cfg = readJSON<AiConfig | null>(K.ai, null);
  if (cfg && typeof cfg === 'object' && cfg.keys) return { active: cfg.active || 'free', keys: cfg.keys || {}, models: cfg.models || {}, params: cfg.params || {} };
  // Migrate the older single-provider format.
  const old = readJSON<ModelSettings>(K.model, { provider: 'free' });
  const migrated: AiConfig = { active: 'free', keys: {}, models: {} };
  if (old.provider && old.provider !== 'free' && old.apiKey) {
    migrated.active = old.provider;
    migrated.keys[old.provider] = old.apiKey;
    if (old.model) migrated.models[old.provider] = old.model;
  }
  return migrated;
}
export function setAiConfig(cfg: AiConfig): void {
  writeJSON(K.ai, cfg);
  writeJSON(K.model, null);
}

/** The active provider with its key and model (what a build uses). */
export function getModelSettings(): ModelSettings {
  const cfg = getAiConfig();
  if (cfg.active === 'free' || !cfg.keys[cfg.active]) return { provider: 'free' };
  const model = cfg.models[cfg.active];
  const params = cfg.params?.[cfg.active]?.[model ?? ''];
  return { provider: cfg.active, apiKey: cfg.keys[cfg.active], model, ...(params && Object.keys(params).length ? { params } : {}) };
}

// --- Chats ---------------------------------------------------------------------

export function listChats(): ChatThread[] {
  return readJSON<ChatThread[]>(K.chats, []).sort((a, b) => b.updatedAt - a.updatedAt);
}
/** Called after a chat thread or its messages are saved (used by account sync). */
const chatListeners = new Set<(threadId: string) => void>();
export function onChatSaved(fn: (threadId: string) => void): () => void {
  chatListeners.add(fn);
  return () => chatListeners.delete(fn);
}
const notifyChat = (id: string) => chatListeners.forEach((fn) => fn(id));

/** Put a thread in the list (newest first), keeping the 200 most recent threads. */
function putThread(t: ChatThread): void {
  const all = readJSON<ChatThread[]>(K.chats, []).filter((c) => c.id !== t.id);
  all.push(t);
  all.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const old of all.splice(200)) writeJSON(K.chat(old.id), null);
  writeJSON(K.chats, all);
}
export function saveChatThread(t: ChatThread): void {
  putThread(t);
  notifyChat(t.id);
}
export function loadChatMessages(id: string): ChatMessage[] {
  return readJSON<ChatMessage[]>(K.chat(id), []);
}
export function saveChatMessages(id: string, messages: ChatMessage[]): void {
  writeJSON(K.chat(id), messages.slice(-120));
  notifyChat(id);
}

/** Merge a thread from the account (server) into this browser if it is newer. */
export function mergeRemoteChat(t: ChatThread, messages: ChatMessage[]): boolean {
  const local = readJSON<ChatThread[]>(K.chats, []).find((c) => c.id === t.id);
  if (local && local.updatedAt >= t.updatedAt) return false;
  putThread(t);
  writeJSON(K.chat(t.id), messages.slice(-120));
  return true;
}

// --- Per-world storage (the world's shimmed localStorage) --------------------------

export function getWorldStorage(worldId: string): Record<string, string> {
  return readJSON<Record<string, string>>(K.worldStorage(worldId), {});
}

const storageListeners = new Set<(worldId: string) => void>();
/** A world's storage was saved here by the world itself (not taken over from the account). */
export function onWorldStorageSaved(fn: (worldId: string) => void): () => void {
  storageListeners.add(fn);
  return () => storageListeners.delete(fn);
}

/**
 * Save a world's storage, noting when (`at`, now by default). `quiet`: a copy taken over from
 * the account (src/lib/savesync.ts), which doesn't go back up.
 */
export function setWorldStorage(worldId: string, data: Record<string, string>, opts: { at?: number; quiet?: boolean } = {}): void {
  writeJSON(K.worldStorage(worldId), Object.keys(data).length ? data : null);
  const times = readJSON<Record<string, number>>(K.worldStorageAt, {});
  delete times[worldId];
  times[worldId] = opts.at ?? Date.now();
  const ids = Object.keys(times);
  for (const id of ids.slice(0, Math.max(0, ids.length - 500))) delete times[id];
  writeJSON(K.worldStorageAt, times);
  if (!opts.quiet) storageListeners.forEach((fn) => fn(worldId));
}

/** When this browser last saved a world's storage (null: never, or before it noted the time). */
export function getWorldStorageAt(worldId: string): number | null {
  const at = readJSON<Record<string, number>>(K.worldStorageAt, {})[worldId];
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

/** Worlds with storage saved in this browser, the most recently saved first. */
export function listWorldStorage(): Array<{ worldId: string; at: number }> {
  const store = ls();
  if (!store) return [];
  const times = readJSON<Record<string, number>>(K.worldStorageAt, {});
  const prefix = K.worldStorage('');
  const out: Array<{ worldId: string; at: number }> = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key?.startsWith(prefix)) out.push({ worldId: key.slice(prefix.length), at: Number(times[key.slice(prefix.length)]) || 0 });
  }
  return out.sort((a, b) => b.at - a.at);
}

// --- UI ---------------------------------------------------------------------------

export function getOrbPosition(): { x: number; y: number } | null {
  return readJSON<{ x: number; y: number } | null>(K.orbPos, null);
}
export function setOrbPosition(p: { x: number; y: number }): void {
  writeJSON(K.orbPos, p);
}

export const localKeys = K;
