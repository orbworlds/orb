// World repository (SPEC §5–6): row mappers, queries and mutations for orb_worlds and friends,
// plus a little HTTP glue shared by the /api/worlds/* route handlers.
//
// Conventions
// - Parameterized SQL only. Arrays and JSON travel as JSON text (`$n::jsonb`) so the exact same
//   statements work on postgres.js (Supabase) and PGlite (local).
// - Multi-step writes that must be atomic are single statements with data-modifying CTEs
//   (the pooled connection runs in transaction mode, so there are no multi-statement transactions).
// - Owner hashes (owner_device / owner_user) never leave this module: mappers only emit the
//   public WorldCard / WorldFull shapes.

import { cache } from 'react';
import { CURATED_ORDER, PLAYS_THAT_COUNT } from '@/lib/curation';
import { KEYBOARD_TAG } from '@/lib/keyboard';
import { TEMPLATES } from '@/lib/templates';
import type { CreateWorldInput, StoreRequest, UpdateWorldInput, Visibility, WorldCard, WorldFull, WorldKind, WorldOrigin, WorldRepo, WorldVersionInfo } from '@/lib/types';
import { canEdit, randomId, touchDevice, type Viewer } from './auth';
import type { Db } from './db';
import { handle, json } from './http';
import { rateLimit } from './ratelimit';
import { assignPath } from './paths';
import { originsConfig } from './origins';
import { ENTRY, entryOf, FileError, getTree, isSha, putBlob, putTree, type Tree } from './files';
import { ready } from './schema';

// ---------------------------------------------------------------------------------------------
// Limits

export const LIMITS = {
  name: 60,
  description: 300,
  authorName: 40,
  prompt: 2000,
  /** World HTML, in UTF-8 bytes. */
  code: 3 * 1024 * 1024, // bounded by the 4.5 MB request limit of a Vercel function
  tags: 8,
  tagLength: 24,
  thumbBytes: 500 * 1024,
  storeKey: 64,
  /** Serialized JSON per stored value / pushed item, in bytes. */
  storeValue: 8 * 1024,
  storeListMax: 200,
  storeListDefault: 50,
  /** A pushed list is also trimmed (oldest first) to stay under this many bytes. */
  storeListBytes: 64 * 1024,
  /** Soft cap on distinct keys per world. */
  storeKeys: 1000,
  /** orb.store.list: keys, and serialized bytes, one call returns at most. */
  storeListKeys: 200,
  storeListResultBytes: 2 * 1024 * 1024,
  versionsKept: 50,
  listDefault: 24,
  listMax: 60,
  query: 100,
} as const;

export const UNTITLED = 'Untitled world';
const UNTITLED_RE = /^(untitled( world)?|new world)?$/i;
const THUMB_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const;
export type ThumbType = (typeof THUMB_TYPES)[number];

// ---------------------------------------------------------------------------------------------
// HTTP glue

/** An expected failure that maps to a JSON error response (`{ error, message, ...extra }`). */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public extra: Record<string, unknown> = {},
    public headers: Record<string, string> = {},
  ) {
    super(message ?? code);
  }
}

export function fail(status: number, code: string, message?: string, extra?: Record<string, unknown>): never {
  throw new HttpError(status, code, message, extra);
}

/** `handle()` plus HttpError → JSON error response. Wrap every route handler with this. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return handle(async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof HttpError) {
        return json({ error: e.code, message: e.message, ...e.extra }, { status: e.status, headers: e.headers });
      }
      throw e;
    }
  });
}

export interface IdContext {
  params: Promise<{ id: string }>;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isWorldId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

/** Resolve and validate the `[id]` route param (malformed ids are simply "not found"). */
export async function worldIdParam(ctx: IdContext): Promise<string> {
  const { id } = await ctx.params;
  if (!isWorldId(id)) fail(404, 'not_found', 'This world does not exist.');
  return id;
}

/** Count a hit against a rate limit; throws a 429 (with Retry-After) when exceeded. */
export async function limitOrThrow(db: Db, key: string, limit: number, windowSec: number, message = 'Slow down a little and try again in a moment.', cost = 1): Promise<void> {
  const r = await rateLimit(db, key, limit, windowSec, cost);
  if (!r.ok) {
    throw new HttpError(429, 'rate_limited', message, { retryAfter: r.retryAfter }, { 'retry-after': String(r.retryAfter) });
  }
}

/** Rate-limit identity for a viewer: device hash, else signed-in user, else client IP. */
export function actorKey(viewer: Viewer, ip: string): string {
  return viewer.deviceHash ?? (viewer.userId ? `u:${viewer.userId}` : `ip:${ip}`);
}

function requireIdentity(viewer: Viewer): void {
  if (!viewer.deviceHash && !viewer.userId) fail(400, 'device_required', 'Missing device key.');
}

/**
 * The signed-in user's id if that account still exists. A validly signed session cookie can
 * outlive its user row, and owner_user is a foreign key, so writes go through this.
 */
export async function sessionUser(db: Db, viewer: Viewer): Promise<string | null> {
  if (!viewer.userId) return null;
  const rows = await db.query<{ id: string }>(`select id from orb_users where id = $1`, [viewer.userId]);
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Input cleaning

// C0/C1 control characters except tab/newline (bidi overrides are stripped from single-line text).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const BIDI_RE = /[‪-‮⁦-⁩]/g;
/** Non-global (stateless) test for any control character, used for store keys. */
// eslint-disable-next-line no-control-regex
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function sliceChars(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : s;
}

/** Single-line display text: trimmed, whitespace collapsed, truncated to `max` characters. */
function cleanLine(v: unknown, max: number, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') fail(400, 'bad_request', `${field} must be a string.`);
  return sliceChars(v.replace(CONTROL_RE, '').replace(BIDI_RE, '').replace(/\s+/g, ' ').trim(), max);
}

/** Multi-line text (descriptions, prompts): keeps newlines, truncated to `max` characters. */
function cleanText(v: unknown, max: number, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') fail(400, 'bad_request', `${field} must be a string.`);
  return sliceChars(v.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '').replace(/\n{3,}/g, '\n\n').trim(), max);
}

function cleanCode(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) fail(400, 'invalid_code', 'A world needs some HTML code.');
  if (Buffer.byteLength(v, 'utf8') > LIMITS.code) {
    fail(413, 'too_large', `This world is too big to save (max ${LIMITS.code / 1024} KB).`);
  }
  return v;
}

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) fail(400, 'bad_request', 'tags must be an array of strings.');
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== 'string') fail(400, 'bad_request', 'tags must be an array of strings.');
    const tag = normalizeTag(t);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  if (out.length > LIMITS.tags) fail(400, 'too_many_tags', `At most ${LIMITS.tags} tags.`);
  return out;
}

function normalizeTag(t: string): string {
  return sliceChars(
    t
      .toLowerCase()
      .replace(/[^\p{L}\p{N} -]+/gu, '')
      .replace(/\s+/g, ' ')
      .trim(),
    LIMITS.tagLength,
  );
}

function cleanTemplate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(v) ? v : null;
}

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'bad_request', 'Expected a JSON object.');
  return body as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Rows & mappers

interface CardRow {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  external_url: string | null;
  source_url: string | null;
  author_name: string;
  visibility: string;
  forkable: boolean;
  forked_from: string | null;
  /** Name of the source world, only when it still exists and is public. */
  forked_from_name: string | null;
  template: string | null;
  verified: boolean;
  featured: number;
  tags: string[] | null;
  thumb_version: number;
  thumb_url: string | null;
  plays: number;
  likes: number;
  forks: number;
  created_at: Date | string;
  updated_at: Date | string;
  handle: string | null;
  slug: string | null;
  license: string | null;
  origin: unknown;
}

interface FullRow extends CardRow {
  code: string | null;
  tree: string | null;
  version: number;
  owner_device: string | null;
  owner_user: string | null;
  liked?: boolean;
  remixes?: number;
}

/** Public remixes of `w` that their makers changed (an untouched copy isn't one yet). */
const REMIXED = `r.forked_from = w.id and r.visibility = 'public' and r.version > 1`;

/** Ownership + access fields only (cheap to load for counters/store/thumb checks). */
interface MetaRow {
  id: string;
  name: string;
  kind: string;
  visibility: string;
  forkable: boolean;
  owner_device: string | null;
  owner_user: string | null;
}

const CARD_COLS = `w.id, w.name, w.description, w.kind, w.external_url, w.source_url, w.author_name, w.visibility,
  w.forkable, w.forked_from, case when f.visibility = 'public' then f.name end as forked_from_name, w.template,
  w.verified, w.featured, w.tags, w.thumb_version, w.thumb_url, w.plays, w.likes, w.forks, w.created_at, w.updated_at, w.handle, w.slug, w.license, w.origin`;
const CARD_FROM = `orb_worlds w left join orb_worlds f on f.id = w.forked_from`;
const META_COLS = `id, name, kind, visibility, forkable, owner_device, owner_user`;

