// Friends: two accounts that are friends see where the other is (the public world on their screen),
// invite each other into worlds and find each other's worlds on the start screen. A request waits
// until the other person accepts it; asking someone who already asked you is saying yes.
//
// Presence is a heartbeat: a signed-in page that is visible syncs every half minute
// (POST /api/friends/sync) with the world on its screen, and gets friends, requests and
// notifications back in the same round trip. Someone is online while their last heartbeat is
// under ONLINE_SECONDS old and their page hasn't said goodbye since.
//
// Each friendship is one orb_friends row keyed by the pair of ids, the smaller first (`pair()`).

import type { Friend, FriendNote, FriendNoteKind, FriendRequest, FriendRoom, FriendsData, FriendState, Person, Profile, WorldCard } from '@/lib/types';
import type { Viewer } from './auth';
import type { Db } from './db';
import { fail } from './http';
import { isPathPart, RESERVED, slugify } from './paths';
import { isWorldId, iso, publicCards, sessionUser, worldsBy } from './worlds';

const ONLINE_SECONDS = 90;
const NOTES_DAYS = 30;
const NOTES_SHOWN = 30;
/** The same friend isn't invited to the same world twice within this many minutes. */
const INVITE_AGAIN_MINUTES = 10;
const INVITE_MAX = 50;

const NOBODY = 'No one has that username — check the spelling.';
const ONLINE = `(not p.away and p.at > now() - interval '${ONLINE_SECONDS} seconds')`;
const HANDLE_OF = (user: string) => `(select h.handle from orb_handles h where h.owner_user = ${user})`;

const pair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

export const isUserId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v);

/** The signed-in account's id, or a 401: friends are accounts. */
export async function accountId(db: Db, viewer: Viewer): Promise<string> {
  const id = await sessionUser(db, viewer);
  if (!id) fail(401, 'signed_out', 'Sign in to add friends.');
  return id;
}

async function notify(db: Db, to: string, kind: FriendNoteKind, from: string, worldId: string | null = null): Promise<void> {
  await db.query(`insert into orb_notifications (user_id, kind, actor_id, world_id) values ($1, $2, $3, $4)`, [to, kind, from, worldId]);
}

async function standing(db: Db, me: string, other: string): Promise<FriendState> {
  if (me === other) return 'you';
  const [a, b] = pair(me, other);
  const row = (await db.query<{ status: string; requested_by: string }>(`select status, requested_by from orb_friends where a = $1 and b = $2`, [a, b]))[0];
  if (!row) return 'none';
  if (row.status === 'friends') return 'friends';
  return row.requested_by === me ? 'requested' : 'incoming';
}

// -- requests -------------------------------------------------------------------------------------

/** Ask the account with this username to be friends (or say yes, if they asked first). */
export async function addFriend(db: Db, me: string, username: unknown): Promise<{ state: FriendState; person: Person }> {
  const handle = typeof username === 'string' ? slugify(username.trim().replace(/^@/, ''), '') : '';
  const found = isPathPart(handle)
    ? (await db.query<{ id: string; name: string; handle: string }>(`select u.id, u.name, h.handle from orb_handles h join orb_users u on u.id = h.owner_user where h.handle = $1`, [handle]))[0]
    : undefined;
  if (!found) fail(404, 'not_found', NOBODY);
  const person: Person = { id: found.id, name: found.name, handle: found.handle };
  if (found.id === me) fail(400, 'self', 'That’s you! Ask your friend for their username.');
  const [a, b] = pair(me, found.id);
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await standing(db, me, found.id);
    if (state === 'friends' || state === 'requested') return { state, person };
    if (state === 'incoming') {
      await acceptFriend(db, me, found.id);
      return { state: 'friends', person };
    }
    const made = await db.query(`insert into orb_friends (a, b, requested_by) values ($1, $2, $3) on conflict do nothing returning a`, [a, b, me]);
    if (made.length) {
      await notify(db, found.id, 'friend_request', me);
      return { state: 'requested', person };
    }
    // They asked at the same moment: look again.
  }
  return { state: await standing(db, me, found.id), person };
}

