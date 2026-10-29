'use client';
// React hook that owns the chat threads of a world and orchestrates builds. Every build is an
// agent job on Orb's server (./client.ts) that works on the world's files and saves its versions:
// the page follows it (narration, file steps, live previews of the files, the saved versions),
// answers its looks at the world, and starts one automatic repair round when the saved world
// shows runtime errors.
//
// The logic lives in a framework-free BuildEngine (an external store with a stable snapshot);
// useBuild() is a thin useSyncExternalStore adapter. Long async builds therefore never read stale
// React state, and the engine is testable in node with a fake host.
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type {
  BuildHandle,
  BuildInfo,
  BuildMode,
  BuildRequest,
  ChatMessage,
  ChatThread,
  ModelMessage,
  ModelSettings,
  ProbeRequest,
  ProbeResult,
  ProbeUnavailable,
  WorldRuntimeError,
} from '../types';
import { getModelSettings, listChats, loadChatMessages, saveChatMessages, saveChatThread } from '../local';
import { BuildError, DETACH, loadTreeEntry, resumeBuild as defaultResumeBuild, runBuild as defaultRunBuild, sendLookAnswer, type AgentLook, type AgentVersion, type BuildHooks } from './client';
import { treePath, withTree } from '../tree';
import { ProtocolParser, type ProtocolEvent } from './protocol';
import { BUILD_LIMITS, isBuildImage, PHOTOS_ONLY } from './prompt';
import { keepSent, sentPhotos, type Photo } from '../photos';

export interface BuildHost {
  /** Stable key for chat threads: world id, or 'new' on the start canvas. */
  chatKey: string;
  mode: BuildMode;
  worldName: string;
  worldId: string | null;
  /** The world's saved code (a repair round only runs while it is unchanged). */
  getCode(): string;
  /** Current saved version (null for unsaved drafts) — recorded as `fromVersion` for undo. */
  getVersion(): number | null;
  /** Push intermediate code to the live preview (debounce is handled by the hook). */
  preview(code: string): void;
  /** False while the world on screen is still being confirmed (e.g. ownership after a reload). */
  isSettled?(): boolean;
  /**
   * Start canvas only: create the world right away when the first build starts, so the build
   * works on a real world from the first second — it survives switching worlds and reloading like
   * any other. Null if that failed (the build can't start without a world).
   */
  createWorld?(threadId: string): Promise<{ worldId: string; version: number } | null>;
  /** Code the frame shows right now (lets a running build re-show its progress if it got replaced). */
  getPreview?(): string | null;
  /** A build that kept running after the user moved on to another world has finished. */
  onBackgroundDone?(info: BackgroundBuild & { status: BuildInfo['status']; error?: string }): void;
  /** The server saved a new version of the world (show it if it's on screen). */
  adoptVersion?(v: AgentVersion & { code: string }): void;
  /** Restore a previous version (undo). */
  restore(version: number): Promise<void>;
  /** Screenshot of the current world for the model (optional). */
  getImage?(): Promise<string | null>;
  /** Run the world on screen (once it shows `tree`), play it and report what it looks like (the agent's looks). */
  look?(req: { tree: string } & ProbeRequest, signal?: AbortSignal): Promise<ProbeResult | ProbeUnavailable>;
  /**
   * False once the world this host was made for is no longer the one on screen (the app moved on
   * but the new host hasn't been handed over yet). Previews are then dropped.
   */
  isCurrent?(): boolean;
}

/** A build running for a world that is not on screen (the user moved on while it builds). */
export interface BackgroundBuild {
  /** World id the build saves into ('new' while a start-canvas build hasn't created its world yet). */
  chatKey: string;
  worldName: string;
}

/** At most this many builds run at once (the one on screen + ones that kept going elsewhere). */
export const MAX_PARALLEL_BUILDS = 3;

/** The file change being made right now. */
export interface BuildProgress {
  stepId: string;
  label: string;
}

export interface UseBuild {
  threads: ChatThread[];
  threadId: string;
  messages: ChatMessage[];
  isBuilding: boolean;
  /** Seconds until the free tier allows another build, if rate limited. */
  retryAfter: number | null;
  /** The file change being made right now, if any. */
  progress: BuildProgress | null;
  /** Builds still running for other worlds. */
  background: BackgroundBuild[];
  /** Ask for something (with photos, when the person attached some). */
  send(text: string, photos?: Photo[]): Promise<void>;
  /** A request that failed (the newest answer is an error): ask it again, in its place. */
  retry(messageId: string): Promise<void>;
  stop(): void;
  undo(messageId: string): Promise<void>;
  newThread(): void;
  switchThread(id: string): void;
  /** Runtime errors from the world (used for the automatic repair round). */
  reportRuntimeError(e: WorldRuntimeError): void;
  /** Called by the host when the world finished loading after a preview. */
  reportReady(): void;
}

// ---------------------------------------------------------------------------------------------

type Source = (settings: ModelSettings, signal: AbortSignal, hooks: BuildHooks) => AsyncIterable<string>;

/** A build interrupted by a reload is picked up again for this long. */
const RESUME_WINDOW_MS = 7 * 86400_000; // long builds can run for days
/** How long a resumable build waits for its world to be on screen before it is marked stopped. */
const RESUME_WAIT_MS = 15_000;

export interface EngineOptions {
  runBuild?: (req: BuildRequest, settings: ModelSettings, signal: AbortSignal, hooks?: BuildHooks) => AsyncIterable<string>;
  /** Reconnect to a build still running on the server (after a reload). */
  resumeBuild?: (handle: BuildHandle, settings: ModelSettings, signal: AbortSignal, hooks?: BuildHooks) => AsyncIterable<string>;
  getSettings?: () => ModelSettings;
  /** Leading + trailing preview debounce. */
  previewDebounceMs?: number;
  /** How long to wait for host.getImage(). */
  imageTimeoutMs?: number;
  /** After the world reports ready, how long runtime errors still count towards a repair. */
  runtimeWindowMs?: number;
  /** Give up waiting for `ready` after this long (then check the errors collected so far). */
  readyTimeoutMs?: number;
  /** Throttle for persisting streaming messages to localStorage. */
  persistThrottleMs?: number;
  /** The page (index.html) of a file tree. */
  loadTree?: (tree: string) => Promise<string>;
  /** Answer a look (what the world showed, or why it can't be seen). */
  sendLook?: (job: string, id: string, answer: { result: ProbeResult } | ProbeUnavailable) => Promise<void>;
}

