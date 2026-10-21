'use client';
// The world currently on screen and everything that persists it.
//
// - The start canvas is a template (no server record, chatKey 'new'); when the first build starts
//   it becomes a world (createForBuild) and the address its readable one (/<owner>/<world>) via
//   history.replaceState, so the stage never remounts. Builds save on the server (adoptVersion).
// - A visitor asks in place; to change a forkable world they make their own copy (remix).
// - After each new version a thumbnail is captured once the world settles.
//
// The live WorldFrame registers its imperative handle here (setFrameHandle) so captures can be
// taken from actions without threading refs through the tree.
import { create } from 'zustand';
import { sameView, track, trackPageView } from '@/lib/analytics';
import { api, ApiError, thumbPath, worldHref } from '@/lib/api';
import { getDeviceKey, getDisplayName, getPlayerColor, listChats, saveChatThread } from '@/lib/local';
import { adoptWorldStorage } from '@/lib/runtime/bridge';
import { ROOM_NAME_RE } from '@/lib/runtime/sdk';
import { pullSave } from '@/lib/savesync';
import { fetchTemplate, TEMPLATE_BY_ID } from '@/lib/templates';
import type { WorldFull } from '@/lib/types';
import type { WorldFrameHandle } from '@/components/world/WorldFrame';
import { toast } from './toast';
import { rememberWorldName, takeLayerEntry, useUi } from './ui';

type WorldStatus = 'idle' | 'loading' | 'ready' | 'not-found' | 'error';

export interface Player {
  id: string;
  name: string;
  color: string;
  /** What the account's blob wears in worlds (src/lib/looks.ts). */
  wears?: string[];
}

/** What the account's blob wears, kept for the player made later (initPlayer). */
let wearing: string[] = [];

interface WorldState {
  status: WorldStatus;
  /** The saved world on screen; null on the start canvas (a template before the first change). */
  world: WorldFull | null;
  /** Chat threads key: the world id, or 'new' until the start canvas is saved. */
  chatKey: string;
  /** Template on the start canvas (or the template a world was made from). */
  templateId: string | null;
  /** The start canvas is on screen (a template loaded since the last world): home can show over it. */
  onStart: boolean;
  /** What's on screen (a world just opened, the start canvas) has drawn: until then the stage covers it. */
  drawn: boolean;
  /** Committed code — the base for the next build. */
  baseCode: string | null;
  /** Code shown in the frame (may run ahead of baseCode while a build streams). */
  previewCode: string | null;
  /** World id the frame runs under (a `template-…` draft id on the start canvas). */
  frameId: string;
  canEdit: boolean;
  isExternal: boolean;
  /** Whether the client confirmed ownership/visibility with the API (SSR data is public-only). */
  verified: boolean;
  me: Player | null;
  /** Who else is in the room of the world on screen (`worldId`): how many, how many are friends. */
  people: { worldId: string; count: number; friends: number } | null;

  initPlayer(): Promise<void>;
  /** The blob's color and what it wears changed (the You tab, or the account signing in or out). */
  dress(look: { color?: string; wear?: string[] }): void;
  loadTemplate(id: string): Promise<void>;
  loadWorld(id: string, initial?: WorldFull | null): Promise<void>;
  /** Show another world in place (no remount) and push its address (`room`: into that named room of it, as an invite link would). */
  openWorld(id: string, opts?: { room?: string }): Promise<void>;
  /** Back to the start canvas (optionally with a prefilled prompt); `chat`: straight into the Orb's chat, ready to describe a new world. */
  goStart(opts?: { prompt?: string; template?: string; replace?: boolean; chat?: boolean }): Promise<void>;
  preview(code: string): void;
  /**
   * Start canvas: create the world when the first build starts, so the build works on a real
   * world (survives switching worlds and reloads). Null if not on the canvas or failed.
   */
  createForBuild(threadId: string): Promise<{ worldId: string; version: number } | null>;
  /** A build saved a new version on the server: show it if that world is on screen. */
  adoptVersion(v: { worldId: string; version: number; tree: string; code: string; name?: string }): void;
  restore(version: number): Promise<void>;
  rename(name: string): Promise<void>;
  /** Read the world on screen again, keeping its frame (signing in or out changes its address, maker and who may change it). */
  refresh(): Promise<void>;
  patchWorld(patch: Partial<WorldFull>): Promise<void>;
  /** Make the viewer's own copy and open it → its id, or null (failed, or they went elsewhere meanwhile). */
  remix(sourceId?: string): Promise<string | null>;
  like(): Promise<void>;
  deleteWorld(): Promise<void>;
  frameReady(): void;
  worldCaptured(dataUrl: string): void;
}