/** Say yes to `other`'s request. */
export async function acceptFriend(db: Db, me: string, other: string): Promise<void> {
  const [a, b] = pair(me, other);
  const done = await db.query(`update orb_friends set status = 'friends', updated_at = now() where a = $1 and b = $2 and status = 'pending' and requested_by = $3 returning a`, [a, b, other]);
  if (!done.length) {
    if ((await standing(db, me, other)) === 'friends') return;
    fail(404, 'not_found', 'That friend request isn’t there anymore.');
  }
  await db.query(`update orb_notifications set read_at = now() where user_id = $1 and actor_id = $2 and kind = 'friend_request' and read_at is null`, [me, other]);
  await notify(db, other, 'friend_accepted', me);
}

/** Unfriend, turn a request down or take one back. What the two sent each other goes too. */
export async function removeFriend(db: Db, me: string, other: string): Promise<void> {
  const [a, b] = pair(me, other);
  await db.query(`delete from orb_friends where a = $1 and b = $2`, [a, b]);
  await db.query(`delete from orb_notifications where (user_id = $1 and actor_id = $2) or (user_id = $2 and actor_id = $1)`, [me, other]);
}

// -- presence -------------------------------------------------------------------------------------

const ROOM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** A page's peer id in a room: `<player id>:<6 random>` (src/lib/runtime/realtime.ts). */
const PEER_RE = /^[A-Za-z0-9_-]{1,40}:[a-z0-9]{6}$/;
const ROOMS_MAX = 8;

/** The rooms a heartbeat names, [{ room, peer }] ('' is the world's own room); anything else is dropped. */
function cleanRooms(v: unknown): FriendRoom[] {
  if (!Array.isArray(v)) return [];
  const out: FriendRoom[] = [];
  for (const r of v.slice(0, ROOMS_MAX)) {
    const room = (r as { room?: unknown } | null)?.room;
    const peer = (r as { peer?: unknown } | null)?.peer;
    if (typeof room !== 'string' || (room !== '' && !ROOM_RE.test(room)) || typeof peer !== 'string' || !PEER_RE.test(peer)) continue;
    if (!out.some((o) => o.room === room)) out.push({ room, peer });
  }
  return out;
}

/** "I'm here, with this world on my screen, in these of its rooms" (null: the start screen, or a world not saved yet). */
export async function heartbeat(db: Db, me: string, worldId: string | null, rooms: unknown = null): Promise<void> {
  const world = worldId && isWorldId(worldId) ? worldId : null;
  const inRooms = world ? cleanRooms(rooms) : [];
  await db.query(
    `insert into orb_presence (user_id, world_id, at, away, rooms) values ($1, $2, now(), false, $3::jsonb)
     on conflict (user_id) do update set world_id = excluded.world_id, at = now(), away = false, rooms = excluded.rooms`,
    [me, world, inRooms.length ? JSON.stringify(inRooms) : null],
  );
}

/** The page went away: offline now rather than after ONLINE_SECONDS. */
export async function leave(db: Db, me: string): Promise<void> {
  await db.query(`update orb_presence set world_id = null, rooms = null, at = now(), away = true where user_id = $1`, [me]);
}

// -- what a page shows ----------------------------------------------------------------------------

interface FriendRow {
  id: string;
  name: string;
  handle: string | null;
  status: string;
  requested_by: string;
  since: Date | string;
  seen_at: Date | string | null;
  online: boolean | null;
  world_id: string | null;
  own: boolean | null;
  rooms: unknown;
}

interface NoteRow {
  id: string | number;
  kind: string;
  created_at: Date | string;
  read: boolean;
  world_id: string | null;
  detail: unknown;
  from_id: string | null;
  from_name: string | null;
  from_handle: string | null;
}

