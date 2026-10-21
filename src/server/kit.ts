// The Orb kit pushing a world from someone's computer (`orb push`, kit/lib/push.mjs).
//
// Signing in, once per computer: the kit asks for a code (`startLogin`), the person opens
// /kit/<code> in the browser they use Orb in and allows it (`approveLogin`), and the kit, polling
// with its secret, picks up a token (`pollLogin`) that acts as that browser — its device, and its
// account if signed in (see signKitToken in ./auth.ts). Nothing to paste, so a coding agent can
// show the link and wait.
//
// Pushing (`pushWorld`): the world's files as a .tar.gz. To a world of theirs it is a new version
// (nothing when nothing changed); to someone else's public, remixable world, a remix of it; with no
// world, a new world of theirs.

import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';
import { canEdit, randomId, signKitToken, type Viewer } from './auth';
import { openKey, sealKey } from './agent/secrets';
import type { Db } from './db';
import { fail } from './http';
import { cleanPath, FILE_LIMITS, FileError, putBlob, putTree, sha256, type Tree } from './files';
import { detectLicense, LICENSE_FILE, SKIP_DIR, titleOf, untar } from './importer';
import { commitTree, createRemixFromTree, createWorldFromTree, getWorldForViewer, sessionUser } from './worlds';
import type { WorldFull } from '@/lib/types';

const LOGIN_MINUTES = 10;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export async function startLogin(db: Db): Promise<{ code: string; poll: string }> {
  await db.query(`delete from orb_kit_logins where created_at < now() - make_interval(mins => $1)`, [LOGIN_MINUTES]);
  const poll = randomId(40);
  for (;;) {
    const bytes = crypto.randomBytes(8);
    const raw = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const rows = await db.query<{ code: string }>(`insert into orb_kit_logins (code, poll_hash) values ($1, $2) on conflict do nothing returning code`, [code, sha256(poll)]);
    if (rows[0]) return { code, poll };
  }
}

const normalizeCode = (raw: string): string | null => {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 && [...c].every((ch) => CODE_ALPHABET.includes(ch)) ? `${c.slice(0, 4)}-${c.slice(4)}` : null;
};

/** The person allows the kit to push as them: what they are known as on Orb. */
export async function approveLogin(db: Db, viewer: Viewer, rawCode: string): Promise<{ name: string | null }> {
  const code = normalizeCode(rawCode);
  if (!viewer.deviceHash && !viewer.userId) fail(400, 'device_required', 'Missing device key.');
  const rows = code
    ? await db.query<{ token_enc: string | null }>(`select token_enc from orb_kit_logins where code = $1 and created_at > now() - make_interval(mins => $2)`, [code, LOGIN_MINUTES])
    : [];
  if (!rows[0]) fail(404, 'not_found', 'That code has expired. Run the push again for a new one.');
  if (rows[0].token_enc) fail(409, 'already_approved', 'That computer can push already.');
  const userId = await sessionUser(db, viewer);
  const [who] = await db.query<{ name: string | null }>(
    `select coalesce((select nullif(btrim(name), '') from orb_users where id = $2::text), (select nullif(btrim(name), '') from orb_devices where hash = $1::text)) as name`,
    [viewer.deviceHash, userId],
  );
  const name = who?.name || null;
  await db.query(`update orb_kit_logins set token_enc = $2, name = $3 where code = $1`, [code, sealKey(signKitToken(viewer.deviceHash, userId)), name]);
  return { name };
}

/** What the kit's poll gets: the token once (then the login is gone), or still waiting, or nothing. */
export async function pollLogin(db: Db, poll: string): Promise<{ token: string; name: string | null } | 'pending' | null> {
  const [row] = await db.query<{ code: string; token_enc: string | null; name: string | null }>(
    `select code, token_enc, name from orb_kit_logins where poll_hash = $1 and created_at > now() - make_interval(mins => $2)`,
    [sha256(poll), LOGIN_MINUTES],
  );
  if (!row) return null;
  const token = openKey(row.token_enc);
  if (!token) return 'pending';
  await db.query(`delete from orb_kit_logins where code = $1`, [row.code]);
  return { token, name: row.name };
}

