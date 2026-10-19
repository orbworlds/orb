// Stand-in for src/server/worlds.ts (type stripping can't load its parameter properties, and it pulls
// in the database and React): the helpers other server modules take from it, as they behave there.
export class HttpError extends Error {
  constructor(status, code, message, extra = {}, headers = {}) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}

export function fail(status, code, message, extra) {
  throw new HttpError(status, code, message, extra);
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const isWorldId = (id) => typeof id === 'string' && ID_RE.test(id);

export async function sessionUser(db, viewer) {
  if (!viewer.userId) return null;
  const rows = await db.query(`select id from orb_users where id = $1`, [viewer.userId]);
  return rows[0]?.id ?? null;
}