/** Friends with where they are, requests both ways and the latest notifications. */
export async function friendsData(db: Db, me: string): Promise<FriendsData> {
  const rows = await db.query<FriendRow>(
    `select u.id, u.name, ${HANDLE_OF('u.id')} as handle, f.status, f.requested_by, f.updated_at as since,
            p.at as seen_at, ${ONLINE} as online, p.world_id, (w.owner_user = u.id) as own, p.rooms
     from orb_friends f
     join orb_users u on u.id = (case when f.a = $1 then f.b else f.a end)
     left join orb_presence p on p.user_id = u.id and f.status = 'friends'
     left join orb_worlds w on w.id = p.world_id
     where f.a = $1 or f.b = $1`,
    [me],
  );
  // A remix's maker may have no account: their name is the remix's author name then.
  const notes = await db.query<NoteRow>(
    `select n.id, n.kind, n.created_at, (n.read_at is not null) as read, n.world_id, n.detail,
            u.id as from_id, coalesce(u.name, rw.author_name) as from_name, ${HANDLE_OF('u.id')} as from_handle
     from orb_notifications n left join orb_users u on u.id = n.actor_id left join orb_worlds rw on rw.id = n.world_id
     where n.user_id = $1 and n.created_at > now() - interval '${NOTES_DAYS} days' and (u.id is not null or n.kind in ('remix', 'sale'))
     order by n.id desc limit ${NOTES_SHOWN}`,
    [me],
  );
  const here = rows.filter((r) => r.status === 'friends' && r.online && r.world_id).map((r) => r.world_id!);
  const cards = await publicCards(db, [...here, ...notes.map((n) => n.world_id ?? '')]);

  const friends: Friend[] = [];
  const incoming: FriendRequest[] = [];
  const outgoing: FriendRequest[] = [];
  for (const r of rows) {
    const person: Person = { id: r.id, name: r.name, handle: r.handle };
    if (r.status !== 'friends') {
      (r.requested_by === me ? outgoing : incoming).push({ ...person, at: iso(r.since) });
      continue;
    }
    const world = r.online && r.world_id ? (cards.get(r.world_id) ?? null) : null;
    const rooms = world ? cleanRooms(r.rooms) : [];
    friends.push({ ...person, online: !!r.online, seenAt: r.seen_at ? iso(r.seen_at) : null, world, own: !!world && !!r.own, rooms });
  }
  const seen = (f: Friend) => (f.seenAt ? Date.parse(f.seenAt) : 0);
  friends.sort((x, y) => Number(!!y.world) - Number(!!x.world) || Number(y.online) - Number(x.online) || seen(y) - seen(x) || x.name.localeCompare(y.name));
  const newest = (x: FriendRequest, y: FriendRequest) => Date.parse(y.at) - Date.parse(x.at);
  incoming.sort(newest);
  outgoing.sort(newest);

  const shown: FriendNote[] = [];
  for (const n of notes) {
    const world = n.world_id ? (cards.get(n.world_id) ?? null) : null;
    if ((n.kind === 'invite' || n.kind === 'remix' || n.kind === 'sale') && !world) continue;
    const note: FriendNote = {
      id: Number(n.id),
      kind: n.kind as FriendNoteKind,
      // Who bought things isn't the maker's business: a sale comes from "someone".
      from: n.kind === 'sale' ? { id: '', name: 'Someone', handle: null } : { id: n.from_id ?? '', name: n.from_name?.trim() || 'Someone', handle: n.from_handle },
      world,
      at: iso(n.created_at),
      read: !!n.read,
    };
    if (n.kind === 'sale') {
      const d = (n.detail ?? {}) as { count?: unknown; credits?: unknown; item?: unknown };
      note.sale = { count: Math.max(1, Number(d.count) || 1), credits: Math.max(0, Number(d.credits) || 0), item: typeof d.item === 'string' ? d.item : '' };
    }
    shown.push(note);
  }
  return { friends, incoming, outgoing, notes: shown, unread: shown.filter((n) => !n.read).length };
}

/** Mark notifications read: these ids, or all of them. */
export async function markRead(db: Db, me: string, ids?: unknown): Promise<void> {
  const list = Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 100) : null;
  if (list && !list.length) return;
  await db.query(`update orb_notifications set read_at = now() where user_id = $1 and read_at is null${list ? ` and id = any($2::bigint[])` : ''}`, list ? [me, list] : [me]);
}

