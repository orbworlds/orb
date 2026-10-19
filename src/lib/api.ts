'use client';
// Typed client for Orb's HTTP API (SPEC §6). Every call sends the device key.

import { getDeviceKey } from './local';
import type {
  ApiConfig,
  BillingInfo,
  CreateWorldInput,
  LooksView,
  FriendRoom,
  FriendsData,
  FriendState,
  MeResponse,
  Person,
  Profile,
  ShopBought,
  ShopView,
  StoreRequest,
  UpdateWorldInput,
  WorldCard,
  WorldFull,
  WorldVersionInfo,
} from './types';

export interface GitHubConnection {
  login: string;
  /** Every world of theirs gets a private repository of its own. */
  auto: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

export function deviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-orb-device': getDeviceKey(), ...extra };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = deviceHeaders(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {});
  const res = await fetch(path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) }, credentials: 'same-origin' });
  if (!res.ok) {
    let body: { error?: string; message?: string; retryAfter?: number } = {};
    try {
      body = await res.json();
    } catch {}
    throw new ApiError(res.status, body.error || 'http_error', body.message || `Request failed (${res.status})`, body.retryAfter);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

/** A world's address: its readable /<owner>/<world> path when it has one, else /w/<id>. */
export function worldHref(w: { id: string; path?: string | null }): string {
  return w.path ? `/${w.path}` : `/w/${encodeURIComponent(w.id)}`;
}

export const api = {
  config: () => call<ApiConfig>('/api/config'),
  me: () => call<MeResponse>('/api/me'),
  updateMe: (name: string) => call<MeResponse>('/api/me', { method: 'PATCH', body: JSON.stringify({ name }) }),

  resolvePath: (handle: string, slug: string) => call<{ id: string }>(`/api/paths?handle=${encodeURIComponent(handle)}&slug=${encodeURIComponent(slug)}`),
  listWorlds: (params: { sort?: 'trending' | 'featured' | 'popular' | 'played' | 'liked' | 'views' | 'new'; q?: string; tag?: string; verified?: boolean; kind?: 'native' | 'external'; limit?: number; cursor?: string; mine?: boolean; liked?: boolean; remixable?: boolean } = {}) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== false) sp.set(k, v === true ? '1' : String(v));
    return call<{ worlds: WorldCard[]; nextCursor?: string }>(`/api/worlds?${sp}`);
  },
  /** Let the Orb kit that showed this code push worlds as this browser (src/server/kit.ts). */
  approveKit: (code: string) => call<{ name: string | null }>('/api/kit/approve', { method: 'POST', body: JSON.stringify({ code }) }),
  importRepo: (url: string) => call<{ world: WorldFull; files: number; warning?: string }>('/api/worlds/import', { method: 'POST', body: JSON.stringify({ url }) }),
  getWorld: (id: string) => call<{ world: WorldFull }>(`/api/worlds/${enc(id)}`),
  createWorld: (input: CreateWorldInput) => call<{ world: WorldFull }>('/api/worlds', { method: 'POST', body: JSON.stringify(input) }),
  updateWorld: (id: string, input: UpdateWorldInput) => call<{ world: WorldFull }>(`/api/worlds/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteWorld: (id: string) => call<{ ok: true }>(`/api/worlds/${enc(id)}`, { method: 'DELETE' }),
  /** The world's GitHub repository (owner): 'sync' brings in new commits and sends new versions now, 'create' puts it in a new private repository. */
  worldGitHub: (id: string, action: 'sync' | 'create') => call<{ world: WorldFull }>(`/api/worlds/${enc(id)}/github`, { method: 'POST', body: JSON.stringify({ action }) }),
  unlinkGitHub: (id: string) => call<{ world: WorldFull }>(`/api/worlds/${enc(id)}/github`, { method: 'DELETE' }),
  /** The viewer's GitHub connection: their token, kept sealed on Orb, and whether every world of theirs gets a repository. */
  github: () => call<GitHubConnection | { login: null }>('/api/me/github'),
  connectGitHub: (token: string) => call<GitHubConnection>('/api/me/github', { method: 'POST', body: JSON.stringify({ token }) }),
  keepWorldsOnGitHub: (auto: boolean) => call<GitHubConnection>('/api/me/github', { method: 'POST', body: JSON.stringify({ auto }) }),
  disconnectGitHub: () => call<{ login: null }>('/api/me/github', { method: 'DELETE' }),
  versions: (id: string) => call<{ versions: WorldVersionInfo[] }>(`/api/worlds/${enc(id)}/versions`),
  version: (id: string, v: number) => call<{ version: number; code: string; tree?: string | null }>(`/api/worlds/${enc(id)}/versions/${v}`),
  /** The world's files as a zip (for its owner, or a world that can be remixed). */
  worldZip: async (id: string) => {
    const res = await fetch(`/api/worlds/${enc(id)}/zip`, { headers: deviceHeaders(), credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, 'http_error', 'Couldn’t download this world.');
    return res.blob();
  },
  fork: (id: string, authorName?: string) => call<{ world: WorldFull }>(`/api/worlds/${enc(id)}/fork`, { method: 'POST', body: JSON.stringify({ authorName }) }),
  uploadThumb: async (id: string, blob: Blob) => {
    const res = await fetch(`/api/worlds/${enc(id)}/thumb`, { method: 'PUT', body: blob, headers: deviceHeaders({ 'content-type': blob.type || 'image/webp' }) });
    if (!res.ok) throw new ApiError(res.status, 'thumb_failed', 'Thumbnail upload failed');
    return (await res.json()) as { thumbVersion: number };
  },
  play: (id: string) => call<{ plays: number }>(`/api/worlds/${enc(id)}/play`, { method: 'POST', body: '{}' }),
  like: (id: string) => call<{ liked: boolean; likes: number }>(`/api/worlds/${enc(id)}/like`, { method: 'POST', body: '{}' }),
  store: (id: string, req: StoreRequest) => call<{ value: unknown }>(`/api/worlds/${enc(id)}/store`, { method: 'POST', body: JSON.stringify(req) }),
  signUp: (username: string, password: string) => call<MeResponse>('/api/auth/signup', { method: 'POST', body: JSON.stringify({ username, password }) }),
  signIn: (username: string, password: string) => call<MeResponse>('/api/auth/signin', { method: 'POST', body: JSON.stringify({ username, password }) }),
  setPassword: (password: string) => call<MeResponse>('/api/auth/password', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => call<{ ok: true }>('/api/auth/logout', { method: 'POST', body: '{}' }),

  friends: () => call<FriendsData>('/api/friends'),
  /** "I'm in this world" while it's on screen (null: not any more), for Explore's playing-now. */
  here: (worldId: string | null) => call<{ ok: true }>('/api/here', { method: 'POST', body: JSON.stringify({ worldId }) }),
  syncFriends: (worldId: string | null, rooms: FriendRoom[] = []) => call<FriendsData>('/api/friends/sync', { method: 'POST', body: JSON.stringify({ worldId, rooms }) }),
  addFriend: (username: string) => call<{ state: FriendState; person: Person; friends: FriendsData }>('/api/friends', { method: 'POST', body: JSON.stringify({ username }) }),
  acceptFriend: (id: string) => call<{ friends: FriendsData }>(`/api/friends/${enc(id)}`, { method: 'POST', body: '{}' }),
  removeFriend: (id: string) => call<{ friends: FriendsData }>(`/api/friends/${enc(id)}`, { method: 'DELETE' }),
  invite: (worldId: string, to: string[]) => call<{ invited: number }>('/api/friends/invite', { method: 'POST', body: JSON.stringify({ worldId, to }) }),
  readNotes: (ids?: number[]) => call<{ ok: true }>('/api/friends/read', { method: 'POST', body: JSON.stringify(ids ? { ids } : {}) }),
  friendsWorlds: () => call<{ worlds: WorldCard[] }>('/api/friends/worlds'),
  remixes: (id: string) => call<{ worlds: WorldCard[] }>(`/api/worlds/${enc(id)}/remixes`),
  shop: (id: string) => call<ShopView>(`/api/worlds/${enc(id)}/shop`),
  buy: (id: string, item: string, price: number) => call<ShopBought>(`/api/worlds/${enc(id)}/shop`, { method: 'POST', body: JSON.stringify({ item, price }) }),
  buildWithEarnings: () => call<BillingInfo>('/api/billing/earnings', { method: 'POST', body: '{}' }),
  cashOut: () => call<{ payout: { credits: number; amount: number; currency: string; requested: boolean; pending: boolean }; billing: BillingInfo }>('/api/billing/payouts', { method: 'POST', body: '{}' }),
  payoutSetup: (country: string | null, from: string) => call<{ url: string }>('/api/billing/payouts/setup', { method: 'POST', body: JSON.stringify({ country, from }) }),
  payoutDashboard: (from: string) => call<{ url: string }>('/api/billing/payouts/dashboard', { method: 'POST', body: JSON.stringify({ from }) }),
  looks: () => call<LooksView>('/api/looks'),
  setLook: (change: { color?: string | null; wear?: string[] }) => call<LooksView>('/api/looks', { method: 'PATCH', body: JSON.stringify(change) }),
  buyLook: (item: string, price: number) => call<LooksView>('/api/looks/buy', { method: 'POST', body: JSON.stringify({ item, price }) }),
  profile: (handle: string) => call<{ profile: Profile }>(`/api/people/${enc(handle)}`),

  billing: () => call<BillingInfo>('/api/billing'),
  /** A Stripe Checkout page for Pro ('pro') or a credit pack (its id); `from` is where to come back to. */
  checkout: (item: string, from: string) => call<{ url: string }>('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ item, from }) }),
  portal: (from: string) => call<{ url: string }>('/api/billing/portal', { method: 'POST', body: JSON.stringify({ from }) }),
};

/** Tell friends this page went away (works while the page unloads). */
export function leaveFriends(): void {
  try {
    navigator.sendBeacon?.('/api/friends/sync', new Blob([JSON.stringify({ leave: true })], { type: 'application/json' }));
  } catch {
    /* they'll see you go offline a minute later */
  }
}

/** A maker's page: /<handle>. */
export function profileHref(handle: string): string {
  return `/${encodeURIComponent(handle)}`;
}

/** Root-relative thumbnail URL helper for native worlds. */
export function thumbPath(id: string, version: number): string {
  return `/api/worlds/${enc(id)}/thumb?v=${version}`;
}