type Snapshot = Pick<UseBuild, 'threads' | 'threadId' | 'messages' | 'isBuilding' | 'retryAfter' | 'progress' | 'background'>;

interface Job {
  threadId: string;
  assistantId: string;
  userText: string;
  chatKey: string;
  /** World the build works on (null on the start canvas until it is created). */
  worldId: string | null;
  worldName: string;
  /** The host the build started on (its world gets the saved versions, wherever the user is by then). */
  host: BuildHost;
  /** `${worldId}@${version}` the build started from (a replay after a reload must be in that world). */
  base: string;
  /** Record the job's server handle, so a reload can pick the build up again. */
  resumable: boolean;
  /** The newest tree to preview (loaded latest-wins), and its page as previewed. */
  tree?: string;
  preview?: string;
  /** A saved version being taken over (finishing waits for it). */
  adopting?: Promise<void>;
  /** Looks that are over (a replayed request for one of them is not answered), and the one being answered. */
  looked?: Set<string>;
  looking?: Promise<void>;
  /** Releases the cross-tab lock held while this build runs. */
  release?: () => void;
  progress: BuildProgress | null;
  mode: BuildMode;
  /** Summarized prior turns (reused by the repair round). */
  history: ModelMessage[];
  /** The world's code: as the build started, then as of its newest saved version. */
  code: string;
  changed: boolean;
  title?: string;
  controller: AbortController;
  repaired: boolean;
  /** Narration separator for the first say of a repair round. */
  sayPrefix: string;
  streamError: string | null;
}

type RoundOutcome = { ok: true } | { stopped: true } | { error: BuildError };

/** A build of `host`'s world, as it starts. */
function newJob(host: BuildHost, f: Pick<Job, 'threadId' | 'assistantId' | 'userText' | 'history' | 'base'> & { release?: () => void }): Job {
  return {
    ...f,
    chatKey: host.chatKey,
    worldId: host.worldId,
    worldName: host.worldName,
    host,
    resumable: true,
    progress: null,
    mode: host.mode,
    code: host.getCode(),
    changed: false,
    controller: new AbortController(),
    repaired: false,
    sayPrefix: '',
    streamError: null,
  };
}

/** A look request waits this long before it is answered: replayed output brings its 'looked' frame right after. */
const LOOK_REPLAY_MS = 400;
const EMPTY: Snapshot = { threads: [], threadId: '', messages: [], isBuilding: false, retryAfter: null, progress: null, background: [] };
const REPAIR_REQUEST = 'Automatic check: some of those changes did not work (see <errors>). Please fix just these problems with minimal edits — nothing new.';

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function threadTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t ? clip(t, 48) : 'New chat';
}

/** Narration + "(built: …)" — how an assistant turn is shown to the model later. */
function summarizeAssistant(m: ChatMessage): string {
  const b = m.build;
  let s = m.text.trim();
  const built = b?.steps.filter((st) => st.status === 'done').map((st) => st.label) ?? [];
  if (built.length) s += `${s ? '\n' : ''}(built: ${built.join(', ')})`;
  if (b?.undone) s += `${s ? ' ' : ''}(the user undid these changes)`;
  else if (b?.status === 'stopped') s += `${s ? ' ' : ''}(stopped by the user)`;
  else if (b?.status === 'error' && !built.length) s += `${s ? '\n' : ''}(this build failed${b.error ? `: ${b.error}` : ''})`;
  return s.trim();
}

/** Last 10 turns, assistant turns summarized, every message within the server's limits. */
/** A message's photos, in words, for the AI's memory of the chat (it sees only a new message's own). */
function withPhotoNote(m: ChatMessage): string {
  const n = m.photos?.length ?? 0;
  if (!n) return m.text.trim();
  const note = `(${m.text.trim() ? 'with' : 'sent'} ${n === 1 ? 'a photo' : `${n} photos`})`;
  return m.text.trim() ? `${m.text.trim()}\n${note}` : note;
}

function summarizeHistory(prior: ChatMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of prior.slice(-20)) {
    const content = m.role === 'user' ? withPhotoNote(m) : summarizeAssistant(m);
    if (content) out.push({ role: m.role, content: clip(content, BUILD_LIMITS.messageChars) });
  }
  return out;
}

