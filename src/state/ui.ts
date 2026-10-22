'use client';
// UI state of the app shell: the Orb (position, panel, tabs), the sheets layered over the world,
// the shared composer draft and a few cross-component signals (focus requests, unread).
// Nothing here is persisted except the Orb's position (lib/local) and the world-name cache.
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { getOrbPosition, readJSON, setOrbPosition, writeJSON } from '@/lib/local';
import { PHONE_MEDIA } from '@/lib/keyboard';

export type PanelTab = 'chat' | 'you';
/** Mobile bottom sheet: 'half' holds the world's row and the chat (up to ~3/4 of the screen), 'full' up to nearly all of it (adding "← Explore"). */
type SheetDetent = 'half' | 'full';
export type OrbSide = 'left' | 'right';

/** Warm lead-in shown at the top of a fresh chat (e.g. right after picking a template). */
interface ChatIntro {
  text: string;
  suggestions: string[];
  /** chatKey the intro belongs to; it disappears when the world changes. */
  chatKey: string;
}

interface UiState {
  panelOpen: boolean;
  tab: PanelTab;
  detent: SheetDetent;
  /** The filter Explore opens on (e.g. 'remix'); its own default otherwise. */
  /** Someone asked for Explore (a world's "Explore", "See all"…): the home page, down at its worlds. */
  exploreRequest: number;
  /** Explore is scrolled down to its worlds (at home: past the invitation to make one). */
  exploreScrolled: boolean;
  shareOpen: boolean;
  historyOpen: boolean;
  /** The plans sheet (Free, Pro, credit packs). */
  plansOpen: boolean;
  unread: boolean;
  /** Orb dock: side of the screen + vertical position as a 0..1 fraction of the free height. */
  orb: { side: OrbSide; y: number };
  orbLoaded: boolean;
  /** Text being typed (shared by the hero composer and the chat composer). */
  draft: string;
  intro: ChatIntro | null;
  /** Incremented to ask the visible composer to take focus. */
  focusSeq: number;
  /** True once the user sent from (or left) the hero on this page view. */
  heroDone: boolean;
  /** Handle of the maker whose profile sheet is open. */
  profile: string | null;
  /** Incremented to ask the You tab's account card to open its sign-up form. */
  signupSeq: number;
  /** The You tab's Advanced section (your own AI, GitHub), once opened or closed; null = not yet. */
  advancedOpen: boolean | null;
  /** A repository a link asked to import (?import=, src/state/links.ts): the You tab's import form opens with it. */
  importUrl: string | null;

  openPanel(tab?: PanelTab, detent?: SheetDetent): void;
  closePanel(): void;
  setTab(tab: PanelTab): void;
  setDetent(d: SheetDetent): void;
  /** Go to Explore, which is the home page's worlds (on `filter`, e.g. 'remix'). The shell does it. */
  requestExplore(): void;
  setShare(open: boolean): void;
  setHistory(open: boolean): void;
  setPlans(open: boolean): void;
  setUnread(v: boolean): void;
  setDraft(text: string): void;
  setExploreScrolled(v: boolean): void;
  setIntro(intro: ChatIntro | null): void;
  setHeroDone(v: boolean): void;
  openProfile(handle: string): void;
  closeProfile(): void;
  /** The You tab with its sign-up form open. */
  requestSignup(): void;
  setAdvanced(open: boolean): void;
  setImportUrl(url: string | null): void;
  requestFocus(): void;
  loadOrb(): void;
  moveOrb(side: OrbSide, y: number): void;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1);

export const useUi = create<UiState>((set, get) => ({
  panelOpen: false,
  tab: 'chat',
  detent: 'half',
  exploreRequest: 0,
  exploreScrolled: false,
  shareOpen: false,
  historyOpen: false,
  plansOpen: false,
  unread: false,
  orb: { side: 'right', y: 0.72 }, // mid-right: worlds rarely put controls there (bottom bars, top HUDs)
  orbLoaded: false,
  draft: '',
  intro: null,
  focusSeq: 0,
  heroDone: false,
  profile: null,
  signupSeq: 0,
  advancedOpen: null,
  importUrl: null,

  openPanel(tab, detent) {
    set({ panelOpen: true, unread: false, ...(tab ? { tab } : {}), ...(detent ? { detent } : {}) });
  },
  closePanel() {
    set({ panelOpen: false, detent: 'half' });
  },
  setTab(tab) {
    set({ tab });
  },
  setDetent(detent) {
    set({ detent });
  },
  requestExplore() {
    set({ exploreRequest: Date.now() });
  },
  setShare(shareOpen) {
    set({ shareOpen });
  },
  setHistory(historyOpen) {
    set({ historyOpen });
  },
  setPlans(plansOpen) {
    set({ plansOpen });
  },
  setUnread(unread) {
    set({ unread: unread && !get().panelOpen });
  },
  setDraft(draft) {
    set({ draft });
  },
  setIntro(intro) {
    set({ intro });
  },
  setHeroDone(heroDone) {
    set({ heroDone });
  },
  setExploreScrolled(exploreScrolled) {
    if (get().exploreScrolled !== exploreScrolled) set({ exploreScrolled });
  },
  openProfile(profile) {
    set({ profile });
  },
  closeProfile() {
    if (get().profile) set({ profile: null });
  },
  requestSignup() {
    set({ panelOpen: true, unread: false, tab: 'you', detent: 'full', profile: null, signupSeq: get().signupSeq + 1 });
  },
  setAdvanced(advancedOpen) {
    set({ advancedOpen });
  },
  setImportUrl(importUrl) {
    set({ importUrl });
  },
  requestFocus() {
    set({ focusSeq: get().focusSeq + 1 });
  },
  loadOrb() {
    const p = getOrbPosition();
    set({ orbLoaded: true, ...(p ? { orb: { side: p.x < 0.5 ? 'left' : 'right', y: clamp01(p.y) } } : {}) });
  },
  moveOrb(side, y) {
    const orb = { side, y: clamp01(y) };
    set({ orb });
    setOrbPosition({ x: side === 'left' ? 0 : 1, y: orb.y });
  },
}));