function iso(v: Date | string): string {
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/** Root-relative URL of a native world's thumbnail (mirrors `thumbPath` in lib/api.ts). */
export function thumbPath(id: string, version: number): string {
  return `/api/worlds/${encodeURIComponent(id)}/thumb?v=${version}`;
}

export function toCard(r: CardRow): WorldCard {
  const kind: WorldKind = r.kind === 'external' ? 'external' : 'native';
  const thumbVersion = Number(r.thumb_version) || 0;
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? '',
    kind,
    authorName: r.author_name,
    verified: !!r.verified,
    featured: Number(r.featured) || 0,
    tags: Array.isArray(r.tags) ? r.tags : [],
    thumbUrl: kind === 'external' || thumbVersion === 0 ? safeImageUrl(r.thumb_url) : thumbPath(r.id, thumbVersion),
    plays: Number(r.plays) || 0,
    likes: Number(r.likes) || 0,
    forks: Number(r.forks) || 0,
    forkable: !!r.forkable,
    visibility: r.visibility === 'private' ? 'private' : 'public',
    // Rendered as iframe src / opened in new windows: never anything but an absolute http(s) URL.
    externalUrl: kind === 'external' ? safeEmbedUrl(r.external_url) : null,
    sourceUrl: safeWebUrl(r.source_url),
    forkedFrom: r.forked_from && r.forked_from_name ? { id: r.forked_from, name: r.forked_from_name } : null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    path: r.handle && r.slug ? `${r.handle}/${r.slug}` : null,
    license: r.license ?? null,
    origin: toOrigin(r.origin),
  };
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** A curated world's origin (src/data/seeds.json), with only http(s) links. */
function toOrigin(v: unknown): WorldOrigin | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const origin: WorldOrigin = {
    postUrl: safeWebUrl(typeof o.postUrl === 'string' ? o.postUrl : null),
    platform: text(o.platform, 24),
    views: count(o.views),
    likes: count(o.likes),
    stars: count(o.stars),
    postedAt: text(o.postedAt, 32),
    handle: text(o.handle, 64),
    authorUrl: safeWebUrl(typeof o.authorUrl === 'string' ? o.authorUrl : null),
    prompt: text(o.prompt, 1500),
    madeWith: text(o.madeWith, 60),
  };
  return Object.values(origin).some((x) => x !== null) ? origin : null;
}