function formatRuntimeError(e: WorldRuntimeError): string {
  // Errors in a multi-file world's modules point at /api/tree/<sha>/<path>: name the file instead.
  const file = e.source && /\/api\/tree\//.test(e.source) ? ` in ${treePath(e.source)}` : '';
  const where = e.line ? ` (line ${e.line}${e.col ? `:${e.col}` : ''}${file})` : file;
  const stack = e.stack
    ? '\n' +
      e.stack
        .split('\n')
        .filter((l) => l.trim())
        .slice(0, 4)
        .map((l) => l.replace(/https?:\/\/[^\s)]*\/api\/tree\/[a-f0-9]{64}\//g, ''))
        .join('\n')
    : '';
  return clip(`Runtime error in the browser: ${e.message}${where}${stack}`, 1500);
}

function friendlyError(e: BuildError, provider: ModelSettings['provider']): string {
  if (e.code === 'ai_unavailable' && !/You → Model/.test(e.message)) {
    if (e.message) console.warn('[orb] AI unavailable:', e.message);
    if (provider === 'free') return 'The free builder is resting right now. You can keep building by adding your own AI key in You → Model.';
  }
  return e.message || 'Something went wrong. Please try again.';
}

/** A reload interrupted this build, but its job still runs on the server: it can be picked up again. */
function isResumable(m: ChatMessage): boolean {
  const b = m.build;
  return !!b && b.status === 'streaming' && b.handles?.[0]?.kind === 'agent' && !!b.base && Date.now() - m.createdAt < RESUME_WINDOW_MS;
}

/** A build still marked as streaming when loaded from storage was cut off (reload, closed tab). */
function settleInterrupted(m: ChatMessage): ChatMessage {
  const b = m.build;
  if (!b || b.status !== 'streaming' || isResumable(m)) return m;
  return {
    ...m,
    build: {
      ...b,
      handles: undefined,
      status: 'stopped',
      steps: b.steps.map((s) => (s.status === 'pending' ? { ...s, status: 'failed', error: 'Stopped before this step finished' } : s)),
    },
  };
}

/**
 * Cross-tab lock for one build (Web Locks): resolves with its release once held, or null when
 * `ifAvailable` and another tab holds it right now. Without Web Locks the build goes ahead.
 */
function lockBuild(id: string, ifAvailable = false): Promise<(() => void) | null> {
  const none = () => {};
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) return Promise.resolve(none);
  return new Promise((resolve) => {
    locks
      .request(`orb-build:${id}`, { ifAvailable }, (lock) => {
        if (!lock) return resolve(null);
        return new Promise<void>((release) => resolve(() => release()));
      })
      .catch(() => resolve(none));
  });
}

export class BuildEngine {
  private readonly runBuildFn: NonNullable<EngineOptions['runBuild']>;
  private readonly resumeBuildFn: NonNullable<EngineOptions['resumeBuild']>;
  /** The page is going away: running builds go on on the server; don't mark them stopped. */
  private unloading = false;
  private sending = false;
  private readonly resumed = new Set<string>();
  private resumeWait: { id: string; since: number } | null = null;
  private readonly getSettings: () => ModelSettings;
  private readonly opts: Required<Omit<EngineOptions, 'runBuild' | 'resumeBuild' | 'getSettings' | 'loadTree' | 'sendLook'>>;
  private readonly loadTree: (tree: string) => Promise<string>;
  private readonly sendLook: NonNullable<EngineOptions['sendLook']>;

  private host: BuildHost | null = null;
  private chatKey: string | null = null;
  private threadsForKey: ChatThread[] = [];
  /** The current thread while it has no messages yet (not persisted). */
  private draft: ChatThread | null = null;
  private threadId = '';
  private readonly cache = new Map<string, ChatMessage[]>();
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Every running build: the one for the world on screen and any that kept going elsewhere. */
  private readonly jobs = new Set<Job>();
  private retryAfter: number | null = null;
  private retryUntil = 0;
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPreview: string | null = null;
  private lastPreviewCode: string | null = null;
  /** Runtime reports for the most recent preview (reset on every preview push). */
  private runtime: { seq: number; errors: WorldRuntimeError[]; readyAt: number | null } = { seq: 0, errors: [], readyAt: null };
  private watch: { job: Job; timer: ReturnType<typeof setTimeout> } | null = null;

  private snapshot: Snapshot = EMPTY;
  private readonly listeners = new Set<() => void>();

