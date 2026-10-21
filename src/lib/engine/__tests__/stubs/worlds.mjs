// Stand-in for src/server/worlds.ts (it pulls in the database and React): the helpers other server
// modules take from it, as they behave there.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const isWorldId = (id) => typeof id === 'string' && ID_RE.test(id);

export async function sessionUser(db, viewer) {
  if (!viewer.userId) return null;
  const rows = await db.query(`select id from orb_users where id = $1`, [viewer.userId]);
  return rows[0]?.id ?? null;
}
