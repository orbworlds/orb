// Shared contract types for Orb. Used by client, server and engine.
// Changing a type here is a contract change — update SPEC.md too.

import type { Look, LookItem } from './looks';

export type { Look, LookItem } from './looks';

export type WorldKind = 'native' | 'external';
export type Visibility = 'public' | 'private';

/** Lightweight world summary for Explore grids and lists. */
export interface WorldCard {
  /** Readable path "<owner handle>/<world slug>" (null until assigned; /w/<id> always works). */
  path?: string | null;
  id: string;
  name: string;
  description: string;
  kind: WorldKind;
  authorName: string;
  verified: boolean;
  featured: number;
  tags: string[];
  /** Absolute or root-relative URL of the thumbnail image, or null if none yet. */
  thumbUrl: string | null;
  plays: number;
  likes: number;
  forks: number;
  forkable: boolean;
  visibility: Visibility;
  /** For external worlds: the embedded site URL. */
  externalUrl: string | null;
  /** Public source repository (GitHub) if known. */
  sourceUrl: string | null;
  /** Open-source worlds: the license of their code (e.g. "MIT"). */
  license?: string | null;
  forkedFrom: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  /** Curated worlds: where they came from (their maker's post, the prompt they shared). */
  origin?: WorldOrigin | null;
}

/** Where a curated world came from, as its maker shared it. Every field may be unknown. */
export interface WorldOrigin {
  /** The maker's post introducing it (on X, Hacker News, Reddit, YouTube, a blog…). */
  postUrl: string | null;
  /** "x", "hn", "reddit", "youtube", "blog", "github"… */
  platform: string | null;
  /** Views, likes of that post; stars of its repository. */
  views: number | null;
  likes: number | null;
  stars: number | null;
  /** When it was posted (ISO date). */
  postedAt: string | null;
  /** The maker's handle (@name on X, or their GitHub login) and page. */
  handle: string | null;
  authorUrl: string | null;
  /** The prompt they made it with, when they shared it. */
  prompt: string | null;
  /** What they made it with ("Claude Opus 5.5", "three.js"…). */
  madeWith: string | null;
}

/** Full world record as returned by GET /api/worlds/:id. */
export interface WorldFull extends WorldCard {
  /** HTML source for native worlds; null for external worlds. */
  code: string | null;
  template: string | null;
  version: number;
  /**
   * Multi-file worlds: sha of the file tree (served under /api/tree/<sha>/; `code` is its
   * index.html). Null for single-file worlds.
   */
  tree: string | null;
  thumbVersion: number;
  /** Whether the current viewer may edit this world. */
  canEdit: boolean;
  /** Whether the viewer liked it. */
  liked: boolean;
  /** Public remixes of it that their makers changed (GET /api/worlds/:id/remixes lists them). */
  remixes: number;
  /** The GitHub repository it's kept in sync with (only its owner is told; SPEC §2 "GitHub sync"). */
  repo?: WorldRepo | null;
}

/** A world kept in sync with a branch of a GitHub repository. */
export interface WorldRepo {
  /** owner/name */
  repo: string;
  branch: string;
  /** 'readonly': Orb follows the repository but can't push to it; 'error': see note. */
  state: 'ok' | 'readonly' | 'error';
  note: string | null;
  pulledAt: string | null;
  pushedAt: string | null;
  /** Orb sends the world's new versions there (its owner's GitHub token is kept on Orb, and can push). */
  push: boolean;
}

/** Something a world sells for credits (its page's `orb-shop` list, SPEC §7). `price` is in credits. */
export interface ShopItem {
  id: string;
  name: string;
  price: number;
  emoji: string | null;
  description: string | null;
}

/** GET /api/worlds/:id/shop: what it sells, and for the viewer what they own and their credits. */
export interface ShopView {
  items: ShopItem[];
  owned: string[];
  /** Null signed out. */
  credits: number | null;
  /** Of those, the ones paid for (Pro's, top-ups): spent first in worlds, and what earns their makers. */
  paid: number | null;
  /** The viewer can change this world: trying its shop costs them nothing. */
  mine: boolean;
  signedIn: boolean;
}