  constructor(options: EngineOptions = {}) {
    this.runBuildFn = options.runBuild ?? defaultRunBuild;
    this.resumeBuildFn = options.resumeBuild ?? defaultResumeBuild;
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', () => {
        this.unloading = true;
        this.flushSaves();
      });
      window.addEventListener('pageshow', () => (this.unloading = false));
      // Newer messages arrived from the account (another device): drop stale cached copies.
      window.addEventListener('orb:chats-merged', (e) => {
        const ids = (e as CustomEvent<string[]>).detail ?? [];
        for (const id of ids) if (![...this.jobs].some((j) => j.threadId === id)) this.cache.delete(id);
        this.loadThreads();
        this.emit();
      });
    }
    this.getSettings = options.getSettings ?? getModelSettings;
    this.opts = {
      previewDebounceMs: options.previewDebounceMs ?? 450,
      imageTimeoutMs: options.imageTimeoutMs ?? 1500,
      runtimeWindowMs: options.runtimeWindowMs ?? 4000,
      readyTimeoutMs: options.readyTimeoutMs ?? 10_000,
      persistThrottleMs: options.persistThrottleMs ?? 1000,
    };
    this.loadTree = options.loadTree ?? loadTreeEntry;
    this.sendLook = options.sendLook ?? sendLookAnswer;
  }

  // -- external store ---------------------------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): Snapshot => this.snapshot;
  getServerSnapshot = (): Snapshot => EMPTY;

  /** The running build of the world on screen (a start canvas: of the current chat), if any. */
  private get job(): Job | null {
    return this.chatKey ? this.jobFor(this.chatKey, this.threadId) : null;
  }

  /** One build per world at a time; start-canvas builds are told apart by their chat. */
  private jobFor(chatKey: string, threadId?: string): Job | null {
    for (const j of this.jobs) if (j.chatKey === chatKey && (chatKey !== 'new' || j.threadId === threadId)) return j;
    return null;
  }

  /** Whether this build's world is the one on screen (only then may it touch the preview). */
  private onScreen(job: Job): boolean {
    return this.job === job && this.isCurrent(this.host);
  }

  private emit(): void {
    const current = this.job;
    const threads = this.draft && !this.threadsForKey.some((t) => t.id === this.draft!.id) ? [this.draft, ...this.threadsForKey] : this.threadsForKey;
    this.snapshot = {
      threads,
      threadId: this.threadId,
      messages: this.getMessages(this.threadId),
      isBuilding: !!current,
      retryAfter: this.retryAfter,
      progress: current?.progress ?? null,
      background: [...this.jobs].filter((j) => j !== current).map((j) => ({ chatKey: j.chatKey, worldName: j.worldName })),
    };
    for (const fn of this.listeners) fn();
  }

  // -- host & threads -----------------------------------------------------------------------------

  /** Called on every render with the latest host. Reacts to chatKey changes. */
  setHost = (host: BuildHost): void => {
    this.host = host;
    const prev = this.chatKey;
    if (prev === host.chatKey) {
      this.keepPreview(host);
      this.maybeResume();
      return;
    }
    this.chatKey = host.chatKey;
    const current = this.currentThread();
    // The chat carries over when this world grew out of it: the host moved it along (a visitor's
    // change forked the world), or a start-canvas chat whose build saved the world. Only such a
    // chat moves — an empty draft, or a canvas chat whose builds all failed, stays behind (it must
    // not show up inside whatever world is opened next).
    const saved = current && this.draft?.id !== current.id ? listChats().find((t) => t.id === current.id) : undefined;
    const carry =
      !!saved &&
      (saved.worldId === host.chatKey ||
        (prev === 'new' && host.chatKey !== 'new' && saved.worldId === 'new' && this.getMessages(saved.id).some((m) => m.build?.toVersion != null)));
    if (saved && carry) {
      if (saved.worldId !== host.chatKey) saveChatThread({ ...saved, worldId: host.chatKey });
      for (const j of this.jobs) if (j.threadId === saved.id) j.chatKey = host.chatKey;
      this.loadThreads();
    } else {
      // A different world. Builds in flight keep going in the background and still save into
      // their own world — but a preview still waiting for its debounce must never land here.
      this.cancelWatch();
      this.dropPendingPreview();
      this.loadThreads();
      // Back to a world that is still building: show that chat and where the build is at.
      const running = host.chatKey !== 'new' ? this.jobFor(host.chatKey) : null;
      const latest = host.chatKey !== 'new' ? this.threadsForKey[0] : undefined;
      if (running) this.selectThread(running.threadId);
      else if (latest) this.selectThread(latest.id);
      else this.startDraft();
      if (running?.changed) this.schedulePreview(running, running.preview ?? running.code);
    }
    this.emit();
    this.maybeResume();
  };

  /** A world that reloaded under a running build (e.g. its data refreshed) gets the build's code back. */
  private keepPreview(host: BuildHost): void {
    const job = this.job;
    const code = this.lastPreviewCode;
    if (!job?.changed || code === null || !host.getPreview || !this.isCurrent(host)) return;
    if (host.getPreview() !== code) {
      try {
        host.preview(code);
      } catch (e) {
        console.error('[orb] preview failed', e);
      }
    }
  }

  private loadThreads(): void {
    this.threadsForKey = listChats().filter((t) => t.worldId === this.chatKey);
  }

  private currentThread(): ChatThread | null {
    if (this.draft?.id === this.threadId) return this.draft;
    return this.threadsForKey.find((t) => t.id === this.threadId) ?? null;
  }

  private startDraft(): void {
    const now = Date.now();
    this.draft = { id: uid(), worldId: this.chatKey ?? 'new', title: 'New chat', createdAt: now, updatedAt: now };
    this.threadId = this.draft.id;
  }

  private selectThread(id: string): void {
    this.threadId = id;
    if (this.draft && this.draft.id !== id) this.draft = null;
  }

  newThread = (): void => {
    if (!this.chatKey) return;
    if (this.draft && this.draft.id === this.threadId) return; // already on a fresh chat
    this.startDraft();
    this.emit();
  };


  switchThread = (id: string): void => {
    if (id === this.threadId || !this.threadsForKey.some((t) => t.id === id)) return;
    this.selectThread(id);
    this.emit();
  };

  /** Persist the current draft thread once it gets its first message. */
  private ensureThreadPersisted(firstText: string): string {
    const t = this.currentThread();
    if (t && this.draft?.id === t.id) {
      const saved = { ...t, title: threadTitle(firstText), updatedAt: Date.now() };
      saveChatThread(saved);
      this.draft = null;
      this.loadThreads();
      if (!this.threadsForKey.some((x) => x.id === saved.id)) this.threadsForKey = [saved, ...this.threadsForKey];
    }
    return this.threadId;
  }

  private touchThread(threadId: string): void {
    const t = listChats().find((x) => x.id === threadId);
    if (t) saveChatThread({ ...t, updatedAt: Date.now() });
    this.loadThreads();
  }

  // -- messages ---------------------------------------------------------------------------------

  private getMessages(threadId: string): ChatMessage[] {
    if (!threadId) return [];
    let list = this.cache.get(threadId);
    if (!list) {
      list = this.draft?.id === threadId ? [] : loadChatMessages(threadId).map(settleInterrupted);
      this.cache.set(threadId, list);
    }
    return list;
  }

  private setMessages(threadId: string, list: ChatMessage[], persist: 'now' | 'soon'): void {
    this.cache.set(threadId, list);
    const pending = this.saveTimers.get(threadId);
    if (persist === 'now') {
      if (pending) clearTimeout(pending);
      this.saveTimers.delete(threadId);
      saveChatMessages(threadId, list);
    } else if (!pending) {
      this.saveTimers.set(
        threadId,
        setTimeout(() => {
          this.saveTimers.delete(threadId);
          saveChatMessages(threadId, this.cache.get(threadId) ?? []);
        }, this.opts.persistThrottleMs),
      );
    }
  }

  /** Update the job's assistant message through a mutable draft; publishes a new snapshot. */
  private patchAssistant(job: Job, fn: (d: { text: string; build: BuildInfo }) => void, persist: 'now' | 'soon' = 'soon'): void {
    const list = this.getMessages(job.threadId);
    const i = list.findIndex((m) => m.id === job.assistantId);
    if (i === -1) return;
    const cur = list[i];
    const d = { text: cur.text, build: { ...(cur.build ?? { status: 'streaming', steps: [] }), steps: (cur.build?.steps ?? []).map((s) => ({ ...s })) } };
    fn(d);
    const next = list.slice();
    next[i] = { ...cur, text: d.text, build: d.build };
    this.setMessages(job.threadId, next, persist);
    this.emit();
  }

  // -- preview & runtime ---------------------------------------------------------------------------

  private schedulePreview(job: Job, code: string): void {
    if (!this.onScreen(job)) return; // building in the background: the world isn't on screen
    this.pendingPreview = code;
    if (this.previewTimer) return; // the trailing edge will pick it up
    this.flushPreview(); // leading edge
    this.armPreviewTimer();
  }

  private armPreviewTimer(): void {
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      if (this.pendingPreview !== null) {
        this.flushPreview();
        this.armPreviewTimer();
      }
    }, this.opts.previewDebounceMs);
  }

  private dropPendingPreview(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.pendingPreview = null;
    this.lastPreviewCode = null;
  }

  private isCurrent(host: BuildHost | null): host is BuildHost {
    return !!host && (host.isCurrent ? host.isCurrent() : true);
  }

  private flushPreview(): void {
    const code = this.pendingPreview;
    this.pendingPreview = null;
    if (code === null || code === this.lastPreviewCode) return;
    if (this.host && !this.isCurrent(this.host)) return; // the world on screen changed meanwhile
    this.lastPreviewCode = code;
    this.runtime = { seq: this.runtime.seq + 1, errors: [], readyAt: null };
    try {
      this.host?.preview(code);
    } catch (e) {
      console.error('[orb] preview failed', e);
    }
  }

  reportRuntimeError = (e: WorldRuntimeError): void => {
    if (!e || typeof e.message !== 'string') return;
    const errs = this.runtime.errors;
    if (errs.length >= 8 || errs.some((x) => x.message === e.message && x.line === e.line)) return;
    errs.push(e);
  };

  reportReady = (): void => {
    if (this.runtime.readyAt === null) this.runtime.readyAt = Date.now();
  };

  private cancelWatch(): void {
    if (this.watch) clearTimeout(this.watch.timer);
    this.watch = null;
  }

  /** After a build saved the world, collect runtime errors until ~4 s after the world reports ready. */
  private startWatch(job: Job): void {
    this.cancelWatch();
    const seq = this.runtime.seq;
    const started = Date.now();
    const tick = () => {
      if (this.watch !== w) return;
      if (this.runtime.seq !== seq || this.job) {
        this.watch = null; // something newer is on screen
        return;
      }
      const now = Date.now();
      const ready = this.runtime.readyAt;
      const due = ready !== null ? now - ready >= this.opts.runtimeWindowMs : now - started >= this.opts.readyTimeoutMs;
      if (!due) {
        w.timer = setTimeout(tick, 150);
        return;
      }
      this.watch = null;
      if (this.runtime.errors.length) void this.repairRuntime(job, this.runtime.errors.slice());
    };
    const w = { job, timer: setTimeout(tick, 150) };
    this.watch = w;
  }

  // -- build flow ---------------------------------------------------------------------------------

  send = async (text: string, photos: Photo[] = []): Promise<void> => {
    const t = text.trim();
    const host = this.host;
    if ((!t && !photos.length) || !host || this.job || this.sending || !this.chatKey) return;
    this.cancelWatch();

    const threadId = this.ensureThreadPersisted(t || 'Photos');
    const prior = this.getMessages(threadId);
    const now = Date.now();
    const user: ChatMessage = { id: uid(), role: 'user', text: t, createdAt: now, ...(photos.length ? { photos: photos.map((p) => p.thumb) } : {}) };
    keepSent(user.id, photos);
    if (this.jobs.size >= MAX_PARALLEL_BUILDS) {
      const names = [...this.jobs].map((j) => `“${j.worldName}”`).join(', ');
      const wait: ChatMessage = {
        id: uid(),
        role: 'assistant',
        text: `I'm already building ${this.jobs.size} worlds at once (${names}). Give me a moment to finish one, then ask again!`,
        createdAt: now,
      };
      this.setMessages(threadId, [...prior, user, wait], 'now');
      this.touchThread(threadId);
      this.emit();
      return;
    }
    let fromVersion = host.getVersion();
    const assistant: ChatMessage = {
      id: uid(),
      role: 'assistant',
      text: '',
      createdAt: now,
      build: { status: 'streaming', steps: [], ...(fromVersion != null ? { fromVersion } : {}) },
    };
    // Persist the user's words before anything can fail.
    this.setMessages(threadId, [...prior, user, assistant], 'now');

    const job = newJob(host, { threadId, assistantId: assistant.id, userText: t || PHOTOS_ONLY, history: summarizeHistory(prior), base: '' });
    this.jobs.add(job);
    this.lastPreviewCode = null;
    this.emit();
    // Held while the build runs, so another tab never picks the same build up as "interrupted".
    job.release = (await lockBuild(assistant.id)) ?? undefined;

    // Every build works on a world: the start canvas becomes a real one now.
    if (job.worldId == null && host.createWorld) {
      this.sending = true;
      const made = await host.createWorld(threadId).catch(() => null);
      this.sending = false;
      if (made) {
        job.worldId = made.worldId;
        job.chatKey = made.worldId;
        fromVersion = made.version;
        this.patchAssistant(job, (d) => {
          d.build.fromVersion = made.version;
        }, 'now');
      }
    }
    if (job.worldId == null) {
      await this.finishJob(job, { error: new BuildError('network', "Couldn't make your new world — check your connection and try again.") });
      return;
    }
    job.base = `${job.worldId}@${fromVersion ?? ''}`;

    const shot = host.getImage ? await Promise.race([host.getImage().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), this.opts.imageTimeoutMs))]) : null;
    const req: BuildRequest = {
      worldId: job.worldId,
      messages: [...job.history, { role: 'user', content: clip(t || PHOTOS_ONLY, BUILD_LIMITS.messageChars) }],
      image: isBuildImage(shot) ? shot : null,
      ...(photos.length ? { photos: photos.slice(0, BUILD_LIMITS.photos).map((p) => p.full) } : {}),
      mode: job.mode,
      worldName: host.worldName,
    };

    const outcome = await this.runRound(job, (settings, signal, hooks) => this.runBuildFn(req, settings, signal, hooks));
    await this.finishJob(job, outcome);
  };

  // -- picking up a build after a reload ---------------------------------------------------------

  /** If the current chat ends in a build that a reload interrupted, reconnect to it. */
  private maybeResume(): void {
    const host = this.host;
    if (!host || this.job || this.sending || !this.threadId) return;
    const list = this.getMessages(this.threadId);
    const m = list[list.length - 1];
    if (!m || m.role !== 'assistant' || m.build?.status !== 'streaming' || this.resumed.has(m.id)) return;
    for (const j of this.jobs) if (j.assistantId === m.id) return; // still running here
    const settle = () => {
      this.resumed.add(m.id);
      this.setMessages(this.threadId, list.map((x) => (x.id === m.id ? settleInterrupted({ ...x, build: { ...x.build!, handles: undefined } }) : x)), 'now');
      this.emit();
    };
    if (!isResumable(m)) return settle();
    // The job saves versions as it goes, so the world may have moved on from its base: fine, as long as it is that world.
    if (!this.isCurrent(host) || (host.isSettled && !host.isSettled()) || !(m.build.base ?? '').startsWith(`${host.worldId}@`)) {
      // The world may still be loading: wait a little for it, then give up.
      if (this.resumeWait?.id !== m.id) {
        this.resumeWait = { id: m.id, since: Date.now() };
        setTimeout(() => this.maybeResume(), RESUME_WAIT_MS + 500); // look again even if nothing re-renders
      } else if (Date.now() - this.resumeWait.since > RESUME_WAIT_MS) settle();
      return;
    }
    this.resumeWait = null;
    this.resumed.add(m.id);
    // Another tab may still be running this very build: then leave it to that tab.
    void lockBuild(m.id, true).then((release) => release && this.resumeJob(m, list, release));
  }

  private async resumeJob(m: ChatMessage, list: ChatMessage[], release: () => void): Promise<void> {
    const host = this.host!;
    const i = list.findIndex((x) => x.id === m.id);
    const userMsg = list[i - 1]?.role === 'user' ? list[i - 1] : null;
    const handles = m.build!.handles!;
    const job = newJob(host, {
      threadId: this.threadId,
      assistantId: m.id,
      userText: userMsg?.text ?? '',
      history: summarizeHistory(list.slice(0, Math.max(0, userMsg ? i - 1 : i))),
      base: m.build!.base ?? '',
      release,
    });
    // The replay rebuilds the message from the start.
    this.patchAssistant(job, (d) => {
      d.text = '';
      d.build = { status: 'streaming', steps: [], handles, base: job.base, ...(d.build.fromVersion != null ? { fromVersion: d.build.fromVersion } : {}) };
    }, 'now');
    this.jobs.add(job);
    this.lastPreviewCode = null;
    this.emit();

    const handle: BuildHandle = handles[0];
    const outcome = await this.runRound(job, (settings, signal, hooks) => this.resumeBuildFn(handle, settings, signal, hooks));
    await this.finishJob(job, outcome);
  }

  stop = (): void => {
    this.cancelWatch();
    this.job?.controller.abort();
  };

  private repairRequest(job: Job, errors: string[]): BuildRequest {
    const assistant = this.getMessages(job.threadId).find((m) => m.id === job.assistantId);
    const summary = assistant ? summarizeAssistant(assistant) : '';
    return {
      worldId: job.worldId,
      messages: [
        ...job.history,
        { role: 'user', content: clip(job.userText, BUILD_LIMITS.messageChars) },
        { role: 'assistant', content: clip(summary || '(made some changes)', BUILD_LIMITS.messageChars) },
        { role: 'user', content: REPAIR_REQUEST },
      ],
      errors: errors.slice(0, BUILD_LIMITS.errors),
      image: null,
      mode: 'build',
      worldName: job.worldName,
    };
  }

  /** The repair round: runtime errors right after the build saved the world → one automatic round. */
  private async repairRuntime(job: Job, errors: WorldRuntimeError[]): Promise<void> {
    const host = this.host;
    if (this.job || job.repaired || !this.isCurrent(host) || host.chatKey !== job.chatKey) return;
    if (host.getCode() !== job.code) return; // the world changed since (undo, another edit…)
    if (!this.getMessages(job.threadId).some((m) => m.id === job.assistantId)) return;
    job.repaired = true;
    job.controller = new AbortController();
    this.jobs.add(job);
    this.lastPreviewCode = job.code;
    this.patchAssistant(job, (d) => {
      d.build.status = 'streaming';
      d.build.repair = true;
      delete d.build.error;
    });
    job.resumable = false; // a reload during this fix just leaves the (already saved) world as is
    const req = this.repairRequest(job, errors.map(formatRuntimeError));
    const outcome = await this.runRound(job, (settings, signal, hooks) => this.runBuildFn(req, settings, signal, hooks));
    await this.finishJob(job, outcome);
  }

  private async runRound(job: Job, source: Source): Promise<RoundOutcome> {
    job.streamError = null;
    const assistant = this.getMessages(job.threadId).find((m) => m.id === job.assistantId);
    job.sayPrefix = assistant?.text.trim() ? '\n\n' : '';
    const parser = new ProtocolParser();
    const settings = this.getSettings();
    try {
      const hooks: BuildHooks = {
        traceGroup: job.assistantId,
        onStatus: (thought) => {
          const m = this.getMessages(job.threadId).find((x) => x.id === job.assistantId);
          const fresh = !m?.build?.thinkingSince && !m?.text && !m?.build?.steps.length;
          if (!fresh && !thought) return;
          this.patchAssistant(job, (d) => {
            if (fresh) d.build.thinkingSince = Date.now();
            if (thought) d.build.thought = thought;
          });
        },
        onStep: (st) => {
          this.patchAssistant(job, (d) => {
            const at = d.build.steps.findIndex((x) => x.id === st.id);
            const step = { ...st };
            if (!d.build.steps.length) d.build.stepsAt = d.text.length;
            if (at === -1) d.build.steps.push(step);
            else d.build.steps[at] = step;
          });
          if (st.status === 'pending') job.progress = { stepId: st.id, label: st.label };
          else if (job.progress?.stepId === st.id) job.progress = null;
          this.emit();
        },
        onTree: (tree) => this.previewTree(job, tree),
        onVersion: (v) => void this.adoptVersion(job, v),
        onLook: (look) => this.answerLook(job, look),
        onLooked: (id) => (job.looked ??= new Set()).add(id),
        onHandle: (h) => {
          if (!job.resumable) return;
          this.patchAssistant(job, (d) => {
            d.build.handles = [h];
            d.build.base = job.base;
          }, 'now');
        },
      };
      for await (const chunk of source(settings, job.controller.signal, hooks)) {
        if (job.controller.signal.aborted) throw new BuildError('aborted', 'Stopped.');
        this.applyEvents(job, parser.push(chunk));
      }
      if (job.controller.signal.aborted) throw new BuildError('aborted', 'Stopped.');
      this.applyEvents(job, parser.end());
      // The server's words for the person, as they are.
      if (job.streamError) return { error: new BuildError('unknown', clip(job.streamError, 300)) };
      return { ok: true };
    } catch (e) {
      const err = e instanceof BuildError ? e : new BuildError('unknown', e instanceof Error ? e.message : String(e));
      if (err.code === 'aborted') {
        this.failPendingSteps(job, 'Stopped before this step finished');
        return { stopped: true };
      }
      // Keep what was said, fail the steps still open.
      this.applyEvents(job, parser.end());
      this.failPendingSteps(job, 'Interrupted');
      return { error: err };
    }
  }

  /** The files changed: preview the newest tree (a replay's burst of trees collapses). */
  private previewTree(job: Job, tree: string): void {
    job.tree = tree;
    setTimeout(() => {
      if (job.tree !== tree) return;
      this.loadTree(tree)
        .then((code) => {
          if (job.tree !== tree) return; // a newer one is on its way
          job.preview = withTree(code, tree);
          job.changed = true;
          this.schedulePreview(job, job.preview);
        })
        .catch((e) => console.warn('[orb] could not load the world files', e));
    }, 120);
  }

  /**
   * The agent wants to see the world run. The page that shows the world answers: it loads
   * the files, plays the world as asked and sends back what it saw. One look at a time; a look
   * whose 'looked' frame follows right after (a replay of the output after a reload) is skipped.
   */
  private answerLook(job: Job, look: AgentLook): void {
    const prev = job.looking ?? Promise.resolve();
    const arrived = new Promise((r) => setTimeout(r, LOOK_REPLAY_MS));
    job.looking = Promise.all([prev, arrived]).then(async () => {
      if (job.looked?.has(look.id) || job.controller.signal.aborted) return;
      const host = this.host;
      let answer: { result: ProbeResult } | ProbeUnavailable;
      if (!this.onScreen(job) || !host?.look) answer = { unavailable: 'The world is not on screen in the page that watches the build.' };
      else if (typeof document !== 'undefined' && document.visibilityState === 'hidden') answer = { unavailable: 'The page with the world is in the background right now, so the world is paused.' };
      else {
        this.previewTree(job, look.tree);
        try {
          const r = await host.look({ tree: look.tree, actions: look.actions, size: look.size, shots: look.shots, ...(look.viewport ? { viewport: look.viewport } : {}) }, job.controller.signal);
          answer = 'unavailable' in r ? r : { result: r };
        } catch (e) {
          answer = { unavailable: `The look failed in the page (${e instanceof Error ? e.message : String(e)}).` };
        }
      }
      if (job.looked?.has(look.id)) return;
      await this.sendLook(look.job, look.id, answer).catch((e) => console.warn('[orb] could not answer a look', e));
    });
  }

  /** The server saved a version: it is the build's result so far (and what undo goes back from). */
  private adoptVersion(job: Job, v: AgentVersion): void {
    const prev = job.adopting ?? Promise.resolve();
    job.adopting = prev.then(async () => {
      let code: string;
      try {
        code = await this.loadTree(v.tree);
      } catch (e) {
        console.warn('[orb] could not load the saved world', e);
        return;
      }
      job.code = code;
      job.changed = true;
      this.patchAssistant(job, (d) => {
        d.build.toVersion = v.version;
      });
      try {
        job.host.adoptVersion?.({ ...v, code });
      } catch (e) {
        console.error('[orb] adoptVersion failed', e);
      }
    });
  }

  private failPendingSteps(job: Job, error: string): void {
    job.progress = null;
    this.patchAssistant(job, (d) => {
      for (const s of d.build.steps) if (s.status === 'pending') Object.assign(s, { status: 'failed', error });
    });
  }

  /** What the job said: narration, the world's name, next ideas, the offer of a copy, a failure. (Its file steps come as frames.) */
  private applyEvents(job: Job, events: ProtocolEvent[]): void {
    if (!events.length) return;
    this.patchAssistant(job, (d) => {
      for (const e of events) {
        switch (e.type) {
          case 'say':
            if (e.delta) {
              d.text += job.sayPrefix + e.delta;
              job.sayPrefix = '';
            }
            break;
          case 'title':
            job.title = e.text;
            break;
          case 'suggest':
            d.build.suggestions = e.items;
            break;
          case 'remix':
            if (job.mode === 'ask') d.build.remix = true;
            break;
          case 'error':
            job.streamError = e.message;
            break;
        }
      }
    });
  }

  private async finishJob(job: Job, outcome: RoundOutcome): Promise<void> {
    await job.adopting;
    // The page is going away mid-build: leave it "streaming" so the next page load picks it up.
    if (this.unloading || job.controller.signal.reason === DETACH) {
      job.release?.();
      this.jobs.delete(job);
      this.flushSaves();
      return;
    }
    const onScreen = this.onScreen(job);
    const settings = this.getSettings();
    let status: BuildInfo['status'] = 'done';
    let error: string | undefined;
    let errorCode: string | undefined;
    let repairFailed: string | undefined;
    const saved = this.getMessages(job.threadId).find((m) => m.id === job.assistantId)?.build?.toVersion != null;
    if ('stopped' in outcome) status = 'stopped';
    else if ('error' in outcome && job.repaired && saved) {
      // The automatic fix after a saved build is a bonus: when it fails, the build still stands.
      const e = outcome.error;
      repairFailed = `${e.code}${e.status ? ` ${e.status}` : ''}: ${e.message}`.slice(0, 200);
      console.warn('[orb] the automatic fix failed', repairFailed);
    } else if ('error' in outcome) {
      status = 'error';
      error = friendlyError(outcome.error, settings.provider);
      errorCode = outcome.error.code;
      if (outcome.error.code === 'rate_limited' && settings.provider === 'free' && outcome.error.retryAfter) {
        this.startRetryCountdown(outcome.error.retryAfter);
      }
    }

    this.jobs.delete(job);
    job.release?.();
    job.release = undefined;
    job.progress = null;
    this.patchAssistant(
      job,
      (d) => {
        d.build.status = status;
        if (error) d.build.error = error;
        else delete d.build.error;
        if (errorCode) d.build.errorCode = errorCode;
        else delete d.build.errorCode;
        if (repairFailed) d.build.repairFailed = repairFailed;
        delete d.build.handles; // finished: nothing to reconnect to
        delete d.build.base;
        delete d.build.thinkingSince;
        delete d.build.thought;
      },
      'now',
    );
    this.touchThread(job.threadId);
    this.emit();

    if (!onScreen) {
      try {
        this.host?.onBackgroundDone?.({ chatKey: job.chatKey, worldName: job.title || job.worldName, status, ...(error ? { error } : {}) });
      } catch (e) {
        console.error('[orb] onBackgroundDone failed', e);
      }
      return;
    }
    // The repair round: watch the freshly saved world for runtime errors.
    if (status === 'done' && job.mode === 'build' && !job.repaired && job.changed) this.startWatch(job);
  }

  private startRetryCountdown(seconds: number): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryUntil = Date.now() + seconds * 1000;
    this.retryAfter = Math.ceil(seconds);
    this.retryTimer = setInterval(() => {
      const left = Math.ceil((this.retryUntil - Date.now()) / 1000);
      if (left <= 0) {
        if (this.retryTimer) clearInterval(this.retryTimer);
        this.retryTimer = null;
        this.retryAfter = null;
      } else this.retryAfter = left;
      this.emit();
    }, 1000);
  }

  // -- undo ---------------------------------------------------------------------------------------

  retry = async (messageId: string): Promise<void> => {
    if (this.job || this.sending) return;
    const threadId = this.threadId;
    const list = this.getMessages(threadId);
    const i = list.findIndex((m) => m.id === messageId);
    const asked = list[i - 1];
    if (i !== list.length - 1 || list[i].build?.status !== 'error' || asked?.role !== 'user') return;
    this.setMessages(threadId, list.slice(0, i - 1), 'now');
    this.emit();
    // The same photos again: as sent in this page view, else the chat's own small copies.
    const fulls = sentPhotos(asked.id) ?? asked.photos ?? [];
    await this.send(asked.text, fulls.map((full, k) => ({ id: `${asked.id}-${k}`, full, thumb: asked.photos?.[k] ?? full })));
  };

  undo = async (messageId: string): Promise<void> => {
    const host = this.host;
    if (!host || this.job) return;
    const threadId = this.threadId;
    const list = this.getMessages(threadId);
    const i = list.findIndex((m) => m.id === messageId);
    const b = list[i]?.build;
    if (i === -1 || !b || b.undone || b.fromVersion == null) return;
    this.cancelWatch();
    await host.restore(b.fromVersion);
    this.lastPreviewCode = null;
    // Restoring an older version also removes everything built after it.
    const next = list.map((m, k) => (k >= i && m.build && !m.build.undone && (k === i || m.build.toVersion != null) ? { ...m, build: { ...m.build, undone: true } } : m));
    this.setMessages(threadId, next, 'now');
    this.emit();
  };

  /** Stop timers and any build in flight (component unmount). The engine stays usable. */
  dispose = (): void => {
    this.cancelWatch();
    // Stop listening, but leave server-side builds running (they can be picked up again).
    for (const j of this.jobs) j.controller.abort(DETACH);
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.flushSaves();
  };

  private flushSaves(): void {
    for (const [id, t] of this.saveTimers) {
      clearTimeout(t);
      saveChatMessages(id, this.cache.get(id) ?? []);
    }
    this.saveTimers.clear();
  }
}

// ---------------------------------------------------------------------------------------------

export function useBuild(host: BuildHost): UseBuild {
  const [engine] = useState(() => new BuildEngine());
  // Hand the latest host to the engine after every render (it reacts to chatKey changes).
  useLayoutEffect(() => {
    engine.setHost(host);
  });
  useEffect(() => engine.dispose, [engine]);
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getServerSnapshot);
  return useMemo(
    () => ({
      ...snap,
      send: engine.send,
      retry: engine.retry,
      stop: engine.stop,
      undo: engine.undo,
      newThread: engine.newThread,
      switchThread: engine.switchThread,
      reportRuntimeError: engine.reportRuntimeError,
      reportReady: engine.reportReady,
    }),
    [snap, engine],
  );
}
