// Schema (idempotent DDL) + seeding, each applied when it changed. Call `ready()` to get a usable Db.

import { createHash } from 'node:crypto';
import { getDb, type Db } from './db';
import { MIGRATION, SCHEMA_VERSION } from './ddl.mjs';
import { backfillPaths, repathCurated } from './paths';

// Shared by every bundle in the process (see ./db), so the schema and seeds are applied once.
const shared = globalThis as typeof globalThis & { __orbReady?: Promise<Db> | null };

/** Fingerprints of what this database has applied (none before orb_meta exists). */
async function applied(db: Db): Promise<Map<string, string>> {
  try {
    const rows = await db.query<{ key: string; value: string }>(`select key, value from orb_meta`);
    return new Map(rows.map((r) => [r.key, r.value]));
  } catch (e) {
    if ((e as { code?: unknown })?.code === '42P01') return new Map(); // undefined_table
    throw e;
  }
}

/** Database with schema ensured and seeds applied (memoized per process). */
export function ready(): Promise<Db> {
  if (!shared.__orbReady) {
    shared.__orbReady = (async () => {
      const db = await getDb();
      const done = await applied(db);
      if (done.get('schema') !== SCHEMA_VERSION) await db.query(MIGRATION);
      try {
        const { applySeeds, SEEDS } = await import('./seed');
        const { applyOriginals, ORIGINALS } = await import('./originals');
        // Once per deployment (its catalog, or the code that writes it, may have changed), and
        // whenever a curated world is missing (e.g. deleted after it was handed to someone).
        const seeds = createHash('sha1')
          .update(JSON.stringify([SCHEMA_VERSION, process.env.VERCEL_DEPLOYMENT_ID ?? '', SEEDS, ORIGINALS]))
          .digest('hex')
          .slice(0, 16);
        const ids = [...new Set([...SEEDS.map((s) => s.id), ...ORIGINALS.map((o) => o.id)])];
        const present = async () => (await db.query<{ n: number }>(`select count(*)::int as n from orb_worlds where id = any($1::text[])`, [ids]))[0].n;
        if (done.get('seeds') !== seeds || (await present()) < ids.length) {
          await applySeeds(db);
          await applyOriginals(db);
          await repathCurated(db);
          await db.query(`insert into orb_meta (key, value) values ('seeds', $1) on conflict (key) do update set value = excluded.value, at = now()`, [seeds]);
        }
        // Readable URLs for worlds that don't have one yet (a few per start; instant once done —
        // serverless functions freeze work left running after the response, so this is awaited).
        await backfillPaths(db, 80).catch((e) => console.error('[orb] path backfill failed', e));
      } catch (e) {
        console.error('[orb] seeding failed', e);
      }
      return db;
    })().catch((e) => {
      shared.__orbReady = null;
      throw e;
    });
  }
  return shared.__orbReady;
}
