// Game progress of signed-in people (orb_saves): each world's localStorage, as the runtime keeps it
// in the browser (src/lib/runtime/bridge.ts), so it follows them to every device
// (src/lib/savesync.ts). One copy per account and world; the newer one wins, by when the browser
// saved it. Websites embedded as worlds keep their own storage, which Orb can't see.

import { WORLD_STORAGE_LIMIT } from '@/lib/runtime/sdk';
import type { Db } from './db';

/** A world's save as JSON: its storage cap plus the quotes and commas around it. */
export const MAX_SAVE_CHARS = WORLD_STORAGE_LIMIT + 256 * 1024;
/** What one account may keep in all, and for how many worlds. */
export const MAX_ACCOUNT_CHARS = 30_000_000;
export const MAX_ACCOUNT_SAVES = 400;

type SaveData = Record<string, string>;

/** `{ key: value }` with string values within the world storage cap, or null. */
export function cleanSave(raw: unknown): SaveData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: SaveData = Object.create(null) as SaveData;
  let size = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') return null;
    size += k.length + v.length;
    if (size > WORLD_STORAGE_LIMIT) return null;
    out[k] = v;
  }
  return out;
}

interface SaveInfo {
  worldId: string;
  /** When the browser saved it (epoch ms). */
  at: number;
  size: number;
}

export async function listSaves(db: Db, userId: string): Promise<SaveInfo[]> {
  const rows = await db.query<{ world_id: string; at: string | number; size: number }>(`select world_id, at, size from orb_saves where user_id = $1 order by at desc limit $2`, [userId, MAX_ACCOUNT_SAVES]);
  return rows.map((r) => ({ worldId: r.world_id, at: Number(r.at), size: Number(r.size) }));
}

export async function getSave(db: Db, userId: string, worldId: string): Promise<{ data: SaveData; at: number } | null> {
  const rows = await db.query<{ data: string; at: string | number }>(`select data, at from orb_saves where user_id = $1 and world_id = $2`, [userId, worldId]);
  if (!rows[0]) return null;
  return { data: (cleanSave(JSON.parse(rows[0].data)) ?? {}) as SaveData, at: Number(rows[0].at) };
}

type PutResult = { saved: true; at: number } | { saved: false; reason: 'older' | 'full' | 'no_world'; at?: number };

/**
 * Keep this save for the account, unless the copy it has is as new or newer (`older`), the
 * account's saves are full, or there is no such world.
 */
export async function putSave(db: Db, userId: string, worldId: string, data: SaveData, at: number): Promise<PutResult> {
  const json = JSON.stringify(data);
  if (json.length > MAX_SAVE_CHARS) return { saved: false, reason: 'full' };
  const rows = await db.query<{ at: string | number }>(
    `insert into orb_saves as s (user_id, world_id, data, size, at)
     select $1, $2, $3, $4::int, $5::bigint
     where exists (select 1 from orb_worlds where id = $2)
       and (select count(*) from orb_saves where user_id = $1 and world_id <> $2) < $6::int
       and (select coalesce(sum(size), 0) from orb_saves where user_id = $1 and world_id <> $2) + $4::int <= $7::bigint
     on conflict (user_id, world_id) do update set data = excluded.data, size = excluded.size, at = excluded.at, updated_at = now()
     where s.at < excluded.at
     returning at`,
    [userId, worldId, json, json.length, Math.round(at), MAX_ACCOUNT_SAVES, MAX_ACCOUNT_CHARS],
  );
  if (rows[0]) return { saved: true, at: Number(rows[0].at) };
  const kept = await db.query<{ at: string | number }>(`select at from orb_saves where user_id = $1 and world_id = $2`, [userId, worldId]);
  if (kept[0] && Number(kept[0].at) >= at) return { saved: false, reason: 'older', at: Number(kept[0].at) };
  const world = await db.query(`select 1 from orb_worlds where id = $1`, [worldId]);
  return { saved: false, reason: world.length ? 'full' : 'no_world' };
}