/** POST /api/worlds/:id/shop: what was bought, what the buyer owns here now and their credits after it. */
export interface ShopBought {
  item: ShopItem;
  owned: string[];
  /** Credits taken (0 when it was yours already, or your own world). */
  charged: number;
  credits: number;
  already: boolean;
}

export interface CreateWorldInput {
  name?: string;
  description?: string;
  code: string;
  template?: string | null;
  authorName?: string;
  /** Optional note for the first version (e.g. the prompt). */
  prompt?: string;
}

export interface UpdateWorldInput {
  name?: string;
  description?: string;
  code?: string;
  visibility?: Visibility;
  forkable?: boolean;
  tags?: string[];
  /** Note stored with the new version when code changes (usually the user's prompt). */
  prompt?: string;
  /** Multi-file worlds: switch to this (existing) file tree, e.g. to restore a version. */
  tree?: string;
}

export interface WorldVersionInfo {
  version: number;
  prompt: string | null;
  createdAt: string;
}

export interface UserInfo {
  id: string;
  name: string;
  /** The username: the account's handle in world URLs (/<handle>/<world>), and what signing in takes. */
  handle?: string | null;
  /** Whether the account has a password (accounts made with a passkey may not yet). */
  password?: boolean;
  /** Its blob's color and what it wears (src/lib/looks.ts). */
  look?: Look;
}

/** GET /api/looks: Orb's things for the blob, what the account owns and wears, and its credits. */
export interface LooksView {
  items: readonly LookItem[];
  owned: string[];
  look: Look;
  credits: number | null;
  signedIn: boolean;
}

export interface MeResponse {
  user: UserInfo | null;
  /** Public, non-secret short id for the device (first 12 hex chars of its hash). */
  deviceId: string;
  /** Display name used for anonymous creations on this device. */
  name: string;
}

// -- friends (src/server/friends.ts) -------------------------------------------------------------

/** Someone with an account. */
export interface Person {
  id: string;
  name: string;
  /** Their username: their profile is at /<handle>. Null for an account without one yet. */
  handle: string | null;
}

export interface Friend extends Person {
  /** Their page sent a heartbeat in the last minute and a half. */
  online: boolean;
  /** When they were last on Orb (ISO), or null if never since friends came along. */
  seenAt: string | null;
  /** The public world on their screen, while online. */
  world: WorldCard | null;
  /** That world is their own (they're making it, not playing someone else's). */
  own: boolean;
  /** The rooms of that world they're in, with their peer id in each (empty without a world). */
  rooms: FriendRoom[];
}

/** One of a world's rooms someone is in: `room` '' is the world's own, `peer` their id there. */
export interface FriendRoom {
  room: string;
  peer: string;
}

/** A friend request waiting for an answer, either way. */
export interface FriendRequest extends Person {
  at: string;
}

/**
 * `remix`: someone remixed one of your worlds and made it their own (`world` is the remix).
 * `sale`: things were bought in your world's shop (`world`; `sale` adds them up until you've seen it).
 */
export type FriendNoteKind = 'friend_request' | 'friend_accepted' | 'invite' | 'remix' | 'sale';

export interface FriendNote {
  id: number;
  kind: FriendNoteKind;
  /** Who did it (a remixer without an account: id '', handle null, the remix's maker name). */
  from: Person;
  /** The world an invite is for (invites to worlds that went private or away are left out). */
  world: WorldCard | null;
  at: string;
  read: boolean;
  /** `sale` notes: how many things, what you earned for them (credits), the latest item's name. */
  sale?: { count: number; credits: number; item: string };
}

export interface FriendsData {
  /** Playing or making something first, then online, then by when they were last here. */
  friends: Friend[];
  /** People asking you. */
  incoming: FriendRequest[];
  /** People you asked. */
  outgoing: FriendRequest[];
  /** Newest first, the last 30 days. */
  notes: FriendNote[];
  unread: number;
}