export function toFull(r: FullRow, viewerCanEdit: boolean, liked: boolean): WorldFull {
  const card = toCard(r);
  return {
    ...card,
    code: card.kind === 'native' ? (r.code ?? '') : null,
    template: r.template,
    version: Number(r.version) || 0,
    tree: card.kind === 'native' ? (r.tree ?? null) : null,
    thumbVersion: Number(r.thumb_version) || 0,
    canEdit: viewerCanEdit,
    liked,
    remixes: Number(r.remixes) || 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Loading & access control

async function loadFull(db: Db, id: string, deviceHash: string | null = null): Promise<FullRow | null> {
  const rows = await db.query<FullRow>(
    `select ${CARD_COLS}, w.code, w.tree, w.version, w.owner_device, w.owner_user,
       ($2::text is not null and exists (select 1 from orb_likes l where l.world_id = w.id and l.device_hash = $2::text)) as liked,
       (select count(*) from orb_worlds r where ${REMIXED})::int as remixes
     from ${CARD_FROM} where w.id = $1`,
    [id, deviceHash],
  );
  return rows[0] ?? null;
}

async function loadMeta(db: Db, id: string): Promise<MetaRow | null> {
  const rows = await db.query<MetaRow>(`select ${META_COLS} from orb_worlds where id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Access check shared by all endpoints: missing worlds and private worlds the viewer doesn't own
 * are both "not found" (so private ids can't be probed). With `edit`, non-owners get a 403.
 */
async function access<T extends MetaRow>(db: Db, viewer: Viewer, row: T | null, edit = false): Promise<{ row: T; canEdit: boolean }> {
  if (!row) fail(404, 'not_found', 'This world does not exist.');
  const owner = await canEdit(db, viewer, row);
  if (row.visibility === 'private' && !owner) fail(404, 'not_found', 'This world does not exist.');
  if (edit && !owner) fail(403, 'forbidden', 'Only the owner can change this world.');
  return { row, canEdit: owner };
}

/** World as seen by `viewer` (null if missing, or private and not theirs). */
export async function getWorldForViewer(db: Db, viewer: Viewer, id: string): Promise<WorldFull | null> {
  if (!isWorldId(id)) return null;
  const row = await loadFull(db, id, viewer.deviceHash);
  if (!row) return null;
  const owner = await canEdit(db, viewer, row);
  if (row.visibility === 'private' && !owner) return null;
  const world = toFull(row, owner, !!row.liked);
  if (owner && world.kind === 'native') world.repo = await repoOf(db, id, row.owner_user, row.owner_device);
  return world;
}

/** The repository a world is kept in sync with (src/server/reposync.ts), as its owner sees it. */
async function repoOf(db: Db, id: string, ownerUser: string | null, ownerDevice: string | null): Promise<WorldRepo | null> {
  const owners = [...(ownerUser ? [`u:${ownerUser}`] : []), ...(ownerDevice ? [`d:${ownerDevice}`] : [])];
  const rows = await db.query<{ repo: string; branch: string; state: string; note: string | null; pulled_at: Date | null; pushed_at: Date | null; token: boolean }>(
    `select repo, branch, state, note, pulled_at, pushed_at, exists (select 1 from orb_github_tokens t where t.owner = any($2::text[])) as token
     from orb_world_repos where world_id = $1`,
    [id, owners],
  );
  const r = rows[0];
  if (!r) return null;
  const state = r.state === 'readonly' || r.state === 'error' ? r.state : 'ok';
  const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
  return { repo: r.repo, branch: r.branch, state, note: r.note, pulledAt: iso(r.pulled_at), pushedAt: iso(r.pushed_at), push: r.token && state !== 'readonly' };
}

async function viewWorld(db: Db, viewer: Viewer, id: string): Promise<WorldFull> {
  const world = await getWorldForViewer(db, viewer, id);
  if (!world) fail(404, 'not_found', 'This world does not exist.');
  return world;
}

/**
 * Public world for SSR/metadata (null if missing or private). `canEdit`/`liked` are always false.
 * Memoized per server render (generateMetadata + page + OG image share one query).
 */
export const getPublicWorld = cache(async (id: string): Promise<WorldFull | null> => {
  if (!isWorldId(id)) return null;
  const db = await ready();
  const row = await loadFull(db, id);
  if (!row || row.visibility !== 'public') return null;
  return toFull(row, false, false);
});

// ---------------------------------------------------------------------------------------------
// Listing (Explore, "my worlds")

export type ListSort = 'trending' | 'featured' | 'popular' | 'played' | 'liked' | 'views' | 'new';
export const LIST_SORTS: readonly ListSort[] = ['trending', 'featured', 'popular', 'played', 'liked', 'views', 'new'];

/** Explore's categories, as tags: a world is in the first one its tags name (art and toy are one category), else in its template's. */
export const CATEGORY_TAGS = ['game', 'world', 'art', 'toy'] as const;
export type CategoryTag = (typeof CATEGORY_TAGS)[number];

export interface ListParams {
  sort: ListSort;
  q?: string;
  tag?: string;
  verified?: boolean;
  /** Only Orb-made worlds ('native') or only embedded websites ('external'). */
  kind?: 'native' | 'external';
  mine?: boolean;
  /** Worlds the viewer liked (♥), on this device or any device of their account. */
  liked?: boolean;
  /** Only the curated worlds kept out of Explore (for the secret page). */
  hidden?: boolean;
  /** Only Orb worlds anyone may remix. */
  remixable?: boolean;
  limit: number;
  cursor?: string;
}

const SCORE = `(w.plays + 5 * w.likes + 8 * w.forks)`;
/** Most viewed: the views of its maker's post (curated worlds), or its plays on Orb if more. */
const VIEWS = `greatest(coalesce(case when jsonb_typeof(w.origin->'views') = 'number' then (w.origin->>'views')::float8 end, 0), w.plays::float8)`;

/** Public worlds that can be shown in a grid: named, with a picture, and not a copy of another. */
const SHOWABLE = [
  `w.visibility = 'public'`,
  `lower(btrim(w.name)) not in ('untitled world', '')`,
  `(w.kind = 'external' or w.thumb_version > 0 or w.thumb_url is not null)`,
  // A remix starts as a copy (version 1): it is listed once its owner has changed it.
  `(w.forked_from is null or w.version > 1)`,
];
/** What Explore lists: showable, not kept out by curation, and still loading. */
const LISTED = [...SHOWABLE, `not w.hidden`, `w.broken_at is null`];
/** Plays that earn a person's world its place in Explore's ranked lists (or one like, or Orb's pick). */
export const EARNED_PLAYS = 10;
/**
 * Explore's ranked lists (Trending, Most played, liked, viewed) show the curated worlds and people's
 * worlds that earned it; every listed world is under Newest, in search and on its maker's page.
 */
const EARNED = `((w.owner_user is null and w.owner_device is null) or w.featured > 0 or w.verified or w.likes > 0 or w.plays >= ${EARNED_PLAYS})`;

/** Engagement fades with this time constant (seconds): a half-life of about two days. */
const HEAT_TAU = 3 * 86400;
/** `heat` decayed to now, plus `by` — for an engagement event (a play, like or remix). */
const heatBump = (by: number) =>
  `heat = heat * exp(-greatest(0, extract(epoch from now() - heat_at)) / ${HEAT_TAU}) + ${by}, heat_at = now()`;

/**
 * Trending, as seen at snapshot time $t (epoch seconds; fixed per browsing session so pages don't
 * reshuffle). For now Orb's own order ($order: a JSON array of ids, src/lib/curation.ts) comes
 * first; after it: Orb's curation weight, what people are playing right now (decayed heat) and
 * all-time popularity — those two only once a world has PLAYS_THAT_COUNT plays — and a boost for
 * brand-new worlds so they get seen.
 */
const trendExpr = (t: string, order: string) => `coalesce(1000000 - array_position(array(select jsonb_array_elements_text(${order}::jsonb)), w.id), (
  3 * ln(1 + greatest(w.featured, 0))
  + case when w.plays >= ${PLAYS_THAT_COUNT} then
      3 * ln(1 + w.heat * exp(-greatest(0, ${t} - extract(epoch from w.heat_at)) / ${HEAT_TAU}))
      + 1.5 * ln(1 + ${SCORE})
    else 0 end
  + 7 * exp(-greatest(0, ${t} - extract(epoch from w.created_at)) / 172800)
))`;

/** Sort key per order: [SQL expression, cast for the cursor value]. All descending. */
const SORT_KEYS: Record<ListSort, Array<[string, string]>> = {
  // The score expression is filled in per request (it depends on the snapshot time).
  trending: [
    ['TREND', 'float8'],
    ['w.id', 'text'],
  ],
  featured: [
    ['w.featured', 'int'],
    ['w.verified::int', 'int'],
    [SCORE, 'int'],
    ['w.created_at', 'timestamptz'],
    ['w.id', 'text'],
  ],
  popular: [
    [SCORE, 'int'],
    ['w.created_at', 'timestamptz'],
    ['w.id', 'text'],
  ],
  played: [
    ['w.plays', 'int'],
    ['w.created_at', 'timestamptz'],
    ['w.id', 'text'],
  ],
  liked: [
    ['w.likes', 'int'],
    ['w.created_at', 'timestamptz'],
    ['w.id', 'text'],
  ],
  views: [
    [VIEWS, 'float8'],
    ['w.created_at', 'timestamptz'],
    ['w.id', 'text'],
  ],
  new: [
    ['w.created_at', 'timestamptz'],
    ['w.id', 'text'],
  ],
};

const flag = (v: string | null) => v === '1' || v === 'true';

export function parseListParams(sp: URLSearchParams): ListParams {
  const sortRaw = sp.get('sort');
  const mine = flag(sp.get('mine'));
  const liked = flag(sp.get('liked'));
  const sort: ListSort = LIST_SORTS.includes(sortRaw as ListSort) ? (sortRaw as ListSort) : mine || liked ? 'new' : 'trending';
  const limitRaw = Number.parseInt(sp.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(LIMITS.listMax, Math.max(1, limitRaw)) : LIMITS.listDefault;
  const q = (sp.get('q') ?? '').replace(CONTROL_RE, '').trim().slice(0, LIMITS.query) || undefined;
  const tag = (sp.get('tag') ?? '').split(',').map(normalizeTag).filter(Boolean).slice(0, 6).join(',') || undefined;
  const kindRaw = sp.get('kind');
  const kind = kindRaw === 'native' || kindRaw === 'external' ? kindRaw : undefined;
  return { sort, q, tag, verified: flag(sp.get('verified')), kind, mine, liked, remixable: flag(sp.get('remixable')), limit, cursor: sp.get('cursor') || undefined };
}

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

/** Opaque cursor = base64url(JSON { s: sort, k: [last row's sort key values], t?: snapshot }). */
function encodeCursor(sort: ListSort, keys: unknown[], t?: number): string {
  return Buffer.from(JSON.stringify({ s: sort, k: keys, ...(t ? { t } : {}) })).toString('base64url');
}

function decodeCursor(sort: ListSort, cursor: string): { keys: Array<string | number>; t?: number } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown; k?: unknown; t?: unknown };
    const keys = parsed.k;
    if (parsed.s === sort && Array.isArray(keys) && keys.length === SORT_KEYS[sort].length) {
      // Validate here so a forged cursor is a 400, not a Postgres cast error (500).
      const ok = keys.every((k, i) => {
        const type = SORT_KEYS[sort][i][1];
        if (type === 'int') return Number.isInteger(k) && Math.abs(k as number) <= 2_147_483_647;
        if (type === 'float8') return typeof k === 'number' && Number.isFinite(k);
        return typeof k === 'string' && k.length <= 128 && (type !== 'timestamptz' || TIMESTAMP_RE.test(k));
      });
      const t = parsed.t;
      const tOk = sort !== 'trending' || (typeof t === 'number' && Number.isFinite(t) && t > 1.6e9 && t < 4e9);
      if (ok && tOk) return { keys: keys as Array<string | number>, t: typeof t === 'number' ? t : undefined };
    }
  } catch {}
  fail(400, 'bad_cursor', 'Invalid cursor.');
}

/** Escape LIKE wildcards so user input matches literally. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function listWorlds(db: Db, viewer: Viewer, p: ListParams): Promise<{ worlds: WorldCard[]; nextCursor?: string }> {
  const params: unknown[] = [];
  const $ = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];

  if (p.mine) {
    if (!viewer.deviceHash && !viewer.userId) return { worlds: [] };
    const dev = $(viewer.deviceHash);
    const user = $(viewer.userId);
    // Same rule as canEdit(): owned by the session user, by this device, or by the device's linked user.
    where.push(`(w.owner_device = ${dev}::text or w.owner_user = ${user}::text
      or w.owner_user = (select d.user_id from orb_devices d where d.hash = ${dev}::text))`);
  } else if (p.liked) {
    if (!viewer.deviceHash && !viewer.userId) return { worlds: [] };
    const dev = $(viewer.deviceHash);
    const user = $(viewer.userId);
    // Likes are stored per device; a signed-in person sees the likes of all their devices.
    where.push(`exists (select 1 from orb_likes l where l.world_id = w.id and (l.device_hash = ${dev}::text
      or l.device_hash in (select d.hash from orb_devices d
        where d.user_id = coalesce(${user}::text, (select d2.user_id from orb_devices d2 where d2.hash = ${dev}::text)))))`);
    where.push(`w.visibility = 'public'`);
    where.push(`w.broken_at is null`);
  } else if (p.hidden) {
    where.push(...SHOWABLE, `w.hidden`);
  } else {
    where.push(...LISTED);
    if (p.sort !== 'new' && !p.q) where.push(EARNED);
  }
  if (p.q) {
    const q = $(likePattern(p.q));
    where.push(`(w.name ilike ${q} or w.description ilike ${q} or w.author_name ilike ${q})`);
  }
  if (p.tag) {
    // One tag, or several separated by commas (any of them).
    const list = p.tag.split(',').filter(Boolean);
    const tags = $(JSON.stringify(list));
    const templates = $(JSON.stringify(TEMPLATES.filter((t) => list.includes(t.tag)).map((t) => t.id)));
    const categories = $(JSON.stringify(CATEGORY_TAGS));
    // A category tag only counts as the world's first one, and its template only when its tags name none.
    where.push(`(exists (select 1 from unnest(w.tags) as t(tag) where lower(t.tag) in (select jsonb_array_elements_text(${tags}::jsonb)) and lower(t.tag) not in (select jsonb_array_elements_text(${categories}::jsonb)))
      or (select lower(t.tag) from unnest(w.tags) with ordinality as t(tag, i) where lower(t.tag) in (select jsonb_array_elements_text(${categories}::jsonb)) order by t.i limit 1) in (select jsonb_array_elements_text(${tags}::jsonb))
      or w.kind in (select jsonb_array_elements_text(${tags}::jsonb))
      or (not exists (select 1 from unnest(w.tags) as t(tag) where lower(t.tag) in (select jsonb_array_elements_text(${categories}::jsonb)))
        and (w.template in (select jsonb_array_elements_text(${tags}::jsonb)) or w.template in (select jsonb_array_elements_text(${templates}::jsonb)))))`);
  }
  if (p.verified) where.push(`w.verified`);
  if (p.remixable) where.push(`w.forkable and w.kind = 'native'`);
  if (p.kind) where.push(`w.kind = ${$(p.kind)}`);

  const cursor = p.cursor ? decodeCursor(p.sort, p.cursor) : null;
  // Trending is scored as of one moment for a whole browsing session (carried in the cursor).
  const snapshot = cursor?.t ?? Math.floor(Date.now() / 1000);
  const trend = p.sort === 'trending' ? trendExpr(`${$(snapshot)}::float8`, $(JSON.stringify(CURATED_ORDER))) : '';
  const keys = SORT_KEYS[p.sort].map(([expr, type]) => [expr === 'TREND' ? trend : expr, type] as [string, string]);
  if (cursor) {
    const values = cursor.keys;
    // Row-value comparison = "strictly after the cursor row" since every key sorts descending.
    // Cursor values travel as text and are cast in SQL: a `$n::timestamptz` parameter would make
    // postgres.js round-trip it through a JS Date, truncating microseconds (rows that share the
    // cursor row's millisecond — e.g. seeds inserted together — would be skipped).
    where.push(`(${keys.map(([expr]) => expr).join(', ')}) < (${values.map((v, i) => `${$(String(v))}::text::${keys[i][1]}`).join(', ')})`);
  }

  const rows = await db
    .query<CardRow & { k_score: number; k_views: number; k_created: string; k_trend?: number }>(
      `select ${CARD_COLS}, ${SCORE}::int as k_score, ${VIEWS} as k_views, w.created_at::text as k_created${trend ? `, ${trend}::float8 as k_trend` : ''}
       from ${CARD_FROM}
       where ${where.join(' and ')}
       order by ${keys.map(([expr]) => `${expr} desc`).join(', ')}
       limit ${$(p.limit + 1)}::int`,
      params,
    )
    .catch((e: unknown) => {
      // A forged cursor that passed the shape checks but not Postgres' casts (class 22: data exception).
      if (p.cursor && String((e as { code?: unknown })?.code ?? '').startsWith('22')) fail(400, 'bad_cursor', 'Invalid cursor.');
      throw e;
    });

  const page = rows.slice(0, p.limit);
  let nextCursor: string | undefined;
  if (rows.length > p.limit) {
    const last = page[page.length - 1];
    const keyOf: Record<string, unknown> = {
      'w.featured': Number(last.featured) || 0,
      'w.verified::int': last.verified ? 1 : 0,
      [SCORE]: Number(last.k_score) || 0,
      'w.plays': Number(last.plays) || 0,
      'w.likes': Number(last.likes) || 0,
      [VIEWS]: Number(last.k_views) || 0,
      'w.created_at': last.k_created,
      'w.id': last.id,
      [trend || 'TREND']: Number(last.k_trend),
    };
    nextCursor = encodeCursor(p.sort, keys.map(([expr]) => keyOf[expr]), p.sort === 'trending' ? snapshot : undefined);
  }
  return { worlds: page.map(toCard), nextCursor };
}

/**
 * Listed worlds at one owner's address (/<handle>/…: a profile) or made by some accounts (friends'
 * worlds), newest first.
 */
export async function worldsBy(db: Db, by: { handle: string } | { users: string[] }, limit = 24): Promise<WorldCard[]> {
  if ('users' in by && !by.users.length) return [];
  const rows = await db.query<CardRow>(
    `select ${CARD_COLS} from ${CARD_FROM}
     where ${LISTED.join(' and ')} and ${'handle' in by ? `w.handle = $1` : `w.owner_user = any($1::text[])`}
     order by w.updated_at desc limit $2::int`,
    ['handle' in by ? by.handle : by.users, limit],
  );
  return rows.map(toCard);
}

/** Public worlds by id, as cards (missing and private ones are left out). */
export async function publicCards(db: Db, ids: string[]): Promise<Map<string, WorldCard>> {
  const want = [...new Set(ids.filter(isWorldId))];
  if (!want.length) return new Map();
  const rows = await db.query<CardRow>(`select ${CARD_COLS} from ${CARD_FROM} where w.id = any($1::text[]) and w.visibility = 'public'`, [want]);
  return new Map(rows.map((r) => [r.id, toCard(r)]));
}

/**
 * Readable paths of the worlds Explore lists, curated first (for the sitemap). Curated worlds are
 * refreshed on every cold start, so only people's own worlds carry a meaningful `updatedAt`.
 */
export async function listedPaths(db: Db, limit = 5000): Promise<Array<{ path: string; updatedAt: string | null }>> {
  const rows = await db.query<{ handle: string; slug: string; updated_at: Date | string | null }>(
    `select w.handle, w.slug,
            case when w.owner_user is not null or w.owner_device is not null then w.updated_at end as updated_at
     from orb_worlds w
     where ${[...LISTED, `w.slug is not null`].join(' and ')}
     order by w.featured desc, ${SCORE} desc, w.created_at desc
     limit $1::int`,
    [limit],
  );
  return rows.map((r) => ({ path: `${r.handle}/${r.slug}`, updatedAt: r.updated_at ? iso(r.updated_at) : null }));
}

// ---------------------------------------------------------------------------------------------
// Create / update / delete

/**
 * Author name for new creations: the account's when signed in (a browser may still send the guest
 * name it had before signing up), else explicit → device name → "Someone".
 */
async function resolveAuthorName(db: Db, viewer: Viewer, given: string | undefined): Promise<string> {
  const rows = await db.query<{ account: string | null; device: string | null }>(
    `select (select nullif(btrim(name), '') from orb_users where id = $2::text) as account,
            (select nullif(btrim(name), '') from orb_devices where hash = $1::text) as device`,
    [viewer.deviceHash, viewer.userId],
  );
  return rows[0]?.account || given || rows[0]?.device || 'Someone';
}

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: unknown }).code === '23505';
}

/** Insert a world with a fresh random id (retrying on the astronomically unlikely collision). */
async function insertWithFreshId(run: (id: string) => Promise<string | null>): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(randomId(10));
    } catch (e) {
      if (attempt < 3 && isUniqueViolation(e)) continue;
      throw e;
    }
  }
}

export async function createWorld(db: Db, viewer: Viewer, body: unknown): Promise<WorldFull> {
  requireIdentity(viewer);
  const input = asObject(body) as Partial<Record<keyof CreateWorldInput, unknown>>;
  const code = cleanCode(input.code);
  const name = cleanLine(input.name, LIMITS.name, 'name') || UNTITLED;
  const description = cleanText(input.description, LIMITS.description, 'description') ?? '';
  const template = cleanTemplate(input.template);
  const prompt = cleanText(input.prompt, LIMITS.prompt, 'prompt') || null;
  const given = cleanLine(input.authorName, LIMITS.authorName, 'authorName') || undefined;

  const ownerUser = await sessionUser(db, viewer);
  if (!viewer.deviceHash && !ownerUser) fail(400, 'device_required', 'Missing device key.');
  await touchDevice(db, viewer, viewer.userId ? undefined : given);
  const authorName = await resolveAuthorName(db, viewer, given);

  const id = await insertWithFreshId(async (newId) => {
    const rows = await db.query<{ id: string }>(
      `with w as (
         insert into orb_worlds (id, name, description, kind, code, template, owner_device, owner_user, author_name, version)
         values ($1, $2, $3, 'native', $4, $5, $6, $7, $8, 1)
         returning id, code
       ), v as (
         insert into orb_world_versions (world_id, version, code, prompt) select id, 1, code, $9 from w
       )
       select id from w`,
      [newId, name, description, code, template, viewer.deviceHash, ownerUser, authorName, prompt],
    );
    return rows[0]?.id ?? null;
  });
  if (!id) throw new Error('world insert returned no row');
  await assignPath(db, id);
  return viewWorld(db, viewer, id);
}

export async function updateWorld(db: Db, viewer: Viewer, id: string, body: unknown): Promise<WorldFull> {
  const input = asObject(body) as Partial<Record<keyof UpdateWorldInput, unknown>>;
  const { row } = await access(db, viewer, await loadFull(db, id), true);
  // A world embedded from another site keeps its page there: its owner edits only how it's listed.
  if (row.kind !== 'native' && (input.code !== undefined || input.tree !== undefined || input.forkable !== undefined)) {
    fail(400, 'not_editable', 'This world lives on another site and cannot be edited here.');
  }

  const params: unknown[] = [id];
  const $ = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const sets: string[] = [];

  if (input.name !== undefined) sets.push(`name = ${$(cleanLine(input.name, LIMITS.name, 'name') || UNTITLED)}`);
  if (input.description !== undefined) sets.push(`description = ${$(cleanText(input.description, LIMITS.description, 'description') ?? '')}`);
  if (input.forkable !== undefined) {
    if (typeof input.forkable !== 'boolean') fail(400, 'bad_request', 'forkable must be a boolean.');
    sets.push(`forkable = ${$(input.forkable)}::boolean`);
  }
  if (input.tags !== undefined) {
    sets.push(`tags = array(select jsonb_array_elements_text(${$(JSON.stringify(cleanTags(input.tags)))}::jsonb))`);
  }
  if (input.visibility !== undefined) {
    const vis = input.visibility as Visibility;
    if (vis !== 'public' && vis !== 'private') fail(400, 'bad_request', "visibility must be 'public' or 'private'.");
    if (vis === 'private') {
      // Private worlds must survive losing this device, so they need an account.
      const user = await sessionUser(db, viewer);
      if (!user) fail(403, 'account_required', 'Sign in to make a world private.');
      sets.push(`owner_user = coalesce(owner_user, ${$(user)}::text)`);
    }
    sets.push(`visibility = ${$(vis)}`);
  }

  let code = input.code !== undefined ? cleanCode(input.code) : undefined;
  let tree: string | null | undefined;
  if (input.tree !== undefined) {
    // Switch to another (existing) file tree, e.g. restoring a version: its index.html is the code.
    if (!isSha(input.tree)) fail(400, 'bad_request', 'tree must be a file tree id.');
    const files = await getTree(db, input.tree);
    if (!files) fail(400, 'bad_request', 'That file tree does not exist.');
    tree = input.tree;
    code = await entryOf(db, files);
  } else if (code !== undefined && row.tree && code !== row.code) {
    // A multi-file world's page was edited by hand: same files, new page.
    tree = await withEntry(db, row.tree, code);
  }
  const codeChanged = (code !== undefined && code !== row.code) || (tree !== undefined && tree !== row.tree);

  if (codeChanged) {
    const prompt = cleanText(input.prompt, LIMITS.prompt, 'prompt') || null;
    if (tree !== undefined) sets.push(`tree = ${$(tree)}`);
    sets.push(`code = ${$(code ?? row.code ?? '')}`, `version = version + 1`, `updated_at = now()`);
    const promptRef = $(prompt);
    const kept = $(LIMITS.versionsKept);
    // Row lock on orb_worlds serializes concurrent saves, so version numbers never collide.
    const saved = await db.query<{ version: number }>(
      `with u as (
         update orb_worlds set ${sets.join(', ')} where id = $1 returning id, version, code, tree
       ), v as (
         insert into orb_world_versions (world_id, version, code, tree, prompt) select id, version, code, tree, ${promptRef} from u
       ), pruned as (
         delete from orb_world_versions where world_id = $1 and version <= (select version from u) - ${kept}::int
       )
       select version from u`,
      params,
    );
    if (row.forked_from && Number(saved[0]?.version) === 2) await creditRemix(db, id);
  } else if (sets.length) {
    sets.push(`updated_at = now()`);
    await db.query(`update orb_worlds set ${sets.join(', ')} where id = $1`, params);
  }
  // A new name (or an account owner) gives the world a new readable URL; old ones keep working.
  if (input.name !== undefined || input.visibility !== undefined) await assignPath(db, id);
  return viewWorld(db, viewer, id);
}

export async function deleteWorld(db: Db, viewer: Viewer, id: string): Promise<void> {
  await access(db, viewer, await loadMeta(db, id), true);
  // Versions, likes and store rows cascade. Remixes keep their forked_from id (shown as no source).
  await db.query(`delete from orb_worlds where id = $1`, [id]);
}

// ---------------------------------------------------------------------------------------------
// Versions

export async function listVersions(db: Db, viewer: Viewer, id: string): Promise<WorldVersionInfo[]> {
  const { canEdit: owner } = await access(db, viewer, await loadMeta(db, id));
  const rows = await db.query<{ version: number; prompt: string | null; created_at: Date | string }>(
    `select version, prompt, created_at from orb_world_versions where world_id = $1 order by version desc limit $2::int`,
    [id, LIMITS.versionsKept],
  );
  // Prompts can be personal; only the owner sees them.
  return rows.map((r) => ({ version: Number(r.version), prompt: owner ? r.prompt : null, createdAt: iso(r.created_at) }));
}

export async function getVersion(db: Db, viewer: Viewer, id: string, version: number): Promise<{ version: number; code: string; tree: string | null }> {
  await access(db, viewer, await loadMeta(db, id));
  const rows = await db.query<{ version: number; code: string; tree: string | null }>(
    `select version, code, tree from orb_world_versions where world_id = $1 and version = $2::int`,
    [id, version],
  );
  if (!rows[0]) fail(404, 'not_found', 'That version is no longer available.');
  return { version: Number(rows[0].version), code: rows[0].code, tree: rows[0].tree ?? null };
}

// ---------------------------------------------------------------------------------------------
// Multi-file worlds (see ./files.ts)

/** The tree with its index.html replaced by `code`. */
export async function withEntry(db: Db, treeSha: string, code: string): Promise<string> {
  const files = (await getTree(db, treeSha)) ?? {};
  const { sha } = await putBlob(db, code);
  return putTree(db, { ...files, [ENTRY]: sha });
}

/**
 * Save a new version of a world from a file tree (the server-side agent). `owner` must still be
 * allowed to edit the world. Returns the new version, or null if nothing changed.
 */
export async function commitTree(
  db: Db,
  owner: Viewer,
  id: string,
  tree: string,
  opts: { prompt?: string | null; name?: string | null; category?: CategoryTag | null; expect?: { tree: string | null } } = {},
): Promise<{ version: number; tree: string; code: string; name: string } | null> {
  const row = await loadFull(db, id);
  if (!row || row.kind !== 'native') fail(404, 'not_found', 'This world does not exist.');
  if (!(await canEdit(db, owner, row))) fail(403, 'forbidden', 'Only the owner can change this world.');
  const files = await getTree(db, tree);
  if (!files) throw new Error('commitTree: unknown tree');
  if (row.tree === tree) return null;
  const code = await entryOf(db, files);
  const name = opts.name ? cleanLine(opts.name, LIMITS.name, 'name') : undefined;
  const rename = !!name && UNTITLED_RE.test(row.name.trim());
  const params: unknown[] = [id, code, tree, (opts.prompt ?? '').slice(0, LIMITS.prompt) || null, LIMITS.versionsKept, rename ? name : null, !!opts.expect, opts.expect?.tree ?? null, opts.category && CATEGORY_TAGS.includes(opts.category) ? opts.category : null, JSON.stringify(CATEGORY_TAGS)];
  const rows = await db.query<{ version: number; name: string }>(
    `with u as (
       update orb_worlds set code = $2, tree = $3, version = version + 1, updated_at = now(), name = coalesce($6::text, name),
         tags = case when $9::text is not null and not exists (select 1 from unnest(tags) as t(tag) where lower(t.tag) in (select jsonb_array_elements_text($10::jsonb)))
           then array_prepend($9::text, tags) else tags end
       where id = $1 and (not $7::boolean or tree is not distinct from $8::text)
       returning id, version, code, tree, name
     ), v as (
       insert into orb_world_versions (world_id, version, code, tree, prompt) select id, version, code, tree, $4 from u
     ), pruned as (
       delete from orb_world_versions where world_id = $1 and version <= (select version from u) - $5::int
     )
     select version, name from u`,
    params,
  );
  if (!rows[0]) return null; // someone else saved meanwhile (`expect` didn't match)
  if (rename) await assignPath(db, id);
  if (row.forked_from && Number(rows[0].version) === 2) await creditRemix(db, id);
  return { version: Number(rows[0].version), tree, code, name: rows[0].name };
}

/** The world's current tree (single-file worlds get a one-file tree from their code). */
export async function worldTree(db: Db, id: string): Promise<{ tree: string; stored: string | null; files: Tree; code: string; version: number; name: string } | null> {
  const rows = await db.query<{ tree: string | null; code: string | null; version: number; name: string; kind: string }>(
    `select tree, code, version, name, kind from orb_worlds where id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r || r.kind !== 'native') return null;
  let tree = r.tree;
  if (!tree) {
    const { sha } = await putBlob(db, r.code ?? '');
    tree = await putTree(db, { [ENTRY]: sha });
  }
  return { tree, stored: r.tree, files: (await getTree(db, tree)) ?? {}, code: r.code ?? '', version: Number(r.version) || 0, name: r.name };
}

/** Create a world from a file tree (imports). */
export async function createWorldFromTree(
  db: Db,
  viewer: Viewer,
  tree: string,
  opts: { name: string; description?: string; sourceUrl?: string | null; prompt?: string; license?: string | null; forkable?: boolean },
): Promise<WorldFull> {
  requireIdentity(viewer);
  const files = await getTree(db, tree);
  if (!files) throw new FileError('Unknown file tree.');
  const code = await entryOf(db, files);
  const ownerUser = await sessionUser(db, viewer);
  if (!viewer.deviceHash && !ownerUser) fail(400, 'device_required', 'Missing device key.');
  await touchDevice(db, viewer);
  const authorName = await resolveAuthorName(db, viewer, undefined);
  const id = await insertWithFreshId(async (newId) => {
    const rows = await db.query<{ id: string }>(
      `with w as (
         insert into orb_worlds (id, name, description, kind, code, tree, source_url, owner_device, owner_user, author_name, version, license, forkable)
         values ($1, $2, $3, 'native', $4, $5, $6, $7, $8, $9, 1, $11, $12)
         returning id, code, tree
       ), v as (
         insert into orb_world_versions (world_id, version, code, tree, prompt) select id, 1, code, tree, $10 from w
       )
       select id from w`,
      [newId, cleanLine(opts.name, LIMITS.name, 'name') || UNTITLED, (opts.description ?? '').slice(0, LIMITS.description), code, tree, opts.sourceUrl ?? null, viewer.deviceHash, ownerUser, authorName, opts.prompt ?? null, opts.license ?? null, opts.forkable ?? !!opts.license],
    );
    return rows[0]?.id ?? null;
  });
  if (!id) throw new Error('world insert returned no row');
  await assignPath(db, id);
  return viewWorld(db, viewer, id);
}

/**
 * A repository that says it is an Orb world (`world` in its orb.json: a fork of an open-source
 * game) comes in as a remix of that world, when it is public and can be remixed: credited and in
 * its remixes like one made with Remix. Changed on GitHub, the remix has two versions, the world it
 * came from and then the repository's files, so it counts as changed (and its maker is told).
 * Otherwise (no such world) it is a world of its own, as any import.
 */
export async function createRemixFromTree(
  db: Db,
  viewer: Viewer,
  tree: string,
  remixOf: string,
  opts: { name: string; description?: string; sourceUrl: string | null; prompt: string; license: string | null },
): Promise<WorldFull> {
  requireIdentity(viewer);
  const files = await getTree(db, tree);
  if (!files) throw new FileError('Unknown file tree.');
  const code = await entryOf(db, files);
  const src = (
    await db.query<{ code: string | null }>(`select code from orb_worlds where id = $1 and kind = 'native' and visibility = 'public' and forkable`, [remixOf])
  )[0];
  if (!src) return createWorldFromTree(db, viewer, tree, opts);
  const changed = (src.code ?? '') !== code;
  const ownerUser = await sessionUser(db, viewer);
  if (!viewer.deviceHash && !ownerUser) fail(400, 'device_required', 'Missing device key.');
  await touchDevice(db, viewer);
  const authorName = await resolveAuthorName(db, viewer, undefined);
  const id = await insertWithFreshId(async (newId) => {
    const rows = await db.query<{ id: string }>(
      `with src as (
         select * from orb_worlds where id = $1 and kind = 'native' and visibility = 'public' and forkable
       ), ins as (
         insert into orb_worlds (id, name, description, kind, code, tree, template, tags, thumb, thumb_type, thumb_version,
                                 forked_from, source_url, license, forkable, owner_device, owner_user, author_name, visibility, version)
         select $2::text, $3::text, $4::text, 'native', $5::text, $6::text, template, array_remove(tags, $13::text), thumb, thumb_type,
                case when thumb is null then 0 else 1 end, id, $7::text, $8::text, $8::text is not null, $9::text, $10::text, $11::text, 'public', $12::int
         from src
         returning id
       ), v1 as (
         insert into orb_world_versions (world_id, version, code, tree, prompt)
         select ins.id, 1, case when $12::int = 2 then coalesce(src.code, '') else $5::text end, case when $12::int = 2 then src.tree else $6::text end,
                left('Remix of ' || src.name, ${LIMITS.prompt})
         from ins, src
       ), v2 as (
         insert into orb_world_versions (world_id, version, code, tree, prompt) select id, 2, $5::text, $6::text, $14::text from ins where $12::int = 2
       ), counted as (
         update orb_worlds set forks = forks + 1, ${heatBump(6)} where id = $1 and exists (select 1 from ins)
       )
       select id from ins`,
      [
        remixOf,
        newId,
        cleanLine(opts.name, LIMITS.name, 'name') || UNTITLED,
        (opts.description ?? '').slice(0, LIMITS.description),
        code,
        tree,
        opts.sourceUrl ?? null,
        opts.license,
        viewer.deviceHash,
        ownerUser,
        authorName,
        changed ? 2 : 1,
        KEYBOARD_TAG,
        opts.prompt.slice(0, LIMITS.prompt),
      ],
    );
    return rows[0]?.id ?? null;
  });
  if (!id) return createWorldFromTree(db, viewer, tree, opts);
  await assignPath(db, id);
  if (changed) await creditRemix(db, id);
  return viewWorld(db, viewer, id);
}

// ---------------------------------------------------------------------------------------------
// Remix (fork)

/** Public remixes of a world that their makers changed, newest first (its remix tree, one level down). */
export async function remixesOf(db: Db, id: string, limit = 24): Promise<WorldCard[]> {
  const rows = await db.query<CardRow>(
    `select ${CARD_COLS} from ${CARD_FROM} where w.forked_from = $1 and w.visibility = 'public' and w.version > 1 order by w.updated_at desc limit $2`,
    [id, limit],
  );
  return rows.map(toCard);
}

/**
 * A remix's first change makes it its maker's own: the person who made the world it came from hears
 * about it, once (public remixes of public worlds; not when they remixed it themselves).
 */
async function creditRemix(db: Db, remixId: string): Promise<void> {
  await db
    .query(
      `insert into orb_notifications (user_id, kind, actor_id, world_id)
       select f.owner_user, 'remix', r.owner_user, r.id
       from orb_worlds r join orb_worlds f on f.id = r.forked_from
       where r.id = $1 and r.visibility = 'public' and f.visibility = 'public' and f.owner_user is not null
         and f.owner_user is distinct from r.owner_user and r.owner_device is distinct from f.owner_device
         and not exists (select 1 from orb_notifications n where n.kind = 'remix' and n.world_id = r.id)`,
      [remixId],
    )
    .catch((e) => console.error('[orb] crediting a remix failed', e instanceof Error ? e.message : e));
}

export async function forkWorld(db: Db, viewer: Viewer, id: string, body: unknown): Promise<WorldFull> {
  requireIdentity(viewer);
  const input = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const { row: src, canEdit: owner } = await access(db, viewer, await loadMeta(db, id));
  if (src.kind !== 'native') fail(400, 'not_forkable', 'This world lives on another site and cannot be remixed here.');
  // Owners may always duplicate their own world; everyone else needs remixing to be allowed.
  if (!src.forkable && !owner) fail(403, 'not_forkable', 'The creator turned off remixing for this world.');

  const given = cleanLine(input.authorName, LIMITS.authorName, 'authorName') || undefined;
  await touchDevice(db, viewer, viewer.userId ? undefined : given);
  const authorName = await resolveAuthorName(db, viewer, given);
  // A remix of your own private world stays private (and keeps its account owner).
  const isPrivate = src.visibility === 'private';
  const ownerUser = (await sessionUser(db, viewer)) ?? (isPrivate ? src.owner_user : null);
  if (!viewer.deviceHash && !ownerUser) fail(400, 'device_required', 'Missing device key.');

  const forkId = await insertWithFreshId(async (newId) => {
    const rows = await db.query<{ id: string }>(
      `with src as (
         select * from orb_worlds where id = $1 and kind = 'native'
       ), ins as (
         insert into orb_worlds (id, name, description, kind, code, tree, template, tags, thumb, thumb_type, thumb_version,
                                 forked_from, source_url, license, owner_device, owner_user, author_name, visibility, version)
         select $2, name, description, 'native', coalesce(code, ''), tree, template, array_remove(tags, $8), thumb, thumb_type,
                case when thumb is null then 0 else 1 end, id, source_url, license, $3, $4, $5, $6, 1
         from src
         returning id, code, tree
       ), ver as (
         insert into orb_world_versions (world_id, version, code, tree, prompt) select id, 1, code, tree, $7 from ins
       ), counted as (
         update orb_worlds set forks = forks + 1, ${heatBump(6)} where id = $1 and exists (select 1 from ins)
       )
       select id from ins`,
      // A remix is the remixer's to make touch-friendly: nothing they can edit would ever clear the keyboard tag.
      [id, newId, viewer.deviceHash, ownerUser, authorName, isPrivate ? 'private' : 'public', `Remix of ${src.name}`.slice(0, LIMITS.prompt), KEYBOARD_TAG],
    );
    return rows[0]?.id ?? null;
  });
  if (!forkId) fail(404, 'not_found', 'This world does not exist.');
  await assignPath(db, forkId);
  return viewWorld(db, viewer, forkId);
}

// ---------------------------------------------------------------------------------------------
// Thumbnails

/** Sniff the image type from magic bytes. */
export function sniffImage(b: Uint8Array): ThumbType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF' && String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP') return 'image/webp';
  return null;
}