/** The pushed files (a .tar.gz) as a tree, skipping what never belongs in a world. */
async function readUpload(db: Db, body: ReadableStream<Uint8Array>): Promise<{ tree: string; files: Tree; skipped: string[]; text: (p: string) => string | null }> {
  const raw = new Map<string, Buffer>();
  const skipped: string[] = [];
  let total = 0;
  const gunzip = Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>).pipe(createGunzip());
  try {
    for await (const entry of untar(gunzip)) {
      const p = entry.path.replace(/^\.\//, '');
      if (!p || SKIP_DIR.test(p) || /(^|\/)\.(orb|DS_Store)(\/|$)/.test(p)) continue;
      const clean = cleanPath(p);
      if (!clean) {
        skipped.push(p.slice(0, 300));
        continue;
      }
      if (entry.data.length > FILE_LIMITS.file) throw new FileError(`${clean} is too big for a world (at most ${Math.round(FILE_LIMITS.file / 1e6)} MB a file).`);
      total += entry.data.length;
      if (total > FILE_LIMITS.total || raw.size >= FILE_LIMITS.files) throw new FileError(`That's more than a world can hold (${FILE_LIMITS.files} files, ${Math.round(FILE_LIMITS.total / 1e6)} MB).`);
      raw.set(clean, entry.data);
    }
  } catch (e) {
    if (e instanceof FileError) throw e;
    throw new FileError('Those files didn’t arrive as a .tar.gz.');
  }
  if (!raw.has('index.html')) throw new FileError('There is no index.html at the top of the folder, so there is no page to run.');
  const files: Tree = {};
  for (const [p, data] of raw) files[p] = (await putBlob(db, data)).sha;
  return { tree: await putTree(db, files), files, skipped, text: (p) => raw.get(p)?.toString('utf8') ?? null };
}

interface PushResult {
  world: WorldFull;
  /** 'created' (a new world), 'remixed' (a remix of someone else's), 'updated' (a new version) or 'unchanged'. */
  outcome: 'created' | 'remixed' | 'updated' | 'unchanged';
  /** Files left out: names or depths a world can't hold (see cleanPath). */
  skipped: string[];
}

export async function pushWorld(
  db: Db,
  viewer: Viewer,
  body: ReadableStream<Uint8Array>,
  opts: { world?: string | null; name?: string | null; message?: string | null },
): Promise<PushResult> {
  if (!viewer.deviceHash && !viewer.userId) fail(401, 'kit_login', 'Sign the kit in first (orb push does it).');
  const up = await readUpload(db, body);
  const prompt = (opts.message || '').trim().slice(0, 200) || 'Pushed with the Orb kit';
  if (opts.world) {
    const [row] = await db.query<{ id: string; kind: string; owner_user: string | null; owner_device: string | null; visibility: string; forkable: boolean }>(
      `select id, kind, owner_user, owner_device, visibility, forkable from orb_worlds where id = $1`,
      [opts.world],
    );
    if (row && row.kind === 'native' && (await canEdit(db, viewer, row))) {
      const res = await commitTree(db, viewer, row.id, up.tree, { prompt, name: opts.name ?? null });
      const world = await getWorldForViewer(db, viewer, row.id);
      return { world: world!, outcome: res ? 'updated' : 'unchanged', skipped: up.skipped };
    }
    if (row && row.kind === 'native' && row.visibility === 'public' && row.forkable) {
      const license = licenseOf(up);
      const world = await createRemixFromTree(db, viewer, up.tree, row.id, { name: nameOf(up, opts.name), sourceUrl: null, prompt, license });
      return { world, outcome: 'remixed', skipped: up.skipped };
    }
    fail(404, 'not_found', `There is no world ${opts.world} of yours on Orb (and it can't be remixed). Push with --new to make a new one.`);
  }
  const world = await createWorldFromTree(db, viewer, up.tree, { name: nameOf(up, opts.name), prompt, license: licenseOf(up), forkable: true });
  return { world, outcome: 'created', skipped: up.skipped };
}

/** The name it was pushed with, else its page's title ('' leaves the world untitled). */
function nameOf(up: { text: (p: string) => string | null }, given?: string | null): string {
  return (given || '').trim() || titleOf(up.text('index.html') ?? '');
}

function licenseOf(up: { files: Tree; text: (p: string) => string | null }): string | null {
  const file = Object.keys(up.files).find((k) => LICENSE_FILE.test(k));
  return file ? detectLicense(up.text(file) ?? '') : null;
}