/** How the viewer stands with someone: 'requested' = the viewer asked, 'incoming' = they asked. */
export type FriendState = 'none' | 'you' | 'requested' | 'incoming' | 'friends';

/** A maker's page at /<handle>: who they are and their worlds. */
export interface Profile {
  handle: string;
  name: string;
  /** The account's id; null for a maker without an account (who can't be friends). */
  id: string | null;
  friend: FriendState;
  friendCount: number;
  /** When the account was made (ISO). */
  since: string | null;
  /** Only shown to friends: */
  online: boolean;
  world: WorldCard | null;
  own: boolean;
  /** The rooms of `world` they're in (see Friend). */
  rooms: FriendRoom[];
  worlds: WorldCard[];
}

export interface ApiConfig {
  /** True when server-side AI is configured (gateway or key). It may still fail at runtime. */
  ai: boolean;
  model: string;
  githubOAuth: boolean;
  realtime: { url: string; key: string } | null;
  passkeys: boolean;
}

// -- plans and credits (src/server/credits.ts, src/server/billing.ts) ------------------------------

/** 'guest': no account (credits per device). */
export type Plan = 'guest' | 'free' | 'pro';

export interface CreditPack {
  id: string;
  usd: number;
  credits: number;
}

export interface BillingInfo {
  plan: Plan;
  credits: {
    /** Credits left in all: this period's plan credits, then top-ups. */
    left: number;
    /** This period's plan credits, and how many of them are used. */
    monthly: number;
    used: number;
    /** Top-up credits left (they stay until used). */
    topup: number;
    /** Credits from earnings put into building (given, not bought). */
    bonus: number;
    /** When the plan credits refresh, or Pro renews (ISO). */
    periodEnd: string;
    /** Pro ends then instead of renewing (ISO). */
    cancelAt: string | null;
    /** Pro: the last payment didn't go through (Stripe tries again). */
    pastDue: boolean;
  };
  /** Orb takes payments here (Stripe is set up). */
  payments: boolean;
  /** The account has billing to manage in Stripe's portal. */
  manage: boolean;
  /** Accounts: credits earned in their worlds' shops not used yet, and all they ever earned. */
  earnings: {
    credits: number;
    total: number;
    /** Cash payouts (Stripe Connect), once they're open; null while closed. */
    payouts?: {
      /** The maker's payout account: none yet, set up but not finished with Stripe, or ready to be paid. */
      account: 'none' | 'pending' | 'ready';
      /** Credits that can be cashed out now: earned from other players' cleared purchases, less what was used. */
      payable: number;
      /** Fewest credits one payout sends. */
      minimum: number;
      holdDays: number;
      /** Different players behind the cashable earnings, and how many a cash-out needs. */
      buyers: number;
      minBuyers: number;
      /** Credits in a cash-out waiting for Orb's check. */
      requested: number;
      /** Credits paid out so far (or on their way). */
      paid: number;
      /** The currency payouts are sent in, and US$ per unit of it (a credit is a US cent). */
      currency: string | null;
      usdPer: number | null;
      /** The viewer's country as their connection says (a default for setting payouts up). */
      country?: string | null;
    } | null;
  } | null;
  plans: {
    free: number;
    pro: { credits: number; usd: number };
    topups: CreditPack[];
    /** Credits a typical build uses. */
    typicalBuild: number;
    /** What part of the paid credits spent in a world's shop its maker earns (1: all of it). */
    shopShare: number;
  };
}

export type StoreOp = 'get' | 'set' | 'incr' | 'push' | 'merge' | 'list';
export interface StoreRequest {
  op: StoreOp;
  /** The key (for `list`: the prefix of the keys to read, may be ''). */
  key: string;
  value?: unknown;
  by?: number;
  max?: number;
}

// ---------------------------------------------------------------------------
// Chat & build

export type BuildMode = 'build' | 'ask';

/** Message shape sent to the model (text only; assistant turns are summarized). */
export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A build: an agent job on Orb's server that works on the world's files, saves versions of the
 * world itself and keeps going without the page.
 */