/** Normalize a Content-Type header to one of the accepted thumbnail types (or null). */
export function thumbContentType(header: string | null): ThumbType | null {
  const t = (header ?? '').split(';')[0].trim().toLowerCase();
  const norm = t === 'image/jpg' || t === 'image/pjpeg' ? 'image/jpeg' : t;
  return (THUMB_TYPES as readonly string[]).includes(norm) ? (norm as ThumbType) : null;
}

export async function putThumb(db: Db, viewer: Viewer, id: string, bytes: Uint8Array, declared: ThumbType): Promise<number> {
  const { row } = await access(db, viewer, await loadMeta(db, id), true);
  if (row.kind !== 'native') fail(400, 'not_editable', 'This world lives on another site.');
  if (bytes.length === 0) fail(400, 'bad_image', 'The image is empty.');
  if (bytes.length > LIMITS.thumbBytes) fail(413, 'too_large', 'Thumbnail is too large (max 500 KB).');
  const actual = sniffImage(bytes);
  if (!actual || actual !== declared) fail(415, 'bad_image', 'Thumbnails must be WebP, JPEG or PNG images.');
  const rows = await db.query<{ thumb_version: number }>(
    `update orb_worlds set thumb = $2, thumb_type = $3, thumb_version = thumb_version + 1 where id = $1 returning thumb_version`,
    [id, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), actual],
  );
  if (!rows[0]) fail(404, 'not_found', 'This world does not exist.');
  return Number(rows[0].thumb_version);
}

