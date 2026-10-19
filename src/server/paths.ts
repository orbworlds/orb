// Readable world URLs, GitHub style: /<owner handle>/<world slug> (e.g. /sunny-orca/cloud-castle).
//
// - Every owner gets one handle from their name (orb_handles), unique site-wide. A device's handle
//   moves to the account when the person signs up, so their URLs keep working.
// - A world's slug comes from its name, unique per handle. orb_world_paths remembers every path a
//   world ever had, so old links keep working after a rename or move; orb_worlds.handle/slug is the
//   current (canonical) one. /w/<id> links work forever too.
// - Worlds without an owner live under their maker's name: Orb's own under /orbworlds/…, the
//   curated worlds other people made under theirs (/leon-lin/athenaion). The handle is kept for
//   them (no account can take it) and its page lists their worlds. They used to live under /orb/…
//   and /web/…, and those links still work.

import type { Db } from './db';

/** Top-level paths a handle must never shadow (app routes and files). */
export const RESERVED = new Set([
  'w', 'api', 'explore', 'templates', 'seeds', 'dev', 'new', 'about', 'settings', 'login', 'logout', 'signup', 'admin', 'help',
  'orb', 'web', 'static', 'assets', 'public', 'app', 'you', 'me', 'world', 'worlds', 'favicon.ico', 'icon.svg', 'robots.txt',
  'sitemap.xml', 'opengraph-image', '_next', 'vercel', 'lab', 'pricing', 'plans', 'pro', 'billing', 'credits', 'upgrade', 'checkout',
]);

/** "Cloud Castle!" → "cloud-castle" (ASCII, max 48). */
export function slugify(name: string, fallback = 'world'): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return s || fallback;
}

export const isPathPart = (s: string) => /^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(s);

/** The handle of a world's owner (created on first use). */
export async function ownerHandle(db: Db, owner: { user: string | null; device: string | null; name: string }): Promise<string | null> {
  const existing = owner.user
    ? await db.query<{ handle: string }>(`select handle from orb_handles where owner_user = $1`, [owner.user])
    : owner.device
      ? await db.query<{ handle: string }>(`select handle from orb_handles where owner_device = $1`, [owner.device])
      : [];
  if (existing[0]) return existing[0].handle;
  if (!owner.user && !owner.device) return null;
  let base = slugify(owner.name, 'maker').slice(0, 30).replace(/-+$/g, '');
  if (RESERVED.has(base)) base = `${base}-maker`;
  for (let i = 0; i < 30; i++) {
    const candidate = i === 0 ? base : i < 20 ? `${base}-${i + 1}` : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const rows = await db.query<{ handle: string }>(
      `insert into orb_handles (handle, owner_user, owner_device) values ($1, $2, $3) on conflict do nothing returning handle`,
      [candidate, owner.user, owner.user ? null : owner.device],
    );
    if (rows[0]) return rows[0].handle;
    // Lost a race for this owner's first handle? Use the one that won.
    const again = owner.user
      ? await db.query<{ handle: string }>(`select handle from orb_handles where owner_user = $1`, [owner.user])
      : await db.query<{ handle: string }>(`select handle from orb_handles where owner_device = $1`, [owner.device]);
    if (again[0]) return again[0].handle;
  }
  return null;
}

/** The handle kept for a curated world's maker: their name, or the next free variant of it. */
export async function makerHandle(db: Db, name: string): Promise<string | null> {
  let base = slugify(name, 'maker').slice(0, 30).replace(/-+$/g, '');
  if (RESERVED.has(base)) base = `${base}-maker`;
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const rows = await db.query<{ handle: string; owner_user: string | null; owner_device: string | null }>(
      `with ins as (insert into orb_handles (handle) values ($1) on conflict do nothing returning handle, owner_user, owner_device)
       select handle, owner_user, owner_device from ins union all select handle, owner_user, owner_device from orb_handles where handle = $1 limit 1`,
      [candidate],
    );
    // Free, or already a maker's (nobody's account or device): theirs. Someone's own handle: next.
    if (rows[0] && !rows[0].owner_user && !rows[0].owner_device) return candidate;
  }
  return null;
}