export interface BuildRequest {
  /** The world it works on (every build needs one). */
  worldId?: string | null;
  /** Prior conversation (trimmed) + the new user message as the last item. */
  messages: ModelMessage[];
  /** Optional screenshot of the current world as a data URL (jpeg/webp, ≤ ~200 KB). */
  image?: string | null;
  /** Runtime errors to repair (the automatic repair round). */
  errors?: string[];
  /** 'build' edits the world; 'ask' only answers questions (e.g. visiting someone else's world without remixing). */
  mode: BuildMode;
  /** World name, for context. */
  worldName?: string;
}

export type StepStatus = 'pending' | 'done' | 'failed';
export interface BuildStep {
  id: string;
  kind: 'write' | 'edit';
  label: string;
  status: StepStatus;
  /** Reason for failure (e.g. "snippet not found"). */
  error?: string;
}

export interface BuildInfo {
  status: 'streaming' | 'done' | 'error' | 'stopped';
  steps: BuildStep[];
  /** World version before this build (for undo). */
  fromVersion?: number;
  /** World version saved after this build. */
  toVersion?: number;
  title?: string;
  suggestions?: string[];
  /** Ask mode: they asked to change someone else's world, so the page offers them their own copy. */
  remix?: boolean;
  error?: string;
  /** Why it failed, when the page offers a way out (out_of_credits: plans, top-ups, an account). */
  errorCode?: string;
  /** Credits the build used (both rounds), as Orb's server counted them. */
  credits?: number;
  /** True if this build was an automatic repair round. */
  repair?: boolean;
  /** Why the automatic fix after a saved build failed (not shown: the build stands; for analytics). */
  repairFailed?: string;
  /** Raw model output (kept for the code peek / debugging, truncated). */
  raw?: string;
  /** Set when the user undid this build. */
  undone?: boolean;
  /**
   * Where this build streams from on the server, while it runs: a page that reloads mid-build
   * reconnects through it and replays. (Chats saved before builds all ran as agent jobs may hold
   * other kinds; those can't be picked up again.)
   */
  handles?: BuildHandle[];
  /** The world (and version) the build started from: a replay is only valid in the same world. */
  base?: string;
  /** When the AI started thinking (before writing anything); cleared once text arrives. */
  thinkingSince?: number;
  /** The latest thing the AI said it is thinking about (shown while it builds). */
  thought?: string;
}

/** A build's agent job on the server, which a page can reconnect to. */
export type BuildHandle = { kind: 'agent'; id: string };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  build?: BuildInfo;
}