export type ThumbResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'image'; bytes: Uint8Array<ArrayBuffer>; type: string; version: number; isPublic: boolean };

function toBytes(v: unknown): Uint8Array<ArrayBuffer> | null {
  if (v instanceof Uint8Array) return new Uint8Array(v); // copy → plain ArrayBuffer-backed view
  if (typeof v === 'string' && v.startsWith('\\x')) return new Uint8Array(Buffer.from(v.slice(2), 'hex'));
  return null;
}

/** http(s) URLs and root-relative paths only — never `javascript:` or protocol-relative URLs. */
export function safeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Absolute http(s) URLs only (links, embeds): no `javascript:`/`data:`, no relative paths. */
export function safeWebUrl(url: string | null | undefined): string | null {
  if (!url || url.startsWith('/')) return null;
  return safeImageUrl(url);
}

/**
 * An embedded world's address: a web address that isn't one of Orb's own. Embeds run with their
 * own origin (allow-same-origin), so one of Orb's pages in there would be Orb itself, unsandboxed.
 */
export function safeEmbedUrl(url: string | null | undefined): string | null {
  const safe = safeWebUrl(url);
  if (!safe) return null;
  const host = new URL(safe).hostname.toLowerCase();
  const o = originsConfig();
  const own = [o.site, ...o.former, ...o.extra, ...o.allowed].map((x) => {
    try {
      return new URL(x).hostname.toLowerCase();
    } catch {
      return '';
    }
  });
  if (own.includes(host) || host === 'orbworlds.com' || host.endsWith('.orbworlds.com') || /^orb[\w-]*\.vercel\.app$/.test(host)) return null;
  return safe;
}