interface PathRow {
  id: string;
  name: string;
  kind: string;
  owner_user: string | null;
  owner_device: string | null;
  author_name: string;
  handle: string | null;
  slug: string | null;
}

/**
 * Give a world its canonical path for its current name and owner (call after create, rename,
 * remix or a change of owner). Earlier paths stay valid. Never throws: URLs are a nicety.
 */
export async function assignPath(db: Db, worldId: string): Promise<void> {
  try {
    const rows = await db.query<PathRow>(`select id, name, kind, owner_user, owner_device, author_name, handle, slug from orb_worlds where id = $1`, [worldId]);
    const w = rows[0];
    if (!w) return;
    const handle =
      !w.owner_user && !w.owner_device
        ? await makerHandle(db, w.author_name)
        : w.kind === 'external'
          ? 'web'
          : await ownerHandle(db, { user: w.owner_user, device: w.owner_device, name: w.author_name });
    if (!handle) return;
    const base = slugify(w.name, 'world');
    if (w.handle === handle && w.slug && (w.slug === base || w.slug.replace(/-\d+$/, '') === base)) return; // still right
    for (let i = 0; i < 50; i++) {
      const slug = i === 0 ? base : `${base}-${i + 1}`;
      const got = await db.query<{ world_id: string }>(
        `insert into orb_world_paths (handle, slug, world_id) values ($1, $2, $3)
         on conflict (handle, slug) do update set handle = excluded.handle where orb_world_paths.world_id = excluded.world_id
         returning world_id`,
        [handle, slug, worldId],
      );
      if (got[0]) {
        await db.query(`update orb_worlds set handle = $2, slug = $3 where id = $1`, [worldId, handle, slug]);
        return;
      }
    }
  } catch (e) {
    console.error('[orb] assigning a world path failed', e);
  }
}

/** World id for /<handle>/<slug> (any path the world ever had), or null. */
export async function resolvePath(db: Db, handle: string, slug: string): Promise<string | null> {
  if (!isPathPart(handle) || !isPathPart(slug)) return null;
  const rows = await db.query<{ world_id: string }>(`select world_id from orb_world_paths where handle = $1 and slug = $2`, [handle, slug]);
  return rows[0]?.world_id ?? null;
}

/** Give paths to worlds that have none yet (existing worlds, seeds). Bounded per call. */
export async function backfillPaths(db: Db, limit = 300): Promise<void> {
  const rows = await db.query<{ id: string }>(`select id from orb_worlds where slug is null order by created_at limit $1::int`, [limit]);
  for (const r of rows) await assignPath(db, r.id);
}

/** Worlds without an owner (Orb's, curated) to their maker's paths, after the catalog changed (the old ones keep working). */
export async function repathCurated(db: Db): Promise<void> {
  const rows = await db.query<{ id: string }>(`select id from orb_worlds where owner_user is null and owner_device is null order by created_at limit 1000`);
  for (const r of rows) await assignPath(db, r.id);
}

/** Move an account's worlds to paths under its handle (after it got a username, or claimed a device's worlds). */
export async function repathAccount(db: Db, userId: string): Promise<void> {
  const rows = await db.query<{ id: string }>(`select id from orb_worlds where owner_user = $1 order by created_at limit 500`, [userId]);
  for (const r of rows) await assignPath(db, r.id);
}

/** When a device's owner signs up, the device's handle becomes the account's (URLs keep working). */
export async function adoptDeviceHandle(db: Db, deviceHash: string, userId: string): Promise<void> {
  try {
    await db.query(
      `update orb_handles set owner_user = $2, owner_device = null
       where owner_device = $1 and not exists (select 1 from orb_handles where owner_user = $2)`,
      [deviceHash, userId],
    );
  } catch (e) {
    console.error('[orb] adopting a device handle failed', e);
  }
}