export interface ChatThread {
  id: string;
  /** World this chat belongs to ('new' for the start canvas before a world exists). */
  worldId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Settings (local only)

export type ModelProvider = 'free' | 'anthropic' | 'openrouter' | 'openai' | 'cursor';
export interface ModelSettings {
  provider: ModelProvider;
  /** API key for BYO providers (stored only in this browser). */
  apiKey?: string;
  /** Model id for BYO providers. Defaults per provider in engine/client.ts. */
  model?: string;
  /** Model options (Cursor: e.g. { effort: 'high', fast: 'true' }). */
  params?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Runtime bridge

export interface RoomPeer {
  id: string;
  name: string;
  color: string;
  /** What their blob wears (ids of src/lib/looks.ts). */
  wears?: string[];
  state?: unknown;
  /** The viewer's friend, as Orb's server vouches (their page told it this peer id is theirs). */
  friend?: boolean;
}
export type RoomEvent =
  /** `live` is false when nobody else can reach you: a solo room (drafts, over the room limits, while the builder
   *  plays the world) or a channel that wasn't up within 6 s. Peers that show up later still arrive as `join`. */
  | { type: 'joined'; self: RoomPeer; peers: RoomPeer[]; live?: boolean }
  | { type: 'join'; peer: RoomPeer }
  | { type: 'leave'; peer: RoomPeer }
  | { type: 'state'; peer: RoomPeer }
  | { type: 'message'; peer: RoomPeer; data: unknown };

export interface RuntimeContext {
  worldId: string;
  worldName: string;
  me: { id: string; name: string; color: string; wears?: string[] };
  /** localStorage snapshot for this world on this device. */
  storage: Record<string, string>;
  /** The room an invite link asked for (`?room=` on the world's page), as `orb.room.invited`. */
  room?: string | null;
}

export interface WorldRuntimeError {
  message: string;
  stack?: string;
  line?: number;
  col?: number;
  source?: string;
}

// ---------------------------------------------------------------------------
// Probe: the builder plays a world and looks at it (runtime 'probe', agent tool `look`)

/** One input or check during a probe. Screen positions are fractions of the viewport (0–1). */
export type ProbeAction =
  | { type: 'wait'; ms: number }
  /** Press (and hold for `ms`) a key or a chord like "Shift+w"; `times` taps it repeatedly. */
  | { type: 'key'; key: string; ms?: number; times?: number }
  | { type: 'type'; text: string }
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right'; double?: boolean; touch?: boolean }
  /** Move the pointer to (x, y), or by (dx, dy) pixels — mouse-look under pointer lock. */
  | { type: 'move'; x?: number; y?: number; dx?: number; dy?: number; ms?: number }
  | { type: 'drag'; x: number; y: number; to_x: number; to_y: number; ms?: number; touch?: boolean }
  | { type: 'scroll'; dy: number; x?: number; y?: number }
  /** `zoom`: only this part of the screen (fractions), in more detail. */
  | { type: 'screenshot'; label?: string; zoom?: ProbeZoom }
  /** JavaScript run in the world's page (global scope); the value of its last expression is returned. */
  | { type: 'eval'; js: string };

export interface ProbeZoom {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ProbeRequest {
  actions: ProbeAction[];
  /** Longest side of screenshots, in px. */
  size?: number;
  /** At most this many screenshots (an end screenshot is always taken). */
  shots?: number;
  /** Play it on a phone-sized screen (the person's page shows the world phone-sized meanwhile). */
  viewport?: 'phone';
}

export interface ProbeShot {
  label: string;
  /** ms since the world started. */
  t: number;
  dataUrl: string | null;
  /** The picture is (nearly) one flat color. */
  flat?: boolean;
  /** The part of the screen this screenshot shows, when zoomed in. */
  zoom?: ProbeZoom;
}

/** What a probe saw. Positions are fractions of the viewport. */
export interface ProbeResult {
  size: { w: number; h: number; dpr: number };
  title: string;
  /** ms since the world started. */
  uptime: number;
  fps: number;
  /** The world's WebGL is drawn by the CPU (no graphics chip): a low frame rate says little about real devices. */
  software?: boolean;
  errors: Array<{ message: string; line?: number; source?: string; t: number; during: boolean }>;
  logs: Array<{ level: 'log' | 'info' | 'warn' | 'debug' | 'error'; text: string; t: number }>;
  /** Console calls not kept (more than ~20 a second). */
  dropped: number;
  ui: Array<{ text: string; x: number; y: number; w: number; h: number; tag: string; click: boolean }>;
  canvas: { w: number; h: number; type: string; cover: number } | null;
  focus: string;
  locked: boolean;
  shots: ProbeShot[];
  evals: Array<{ js: string; result: string; error?: boolean }>;
  notes: string[];
}

/** A probe that couldn't run (the world isn't on screen, the tab is hidden…), for the agent. */
export interface ProbeUnavailable {
  unavailable: string;
}

export interface TemplateInfo {
  id: string;
  name: string;
  /** One-line pitch shown on the card. */
  blurb: string;
  /** Prompt suggestions shown after loading the template. */
  suggestions: string[];
  /** Static path of the template HTML (the blank island)… */
  path?: string;
  /** …or the Orb Original it is (its code, from its repository). */
  world?: string;
  /** Static path of the thumbnail. */
  thumb: string;
  /** Category tag used in Explore. */
  tag: 'world' | 'game' | 'art' | 'toy' | 'blank';
}
