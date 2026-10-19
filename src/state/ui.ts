'use client';
// UI state of the app shell: the Orb (position, panel, tabs), the sheets layered over the world,
// the shared composer draft and a few cross-component signals (focus requests, unread).
// Nothing here is persisted except the Orb's position (lib/local) and the world-name cache.
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { getOrbPosition, readJSON, setOrbPosition, writeJSON } from '@/lib/local';

export type PanelTab = 'chat' | 'you';
/** Mobile bottom-sheet height: 'half' keeps the world visible (e.g. while building). */
export type SheetDetent = 'half' | 'full';
export type OrbSide = 'left' | 'right';

/** Warm lead-in shown at the top of a fresh chat (e.g. right after picking a template). */
export interface ChatIntro {
  text: string;
  suggestions: string[];
  /** chatKey the intro belongs to; it disappears when the world changes. */
  chatKey: string;
}

interface UiState {
  panelOpen: boolean;
  tab: PanelTab;
  detent: SheetDetent;
  exploreOpen: boolean;
  /** The filter Explore opens on (e.g. 'remix'); its own default otherwise. */
  exploreFilter: string | null;
  /** Someone asked for Explore (the Orb's tab, "See all"…): the home page, down at its worlds. */
  exploreRequest: number;
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
  togglePanel(): void;
  setTab(tab: PanelTab): void;
  setDetent(d: SheetDetent): void;
  setExplore(open: boolean, filter?: string): void;
  /** Go to Explore, which is the home page's worlds (on `filter`, e.g. 'remix'). The shell does it. */
  requestExplore(filter?: string): void;
  setShare(open: boolean): void;
  setHistory(open: boolean): void;
  setPlans(open: boolean): void;
  setUnread(v: boolean): void;
  setDraft(text: string): void;
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
  detent: 'full',
  exploreOpen: false,
  exploreFilter: null,
  exploreRequest: 0,
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
    set({ panelOpen: false, detent: 'full' });
  },
  togglePanel() {
    if (get().panelOpen) get().closePanel();
    else get().openPanel();
  },
  setTab(tab) {
    set({ tab });
  },
  setDetent(detent) {
    set({ detent });
  },
  setExplore(exploreOpen, filter) {
    set({ exploreOpen, exploreFilter: exploreOpen ? (filter ?? null) : null });
  },
  requestExplore(filter) {
    set({ exploreRequest: Date.now(), exploreFilter: filter ?? null });
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
      if (typeof window === 'undefined') return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener('change', fn);
      return () => mq.removeEventListener('change', fn);
    },
    get: () => (typeof window === 'undefined' ? false : window.matchMedia(query).matches),
  };
}
const mobileMq = mediaStore('(max-width: 639px)');
const reducedMq = mediaStore('(prefers-reduced-motion: reduce)');

/** True below the 640px breakpoint (bottom-sheet layout). False during SSR. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(mobileMq.subscribe, mobileMq.get, () => false);
}
export function useReducedMotion(): boolean {
  return useSyncExternalStore(reducedMq.subscribe, reducedMq.get, () => false);
}
export function prefersReducedMotion(): boolean {
  return reducedMq.get();
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