/** Invite friends into a public world → how many were invited (each friend once per world per few minutes). */
export async function inviteFriends(db: Db, me: string, worldId: unknown, to: unknown): Promise<number> {
  const world = isWorldId(worldId) ? (await db.query<{ visibility: string }>(`select visibility from orb_worlds where id = $1`, [worldId]))[0] : undefined;
  if (!world) fail(404, 'not_found', 'This world does not exist.');
  if (world.visibility !== 'public') fail(400, 'private_world', 'Only you can open this world while it’s private. Make it public to invite friends.');
  const ids = Array.isArray(to) ? [...new Set(to.filter(isUserId))].slice(0, INVITE_MAX) : [];
  if (!ids.length) fail(400, 'bad_request', 'Pick a friend to invite.');
  const rows = await db.query<{ user_id: string }>(
    `insert into orb_notifications (user_id, kind, actor_id, world_id)
     select t.id, 'invite', $1, $2 from unnest($3::text[]) as t(id)
     where exists (select 1 from orb_friends f where f.status = 'friends' and ((f.a = $1 and f.b = t.id) or (f.a = t.id and f.b = $1)))
       and not exists (select 1 from orb_notifications n where n.user_id = t.id and n.kind = 'invite' and n.actor_id = $1 and n.world_id = $2
                       and n.created_at > now() - interval '${INVITE_AGAIN_MINUTES} minutes')
     returning user_id`,
    [me, worldId, ids],
  );
  return rows.length;
}

/** Friends' newest worlds (listed ones), for the start screen. */
export async function friendsWorlds(db: Db, me: string, limit = 12): Promise<WorldCard[]> {
  const ids = (await db.query<{ id: string }>(`select case when a = $1 then b else a end as id from orb_friends where status = 'friends' and (a = $1 or b = $1)`, [me])).map((r) => r.id);
  return worldsBy(db, { users: ids }, limit);
}

// -- profiles -------------------------------------------------------------------------------------

/** The maker at /<handle>, as `viewer` sees them. */
export async function profile(db: Db, viewer: Viewer, raw: string): Promise<Profile> {
  const handle = raw.toLowerCase();
  if (!isPathPart(handle) || RESERVED.has(handle)) fail(404, 'not_found', NOBODY);
  const row = (
    await db.query<{ user_id: string | null; user_name: string | null; created_at: Date | string | null; device_name: string | null }>(
      `select u.id as user_id, u.name as user_name, u.created_at, d.name as device_name
       from orb_handles h left join orb_users u on u.id = h.owner_user left join orb_devices d on d.hash = h.owner_device
       where h.handle = $1`,
      [handle],
    )
  )[0];
  if (!row) fail(404, 'not_found', NOBODY);
  const worlds = await worldsBy(db, { handle }, 24);
  const name = row.user_name?.trim() || row.device_name?.trim() || worlds[0]?.authorName || handle;
  const out: Profile = { handle, name, id: row.user_id, friend: 'none', friendCount: 0, since: row.created_at ? iso(row.created_at) : null, online: false, world: null, own: false, rooms: [], worlds };
  if (!row.user_id) return out;

  out.friendCount = (await db.query<{ n: number }>(`select count(*)::int as n from orb_friends where status = 'friends' and (a = $1 or b = $1)`, [row.user_id]))[0]?.n ?? 0;
  const me = await sessionUser(db, viewer);
  if (!me) return out;
  out.friend = await standing(db, me, row.user_id);
  if (out.friend === 'friends') {
    const p = (
      await db.query<{ world_id: string | null; online: boolean; own: boolean | null; rooms: unknown }>(
        `select p.world_id, ${ONLINE} as online, (w.owner_user = p.user_id) as own, p.rooms from orb_presence p left join orb_worlds w on w.id = p.world_id where p.user_id = $1`,
        [row.user_id],
      )
    )[0];
    if (p?.online) {
      out.online = true;
      out.world = p.world_id ? ((await publicCards(db, [p.world_id])).get(p.world_id) ?? null) : null;
      out.own = !!out.world && !!p.own;
      out.rooms = out.world ? cleanRooms(p.rooms) : [];
    }
  }
  return out;
}