// --- media queries ------------------------------------------------------------------------------

function mediaStore(query: string) {
  return {
    subscribe(fn: () => void) {
      const mq = matchMedia(query);
      mq.addEventListener('change', fn);
      return () => mq.removeEventListener('change', fn);
    },
    get: () => matchMedia(query).matches,
  };
}
const mobileMq = mediaStore('(max-width: 639px)');
const reducedMq = mediaStore('(prefers-reduced-motion: reduce)');
const phoneMq = mediaStore(PHONE_MEDIA);

/** True below the 640px breakpoint (bottom-sheet layout). False during SSR. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(mobileMq.subscribe, mobileMq.get, () => false);
}
/** A touch screen with no mouse (`PHONE_MEDIA`). False during SSR. */
export function usePhone(): boolean {
  return useSyncExternalStore(phoneMq.subscribe, phoneMq.get, () => false);
}
export function useReducedMotion(): boolean {
  return useSyncExternalStore(reducedMq.subscribe, reducedMq.get, () => false);
}
/** Below the 640px breakpoint, right now (outside React). */
export const isMobile = () => mobileMq.get();

/** Once the element `id` is on screen (a tab mounting), do `then` with it; gives up after 20 frames. */
export function whenShown(id: string, then: (el: HTMLElement) => void): void {
  let tries = 0;
  const look = () => {
    const el = document.getElementById(id);
    if (el) then(el);
    else if (++tries < 20) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

// --- phones: the system Back closes the sheet, then a profile, before it leaves the page ----------
// Opening one adds a history entry at the same address; Back pops it and the layer closes (Shell's
// popstate asks popLayer first). Closing it in the page takes its entry back; going to another page
// from inside it reuses the entry (world.ts navigate), so Back then returns to where it was opened.

interface BackLayer {
  id: number;
  close(): void;
  /** Its history entry is still there. */
  entry: boolean;
}
const layers: BackLayer[] = [];
let layerSeq = 0;
/** The next popstate is the page taking a layer's entry back. */
let ownPop = false;

/** While `open`, the system Back closes this layer (`close`). */
export function useBackCloses(open: boolean, close: () => void): void {
  const onBack = useEffectEvent(close);
  useEffect(() => {
    if (!open) return;
    const layer: BackLayer = { id: ++layerSeq, close: () => onBack(), entry: true };
    history.pushState({ ...history.state, orbLayer: layer.id }, '');
    layers.push(layer);
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      if (layer.entry && history.state?.orbLayer === layer.id) {
        ownPop = true;
        history.back();
      }
    };
  }, [open]);
}

/** On popstate: whether it was a layer's entry (that layer is now closed), not a page to show. */
export function popLayer(): boolean {
  if (ownPop) {
    ownPop = false;
    return true;
  }
  const top = layers.findLast((l) => l.entry);
  if (!top || (history.state?.orbLayer ?? 0) >= top.id) return false;
  top.entry = false;
  top.close();
  return true;
}

/** Going to another page from inside a layer: true when it should take that layer's entry. */
export function takeLayerEntry(): boolean {
  const top = layers.findLast((l) => l.entry);
  if (!top || history.state?.orbLayer !== top.id) return false;
  top.entry = false;
  return true;
}

// --- world names (for "recent chats in other worlds") --------------------------------------------

const NAMES_KEY = 'orb:world-names';

/** Remember a world's display name locally so chat lists can say where a chat lives. */
export function rememberWorldName(id: string, name: string): void {
  if (!id || id === 'new') return;
  const all = readJSON<Record<string, string>>(NAMES_KEY, {});
  if (all[id] === name) return;
  delete all[id];
  all[id] = name;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - 150))) delete all[k];
  writeJSON(NAMES_KEY, all);
}
export function getWorldNames(): Record<string, string> {
  return readJSON<Record<string, string>>(NAMES_KEY, {});
}