// --- module state ------------------------------------------------------------------------------

let frame: WorldFrameHandle | null = null;
/** Register the live frame (WorldStage). */
export function setFrameHandle(h: WorldFrameHandle | null): void {
  frame = h;
}
export function getFrameHandle(): WorldFrameHandle | null {
  return frame;
}

/** What a fresh copy might change first (the chat's own suggestions for a world of one's own). */
/** Ideas for a first change to a world of one's own (its copy, or one with no template ideas). */
export const CHANGE_CHIPS = ['Make it nighttime', 'Add gentle music', 'Add a little surprise'];

/** Guards async loads: a newer load (or navigation) invalidates older responses. */
let loadToken = 0;

/** Move the chat thread a build ran in from one world key to another (before the store switches). */
function carryThread(from: string, to: string, threadId: string): void {
  const thread = listChats().find((t) => t.id === threadId);
  if (thread && thread.worldId === from) saveChatThread({ ...thread, worldId: to, updatedAt: Date.now() });
}

function navigate(path: string, mode: 'push' | 'replace'): void {
  if (window.location.pathname + window.location.search === path) return;
  try {
    // From inside the sheet or a profile, the page takes their entry: Back returns to where they opened.
    if (mode === 'push' && !takeLayerEntry()) window.history.pushState(null, '', path);
    else window.history.replaceState(null, '', path);
  } catch {
    /* sandboxed or detached document — the state is still correct */
  }
  if (mode === 'push') trackPageView();
  else sameView();
}

/** True the first time `key` is asked for in this browser session (also when storage is blocked). */
function firstInSession(key: string): boolean {
  try {
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, '1');
  } catch {
    /* blocked: as if it were the first time */
  }
  return true;
}

function friendly(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.message && !/^Request failed/.test(e.message)) return e.message;
  return fallback;
}

/** Public, non-secret player id — the same derivation the server uses (sha256 → 12 hex). */
async function publicDeviceId(): Promise<string> {
  const key = getDeviceKey();
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`orb-device:${key}`));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 12);
  } catch {
    // Insecure context (no SubtleCrypto): a per-tab id still works for presence.
    return `p${Math.random().toString(36).slice(2, 13)}`;
  }
}

// --- store ---------------------------------------------------------------------------------------