/** Thumbnail for a world visible to `viewer` (null when it has none). Throws 404 for no access. */
export async function getThumb(db: Db, viewer: Viewer, id: string): Promise<ThumbResult | null> {
  const rows = await db.query<MetaRow & { thumb: unknown; thumb_type: string | null; thumb_version: number; thumb_url: string | null }>(
    `select ${META_COLS}, thumb, thumb_type, thumb_version, thumb_url from orb_worlds where id = $1`,
    [id],
  );
  const { row } = await access(db, viewer, rows[0] ?? null);
  if (row.kind === 'external') {
    const url = safeImageUrl(row.thumb_url);
    return url ? { kind: 'redirect', url } : null;
  }
  const bytes = toBytes(row.thumb);
  if (!bytes || !row.thumb_type) {
    // Native worlds seeded with a static thumbnail (Orb Originals) until they capture their own.
    const url = safeImageUrl(row.thumb_url);
    return url ? { kind: 'redirect', url } : null;
  }
  return { kind: 'image', bytes, type: row.thumb_type, version: Number(row.thumb_version) || 0, isPublic: row.visibility === 'public' };
}

/** Thumbnail of a public world for server-side rendering (OG images). Never throws for access. */
export async function getPublicThumb(id: string): Promise<ThumbResult | null> {
  if (!isWorldId(id)) return null;
  const db = await ready();
  try {
    const t = await getThumb(db, { deviceHash: null, deviceId: null, userId: null }, id);
    return t && (t.kind === 'redirect' || t.isPublic) ? t : null;
  } catch (e) {
    if (e instanceof HttpError) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Plays & likes

const utcDay = () => new Date().toISOString().slice(0, 10);

/**
 * Count a play, at most once per device (or IP) per world per UTC day. The dedupe marker lives in
 * orb_rate (swept by the rate limiter's cleanup); marker + counter update are one statement.
 */
export async function recordPlay(db: Db, viewer: Viewer, id: string, ip: string): Promise<number> {
  await access(db, viewer, await loadMeta(db, id));
  // Device keys are free to mint, so also bound how many plays one IP can add (silently).
  const ipBudget = await rateLimit(db, `play:ip:${ip}`, 300, 3600);
  if (!ipBudget.ok) {
    const rows = await db.query<{ plays: number }>(`select plays from orb_worlds where id = $1`, [id]);
    return Number(rows[0]?.plays ?? 0);
  }
  const marker = `play:${id}:${actorKey(viewer, ip)}:${utcDay()}`;
  const rows = await db.query<{ plays: number }>(
    `with mark as (
       insert into orb_rate (key, window_start, count) values ($2, now(), 1) on conflict (key) do nothing returning 1
     ), bump as (
       update orb_worlds set plays = plays + 1, ${heatBump(1)} where id = $1 and exists (select 1 from mark) returning plays
     )
     select coalesce((select plays from bump), (select plays from orb_worlds where id = $1)) as plays`,
    [id, marker],
  );
  return Number(rows[0]?.plays ?? 0);
}

/** Toggle the viewer's like (atomic: one statement flips the like row and adjusts the counter). */
export async function toggleLike(db: Db, viewer: Viewer, id: string): Promise<{ liked: boolean; likes: number }> {
  if (!viewer.deviceHash) fail(400, 'device_required', 'Missing device key.');
  await access(db, viewer, await loadMeta(db, id));
  const rows = await db.query<{ liked: boolean; likes: number }>(
    `with del as (
       delete from orb_likes where world_id = $1 and device_hash = $2 returning 1
     ), ins as (
       insert into orb_likes (world_id, device_hash) select $1, $2 where not exists (select 1 from del)
       on conflict do nothing returning 1
     ), upd as (
       update orb_worlds set likes = greatest(0, likes + (select count(*) from ins)::int - (select count(*) from del)::int),
         heat = case when exists (select 1 from ins) then heat * exp(-greatest(0, extract(epoch from now() - heat_at)) / ${HEAT_TAU}) + 4 else heat end,
         heat_at = case when exists (select 1 from ins) then now() else heat_at end
       where id = $1 returning likes
     )
     select exists (select 1 from ins) as liked, (select likes from upd) as likes`,
    [id, viewer.deviceHash],
  );
  return { liked: !!rows[0]?.liked, likes: Number(rows[0]?.likes ?? 0) };
}

// ---------------------------------------------------------------------------------------------
// Shared world store (orb.store.*)

function jsonBytes(v: unknown): string {
  const s = JSON.stringify(v === undefined ? null : v);
  if (s === undefined) fail(400, 'bad_value', 'Value must be JSON.');
  if (Buffer.byteLength(s, 'utf8') > LIMITS.storeValue) fail(413, 'too_large', `Stored values are limited to ${LIMITS.storeValue / 1024} KB.`);
  return s;
}

function storeFull(): never {
  fail(409, 'store_full', 'This world has too many stored keys.');
}

/** Insert-or-update guarded by the per-world key cap (a new key is only inserted under the cap). */
function capGuard(): string {
  return `where exists (select 1 from orb_kv where world_id = $1 and key = $2)
            or (select count(*) from orb_kv where world_id = $1) < ${LIMITS.storeKeys}`;
}

export async function storeOp(db: Db, viewer: Viewer, id: string, body: unknown, ip: string): Promise<unknown> {
  const req = asObject(body) as Partial<Record<keyof StoreRequest, unknown>>;
  const op = req.op;
  if (op !== 'get' && op !== 'set' && op !== 'incr' && op !== 'push' && op !== 'merge' && op !== 'list') fail(400, 'bad_request', 'op must be get, set, incr, push, merge or list.');
  // For list, the key is the prefix of the keys to read ('' = all of them).
  const key = req.key;
  if (typeof key !== 'string' || (!key.length && op !== 'list') || key.length > LIMITS.storeKey || HAS_CONTROL.test(key)) {
    fail(400, 'bad_key', `Keys must be 1–${LIMITS.storeKey} characters.`);
  }

  const { row } = await access(db, viewer, await loadMeta(db, id));
  if (row.kind !== 'native') fail(400, 'not_supported', 'This world has no shared store.');
  const tooFast = 'This world is saving too fast. Try again in a moment.';
  // A list can read up to ~2 MB: it counts as several requests.
  const cost = op === 'list' ? 5 : 1;
  await limitOrThrow(db, `store:${id}:${actorKey(viewer, ip)}`, 120, 60, tooFast, cost);
  // Device keys are free to mint: also cap one IP across all worlds and devices.
  await limitOrThrow(db, `store:ip:${ip}`, 1200, 60, tooFast, cost);

  if (op === 'get') {
    const rows = await db.query<{ value: unknown }>(`select value from orb_kv where world_id = $1 and key = $2`, [id, key]);
    return rows[0]?.value ?? null;
  }

  if (op === 'list') {
    const rows = await db.query<{ key: string; value: unknown }>(
      `select key, value from orb_kv where world_id = $1 and starts_with(key, $2) order by key collate "C" limit ${LIMITS.storeListKeys}`,
      [id, key],
    );
    const out: Record<string, unknown> = {};
    let bytes = 0;
    for (const r of rows) {
      bytes += Buffer.byteLength(JSON.stringify(r.value), 'utf8') + r.key.length;
      if (bytes > LIMITS.storeListResultBytes) break;
      out[r.key] = r.value;
    }
    return out;
  }

  if (op === 'merge') {
    // Shallow and atomic, so everyone's merges into one key add up; a null removes that field.
    const patch = req.value;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(400, 'bad_value', 'The patch must be an object.');
    jsonBytes(patch); // the whole patch, deletions too
    const entries = Object.entries(patch as Record<string, unknown>);
    const drop = entries.filter(([, v]) => v === null).map(([k]) => k);
    const add = jsonBytes(Object.fromEntries(entries.filter(([, v]) => v !== null)));
    const merged = `((case when jsonb_typeof(kv.value) = 'object' then kv.value else '{}'::jsonb end) || $3::jsonb) - $4::text[]`;
    // The size as compact JSON: jsonb's text form puts a space after every ':' and ',' at every level.
    const size = `octet_length((${merged})::text) - (select coalesce(sum(case jsonb_typeof(v)
        when 'object' then greatest(2 * (select count(*) from jsonb_object_keys(v)) - 1, 0)
        when 'array' then greatest(jsonb_array_length(v) - 1, 0) else 0 end), 0)
      from jsonb_path_query(${merged}, 'strict $.**') as t(v))::int`;
    const rows = await db.query<{ value: unknown }>(
      `insert into orb_kv as kv (world_id, key, value) select $1, $2, $3::jsonb ${capGuard()}
       on conflict (world_id, key) do update set value = ${merged}, updated_at = now()
         where ${size} <= $5::int
       returning value`,
      [id, key, add, drop, LIMITS.storeValue],
    );
    if (rows[0]) return rows[0].value;
    const exists = await db.query(`select 1 from orb_kv where world_id = $1 and key = $2`, [id, key]);
    if (exists.length) fail(413, 'too_large', `Stored values are limited to ${LIMITS.storeValue / 1024} KB.`);
    storeFull();
  }

  if (op === 'set') {
    const value = jsonBytes(req.value);
    const rows = await db.query<{ value: unknown }>(
      `insert into orb_kv as kv (world_id, key, value) select $1, $2, $3::jsonb ${capGuard()}
       on conflict (world_id, key) do update set value = excluded.value, updated_at = now()
       returning value`,
      [id, key, value],
    );
    if (!rows[0]) storeFull();
    return rows[0].value;
  }

  if (op === 'incr') {
    const by = req.by === undefined ? 1 : req.by;
    if (typeof by !== 'number' || !Number.isFinite(by) || Math.abs(by) > 1e12) fail(400, 'bad_request', 'by must be a finite number.');
    // Non-numeric existing values count as 0.
    const rows = await db.query<{ value: unknown }>(
      `insert into orb_kv as kv (world_id, key, value) select $1, $2, to_jsonb($3::numeric) ${capGuard()}
       on conflict (world_id, key) do update set
         value = to_jsonb(coalesce(case when jsonb_typeof(kv.value) = 'number' then kv.value::text::numeric end, 0) + $3::numeric),
         updated_at = now()
       returning value`,
      [id, key, String(by)],
    );
    if (!rows[0]) storeFull();
    return Number(rows[0].value);
  }

  // push: append, then keep the newest `max` items that fit in storeListBytes. Non-arrays restart as [].
  const item = jsonBytes(req.value);
  const maxRaw = req.max === undefined ? LIMITS.storeListDefault : req.max;
  if (typeof maxRaw !== 'number' || !Number.isFinite(maxRaw)) fail(400, 'bad_request', 'max must be a number.');
  const max = Math.min(LIMITS.storeListMax, Math.max(1, Math.floor(maxRaw)));
  const rows = await db.query<{ value: unknown }>(
    `insert into orb_kv as kv (world_id, key, value) select $1, $2, jsonb_build_array($3::jsonb) ${capGuard()}
     on conflict (world_id, key) do update set
       value = (
         select coalesce(jsonb_agg(s.e order by s.i), '[]'::jsonb)
         from (
           select t.e, t.i, count(*) over () as n, sum(octet_length(t.e::text)) over (order by t.i desc) as bytes
           from jsonb_array_elements(
             (case when jsonb_typeof(kv.value) = 'array' then kv.value else '[]'::jsonb end) || jsonb_build_array($3::jsonb)
           ) with ordinality as t(e, i)
         ) s
         where s.i > s.n - $4::int and s.bytes <= $5::int
       ),
       updated_at = now()
     returning value`,
    [id, key, item, max, LIMITS.storeListBytes],
  );
  if (!rows[0]) storeFull();
  return rows[0].value;
}

// ---------------------------------------------------------------------------------------------
// Admin & profile

export async function adminSetFlags(db: Db, id: string, body: unknown): Promise<void> {
  const input = asObject(body);
  const sets: string[] = [];
  const params: unknown[] = [id];
  if (input.verified !== undefined) {
    if (typeof input.verified !== 'boolean') fail(400, 'bad_request', 'verified must be a boolean.');
    params.push(input.verified);
    sets.push(`verified = $${params.length}::boolean`);
  }
  if (input.featured !== undefined) {
    if (typeof input.featured !== 'number' || !Number.isInteger(input.featured) || Math.abs(input.featured) > 1_000_000) {
      fail(400, 'bad_request', 'featured must be an integer.');
    }
    params.push(input.featured);
    sets.push(`featured = $${params.length}::int`);
  }
  // Hand a world to an account (e.g. a curated world that becomes someone's own).
  if (input.ownerUser !== undefined) {
    if (typeof input.ownerUser !== 'string') fail(400, 'bad_request', 'ownerUser must be a user id.');
    const user = await db.query<{ id: string }>(`select id from orb_users where id = $1`, [input.ownerUser]);
    if (!user[0]) fail(404, 'not_found', 'No such user.');
    params.push(input.ownerUser);
    sets.push(`owner_user = $${params.length}::text`, `owner_device = null`);
  }
  if (input.visibility !== undefined) {
    if (input.visibility !== 'public' && input.visibility !== 'private') fail(400, 'bad_request', "visibility must be 'public' or 'private'.");
    params.push(input.visibility);
    sets.push(`visibility = $${params.length}`);
  }
  if (input.authorName !== undefined) {
    params.push(cleanLine(input.authorName, LIMITS.authorName, 'authorName') || 'Someone');
    sets.push(`author_name = $${params.length}`);
  }
  if (input.sourceUrl !== undefined) {
    if (input.sourceUrl !== null && (typeof input.sourceUrl !== 'string' || !safeWebUrl(input.sourceUrl))) fail(400, 'bad_request', 'sourceUrl must be an http(s) URL or null.');
    params.push(input.sourceUrl);
    sets.push(`source_url = $${params.length}`);
  }
  // E.g. "keyboard" on a curated world someone owns now. (An unowned curated world gets its tags
  // from seeds.json again on the next cold start.)
  if (input.tags !== undefined) {
    params.push(JSON.stringify(cleanTags(input.tags)));
    sets.push(`tags = array(select jsonb_array_elements_text($${params.length}::jsonb))`);
  }
  if (!sets.length) fail(400, 'bad_request', 'Nothing to update (verified, featured, ownerUser, visibility, authorName, sourceUrl, tags).');
  const rows = await db.query<{ id: string }>(`update orb_worlds set ${sets.join(', ')}, updated_at = now() where id = $1 returning id`, params);
  if (!rows[0]) fail(404, 'not_found', 'This world does not exist.');
  if (input.ownerUser !== undefined || input.visibility !== undefined) await assignPath(db, id);
}

/** Accounts by name or handle (admin). */
export async function adminFindUsers(db: Db, q: string): Promise<Array<{ id: string; name: string; handle: string | null; worlds: number; createdAt: string }>> {
  const like = likePattern(q.slice(0, 60));
  const rows = await db.query<{ id: string; name: string; handle: string | null; worlds: number; created_at: Date | string }>(
    `select u.id, u.name, h.handle, (select count(*)::int from orb_worlds w where w.owner_user = u.id) as worlds, u.created_at
     from orb_users u left join orb_handles h on h.owner_user = u.id
     where u.name ilike $1 or h.handle ilike $1 or u.id = $2
     order by u.created_at limit 20`,
    [like, q],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, handle: r.handle, worlds: Number(r.worlds), createdAt: iso(r.created_at) }));
}

/** Rename the author on every world the viewer owns (same ownership rule as canEdit). */
export async function renameAuthor(db: Db, viewer: Viewer, name: string): Promise<void> {
  if (!viewer.deviceHash && !viewer.userId) return;
  await db.query(
    `update orb_worlds w set author_name = $3
     where (w.owner_device = $1::text or w.owner_user = $2::text
            or w.owner_user = (select d.user_id from orb_devices d where d.hash = $1::text))
       and w.author_name is distinct from $3`,
    [viewer.deviceHash, viewer.userId, name],
  );
}

/** Exposed for /api/me: the same single-line cleaning used for author names. */
export function cleanDisplayName(v: unknown): string | undefined {
  return cleanLine(v, LIMITS.authorName, 'name');
}