export const useWorld = create<WorldState>((set, get) => {
  // ---- thumbnails: capture ~2.5 s after the world settles (each `ready` restarts the wait) ----
  const THUMB_DELAY = 2500;
  const THUMB_GIVE_UP = 15000;
  let thumb: { worldId: string; since: number; timer: ReturnType<typeof setTimeout> } | null = null;

  function scheduleThumb(worldId: string): void {
    if (thumb) clearTimeout(thumb.timer);
    thumb = { worldId, since: Date.now(), timer: setTimeout(captureThumb, THUMB_DELAY) };
  }

  async function captureThumb(): Promise<void> {
    const job = thumb;
    thumb = null;
    const s = get();
    if (!job || !s.world || s.world.id !== job.worldId || !s.canEdit || s.isExternal) return;
    const url = await (frame?.capture() ?? Promise.resolve(null));
    if (url) await uploadThumb(job.worldId, url);
  }

  async function uploadThumb(worldId: string, dataUrl: string): Promise<void> {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      if (blob.size > 500_000) return;
      const { thumbVersion } = await api.uploadThumb(worldId, blob);
      const w = get().world;
      if (w?.id === worldId) set({ world: { ...w, thumbVersion, thumbUrl: thumbPath(worldId, thumbVersion) } });
    } catch (e) {
      console.warn('[orb] thumbnail upload failed', e);
    }
  }

  function afterCommit(world: WorldFull): void {
    rememberWorldName(world.id, world.name);
    // Only the world on screen can be photographed (a background build must not cancel its capture).
    if (get().world?.id === world.id) scheduleThumb(world.id);
  }

  /** Count one play per world per browser session, for visitors. */
  function countPlay(world: WorldFull): void {
    if (!firstInSession(`orb:played:${world.id}`)) return;
    api
      .play(world.id)
      .then(({ plays }) => {
        const w = get().world;
        if (w?.id === world.id) set({ world: { ...w, plays } });
      })
      .catch(() => {});
  }

  /** Put a world on screen (same id → updates in place; the frame only reloads if the code changed). */
  function applyWorld(world: WorldFull, verified: boolean): void {
    const external = world.kind === 'external';
    set({
      status: 'ready',
      world,
      chatKey: world.id,
      templateId: world.template,
      canEdit: world.canEdit,
      isExternal: external,
      baseCode: world.code ?? '',
      previewCode: external ? null : (world.code ?? ''),
      frameId: world.id,
      verified,
    });
    rememberWorldName(world.id, world.name);
  }

  /** Start canvas behind a not-found / error state, keeping the status. */
  async function showBlankBehind(token: number): Promise<void> {
    try {
      const code = await fetchTemplate('blank');
      if (token !== loadToken) return;
      set({ baseCode: code, previewCode: code, frameId: 'template-blank', templateId: 'blank' });
    } catch {
      /* the sky gradient alone is fine */
    }
  }

  return {
    status: 'idle',
    world: null,
    chatKey: 'new',
    templateId: null,
    onStart: false,
    drawn: false,
    baseCode: null,
    previewCode: null,
    frameId: 'template-blank',
    canEdit: true,
    isExternal: false,
    verified: false,
    me: null,
    people: null,

    async initPlayer() {
      if (get().me) return;
      const id = await publicDeviceId();
      set({ me: { id, name: getDisplayName(), color: getPlayerColor(), wears: wearing } });
    },

    dress(look) {
      if (look.wear) wearing = look.wear;
      const me = get().me;
      if (!me) return;
      const color = look.color || me.color;
      if (color !== me.color || (me.wears ?? []).join() !== wearing.join()) set({ me: { ...me, color, wears: wearing } });
    },

    async loadTemplate(id) {
      const token = ++loadToken;
      const t = TEMPLATE_BY_ID[id] ?? TEMPLATE_BY_ID.blank;
      // The world identity resets right away (chat, world bar); the frame keeps showing the
      // previous scene until the template arrives, then cross-fades.
      set({ world: null, chatKey: 'new', canEdit: true, isExternal: false, verified: true, onStart: true, drawn: false, status: get().previewCode ? 'ready' : 'loading' });
      try {
        const code = await fetchTemplate(t.id);
        if (token !== loadToken) return;
        set({ status: 'ready', templateId: t.id, baseCode: code, previewCode: code, frameId: `template-${t.id}` });
      } catch (e) {
        if (token !== loadToken) return;
        console.warn('[orb] template failed', e);
        set({ status: 'error', templateId: t.id, baseCode: '', previewCode: null });
        toast(`Couldn't load ${t.name}. Check your connection and try again.`, 'error');
      }
    },

    async loadWorld(id, initial) {
      const token = ++loadToken;
      set({ onStart: false });
      const native = initial?.kind !== 'external';
      // Signed in, the account's progress in this world (if it's newer than this browser's) comes
      // first: the world starts once it's here, so it never plays, and saves, from where it began.
      const settled = (native ? pullSave(id, 2500) : Promise.resolve(null)).then((save) => {
        if (token !== loadToken || !save) return;
        // A world already running here keeps what it plays with (its own saves come later).
        const running = get().frameId === id && !!(get().previewCode || get().world?.tree);
        if (!running) adoptWorldStorage(id, save.data, save.at);
      });
      if (initial && initial.id === id) {
        applyWorld({ ...initial, canEdit: false, ...(native ? { tree: null } : {}) }, false);
        if (native) void settled.then(() => token === loadToken && !get().verified && applyWorld({ ...initial, canEdit: false }, false));
      } else if (get().world?.id !== id) set({ status: 'loading', drawn: false });
      try {
        const { world } = await api.getWorld(id);
        if (token !== loadToken) return;
        if (world.kind === 'native') await settled;
        if (token !== loadToken) return;
        applyWorld(world, true);
        // Kept in sync with GitHub: opening it had Orb look for new commits there; show what came in.
        if (world.canEdit && world.repo) {
          setTimeout(() => {
            if (token !== loadToken) return;
            void api.getWorld(id).then(({ world: next }) => {
              const cur = get().world;
              if (token !== loadToken || cur?.id !== id || !next.tree || next.version <= cur.version) return;
              get().adoptVersion({ worldId: id, version: next.version, tree: next.tree, code: next.code ?? '', name: next.name });
            }, () => {});
          }, 6000);
        }
        if (world.canEdit) {
          if (world.kind === 'native' && !world.thumbUrl) scheduleThumb(world.id);
        } else {
          countPlay(world);
        }
      } catch (e) {
        if (token !== loadToken) return;
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
          set({ status: 'not-found', world: null, chatKey: 'new', canEdit: true, isExternal: false, previewCode: null, verified: true });
          void showBlankBehind(token);
        } else if (get().world?.id === id) {
          // Network trouble but we already show the public copy: stay read-only.
          set({ status: 'ready' });
        } else {
          set({ status: 'error', world: null, chatKey: 'new', previewCode: null, verified: true });
          void showBlankBehind(token);
        }
      }
    },

    async openWorld(id, opts) {
      if (get().world?.id === id && get().status === 'ready') return;
      // ?room= stays through the address's rewrite to /<owner>/<world>: the world reads it as orb.room.invited.
      const room = opts?.room && ROOM_NAME_RE.test(opts.room) ? `?room=${encodeURIComponent(opts.room)}` : '';
      navigate(`/w/${encodeURIComponent(id)}${room}`, 'push');
      await get().loadWorld(id);
    },

    async goStart(opts = {}) {
      const ui = useUi.getState();
      ui.setDraft(opts.prompt ?? '');
      ui.setIntro(null);
      ui.setHeroDone(!!opts.chat);
      if (opts.chat) ui.openPanel('chat', 'half');
      else ui.closePanel();
      navigate(opts.prompt ? `/?prompt=${encodeURIComponent(opts.prompt)}` : '/', opts.replace ? 'replace' : 'push');
      await get().loadTemplate(opts.template ?? 'blank');
      if (opts.prompt || opts.chat) ui.requestFocus();
    },

    preview(code) {
      set({ previewCode: code });
    },

    async createForBuild(threadId) {
      const s = get();
      if (s.world || s.status === 'loading' || s.status === 'idle') return null;
      const token = loadToken;
      try {
        // The canvas as it is (the template). It stays out of Explore until it has a thumbnail,
        // which is only taken after a real build.
        const { world } = await api.createWorld({ code: s.baseCode ?? '', template: s.templateId, authorName: getDisplayName() });
        carryThread('new', world.id, threadId);
        rememberWorldName(world.id, world.name);
        if (token === loadToken && !get().world && get().status !== 'loading') {
          // Same code as on screen: keep the frame as it is (no reload), just give it its identity
          // (and no opening cover: this world is the canvas that's already there, being built).
          set({ status: 'ready', world: { ...world, canEdit: true }, chatKey: world.id, canEdit: true, baseCode: s.baseCode ?? '', verified: true, drawn: true });
          navigate(worldHref(world), 'replace');
        }
        return { worldId: world.id, version: world.version };
      } catch (e) {
        console.warn('[orb] could not create the world up front', e);
        return null;
      }
    },

    adoptVersion({ worldId, version, tree, code, name }) {
      const w = get().world;
      if (name) rememberWorldName(worldId, name);
      if (!w || w.id !== worldId || version <= w.version) return;
      const next: WorldFull = { ...w, version, tree, code, ...(name ? { name } : {}) };
      // A world created when its first build started still runs under its canvas draft id: give
      // the frame its real identity now (shared storage, multiplayer).
      const adopt = get().frameId !== worldId ? { frameId: worldId } : {};
      set({ world: next, baseCode: code, previewCode: code, ...adopt });
      afterCommit(next);
      // A new name means a new readable address.
      if (name && name !== w.name)
        void api
          .getWorld(worldId)
          .then(({ world }) => {
            const cur = get().world;
            if (cur?.id !== worldId) return;
            set({ world: { ...cur, name: world.name, path: world.path } });
            navigate(worldHref(world) + window.location.search, 'replace');
          })
          .catch(() => {});
    },

    async restore(version) {
      const s = get();
      if (!s.world || !s.canEdit) return;
      const id = s.world.id;
      try {
        const old = await api.version(id, version);
        const code = old.code;
        const { world } = await api.updateWorld(id, old.tree ? { tree: old.tree, prompt: `Restored version ${version}` } : { code, prompt: `Restored version ${version}` });
        track('history_restore', { world_id: id, version });
        if (get().world?.id !== id) return;
        set({ world: { ...world, canEdit: true }, baseCode: code, previewCode: code });
        afterCommit(world);
      } catch (e) {
        toast(friendly(e, "Couldn't restore that version. Try again in a moment."), 'error');
        throw e;
      }
    },


    async rename(name) {
      const s = get();
      const clean = name.replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!s.world || !s.canEdit || !clean || clean === s.world.name) return;
      await get().patchWorld({ name: clean });
    },

    async refresh() {
      const id = get().world?.id;
      if (!id) return;
      try {
        const { world } = await api.getWorld(id);
        const now = get().world;
        if (now?.id !== world.id) return;
        // The code stays as shown (a build may be running); the address bar follows the new path.
        set({ world: { ...now, ...world, code: now.code, tree: now.tree, version: now.version }, canEdit: world.canEdit });
      } catch {
        /* the next visit shows it */
      }
    },

    async patchWorld(patch) {
      const s = get();
      if (!s.world || !s.canEdit) return;
      const before = s.world;
      const input: Parameters<typeof api.updateWorld>[1] = {};
      if (patch.name !== undefined && patch.name !== before.name) input.name = patch.name;
      if (patch.description !== undefined && patch.description !== before.description) input.description = patch.description;
      if (patch.visibility !== undefined && patch.visibility !== before.visibility) input.visibility = patch.visibility;
      if (patch.forkable !== undefined && patch.forkable !== before.forkable) input.forkable = patch.forkable;
      if (patch.tags !== undefined) input.tags = patch.tags;
      // Optimistic: the sheet reflects the change at once; anything else in the patch is local only.
      set({ world: { ...before, ...patch } });
      if (!Object.keys(input).length) return;
      try {
        const { world } = await api.updateWorld(before.id, input);
        if (get().world?.id === world.id) set({ world: { ...get().world!, ...world, canEdit: true } });
        if (input.name) rememberWorldName(world.id, world.name);
      } catch (e) {
        if (get().world?.id === before.id) set({ world: { ...get().world!, ...pick(before, Object.keys(input) as (keyof WorldFull)[]) } });
        toast(friendly(e, "Couldn't save that change. Try again in a moment."), 'error');
      }
    },

    async remix(sourceId) {
      const id = sourceId ?? get().world?.id;
      if (!id) return null;
      const token = ++loadToken;
      try {
        const { world } = await api.fork(id, getDisplayName());
        track('remix', { world_id: world.id, from_world: id, how: 'button' });
        if (token !== loadToken) return null; // the user went elsewhere meanwhile; the copy is in their worlds
        navigate(worldHref(world), 'push');
        applyWorld({ ...world, canEdit: true }, true);
        // The chat opens on the copy (its header now says "by you").
        const template = world.template && world.template !== 'blank' ? TEMPLATE_BY_ID[world.template] : undefined;
        const ui = useUi.getState();
        ui.setIntro({ text: `Your copy of ${world.forkedFrom?.name ?? world.name}. What should we change?`, suggestions: template?.suggestions ?? CHANGE_CHIPS, chatKey: world.id });
        ui.openPanel('chat', 'half');
        scheduleThumb(world.id);
        return world.id;
      } catch (e) {
        toast(friendly(e, "Couldn't make a copy right now. Try again in a moment."), 'error');
        return null;
      }
    },

    async like() {
      const w = get().world;
      if (!w) return;
      const optimistic = { ...w, liked: !w.liked, likes: Math.max(0, w.likes + (w.liked ? -1 : 1)) };
      set({ world: optimistic });
      try {
        const { liked, likes } = await api.like(w.id);
        track('like', { world_id: w.id, liked });
        const cur = get().world;
        if (cur?.id === w.id) set({ world: { ...cur, liked, likes } });
        window.dispatchEvent(new Event('orb:likes-changed'));
      } catch {
        const cur = get().world;
        if (cur?.id === w.id) set({ world: { ...cur, liked: w.liked, likes: w.likes } });
        toast("Couldn't save your like. Try again in a moment.", 'error');
      }
    },

    async deleteWorld() {
      const w = get().world;
      if (!w || !w.canEdit) return;
      try {
        await api.deleteWorld(w.id);
        toast(`Deleted “${w.name}”`);
        await get().goStart({ replace: true });
      } catch (e) {
        toast(friendly(e, "Couldn't delete this world. Try again in a moment."), 'error');
      }
    },

    frameReady() {
      if (!get().drawn) set({ drawn: true });
      // A world that is still settling restarts the thumbnail wait (up to a limit).
      if (thumb && Date.now() - thumb.since < THUMB_GIVE_UP) {
        clearTimeout(thumb.timer);
        thumb.timer = setTimeout(captureThumb, THUMB_DELAY);
      }
    },

    worldCaptured(dataUrl) {
      const s = get();
      if (s.world && s.canEdit && !s.isExternal) void uploadThumb(s.world.id, dataUrl);
    },
  };
});

function pick<T extends object>(o: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) out[k] = o[k];
  return out;
}

/**
 * BuildHost mode for the current viewer: edit (their own world, or the start canvas) or just ask.
 * In someone else's world the chat answers in place; a change request gets the offer of their own
 * copy ("Make my own copy"), which then builds it there.
 */
export function buildModeFor(s: Pick<WorldState, 'world' | 'canEdit' | 'isExternal'>): 'build' | 'ask' {
  if (!s.world) return 'build';
  if (s.isExternal) return 'ask';
  return s.canEdit ? 'build' : 'ask';
}

// The address bar shows the world's readable URL (/<owner>/<world>) — also after it gets its first
// name, is renamed, or was opened through an old /w/<id> or earlier path.
if (typeof window !== 'undefined') {
  useWorld.subscribe((s, prev) => {
    const w = s.world;
    if (!w?.path || (w === prev.world && s.status === prev.status) || s.status !== 'ready') return;
    const here = window.location.pathname;
    const onWorldUrl = here === '/' || here.startsWith('/w/') || /^\/[^/]+\/[^/]+\/?$/.test(here);
    if (onWorldUrl && here !== `/${w.path}`) navigate(worldHref(w) + window.location.search, 'replace');
  });
}
