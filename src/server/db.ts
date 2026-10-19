// Database access. Production: Supabase Postgres via `postgres` (pooled, transaction mode).
// Local/dev without POSTGRES_URL: embedded PGlite persisted under .data/pglite.
// Use `ready()` from ./schema to get a Db with the schema ensured.

import { after } from 'next/server';
import postgres from 'postgres';
import { inlineParams, storableParams } from './literals';

export type Row = Record<string, unknown>;
export interface Db {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  kind: 'postgres' | 'pglite';
}

// Pages and API routes are bundled separately, each with its own copy of this module: keep one
// database per process (one PGlite on its directory, one Postgres pool).
const shared = globalThis as typeof globalThis & { __orbDb?: Promise<Db> | null };

function cleanUrl(raw: string): string {
  // Vercel's Supabase URLs carry params like `supa=base-pooler.x` that postgres.js would forward
  // to the server as startup parameters (and fail). Keep only sslmode.
  try {
    const u = new URL(raw);
    const sslmode = u.searchParams.get('sslmode');
    u.search = '';
    if (sslmode) u.searchParams.set('sslmode', sslmode);
    return u.toString();
  } catch {
    return raw;
  }
}

/** Seconds an unused connection stays open. */
const IDLE_SECONDS = 5;

/**
 * Keep this instance up until the connections a query used have been closed for being idle.
 * Vercel freezes an instance between requests, a frozen instance can't close them (its timers
 * don't run), and every open one counts against the pooler's 200 clients. Only at run time on
 * Vercel (a prerender during the build has nothing to free).
 */
function lingerUntilIdle(): void {
  if (!process.env.VERCEL_REGION) return;
  const until = Date.now() + IDLE_SECONDS * 1000 + 500;
  try {
    after(() => new Promise((r) => setTimeout(r, Math.max(0, until - Date.now()))));
  } catch {
    // Outside a request: nothing to keep up.
  }
}

async function connect(): Promise<Db> {
  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (url) {
    const options = {
      prepare: false, // required for the transaction pooler
      // The pooler takes 200 clients in all, and a burst of visitors can start dozens of instances.
      max: 2,
      // One query at a time per connection: the transaction pooler never answers a query sent on a
      // connection while another one is still running there, so it would wait forever. (A real
      // postgres.js option, missing from its type definitions.)
      max_pipeline: 0,
      idle_timeout: IDLE_SECONDS,
      connect_timeout: 15,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? (false as const) : ('require' as const),
      onnotice: () => {},
    };
    const sql = postgres(cleanUrl(url), options);
    return {
      kind: 'postgres',
      async query<T>(text: string, params: unknown[] = []) {
        // One message per query, which the transaction pooler can't split (see ./literals).
        const message = params.length ? inlineParams(text, storableParams(text, params)) : text;
        try {
          for (let attempt = 0; ; attempt++) {
            try {
              return (await sql.unsafe(message)) as unknown as T[];
            } catch (e) {
              // Turned away while connecting because the pooler has all the clients it takes: the
              // query never ran, so it is safe to send again once some have gone.
              if (attempt >= 3 || !/\bEMAXCONN\b/.test(String((e as Error)?.message))) throw e;
              await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
            }
          }
        } finally {
          lingerUntilIdle();
        }
      },
    };
  }
  // Local fallback (never used on Vercel because POSTGRES_URL is set there).
  const modName = '@electric-sql/pglite';
  const { PGlite } = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ modName)) as typeof import('@electric-sql/pglite');
  const fs = await import('node:fs');
  const dir = process.env.ORB_PGLITE_DIR || '.data/pglite';
  fs.mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir);
  await pg.waitReady;
  return {
    kind: 'pglite',
    async query<T>(text: string, params: unknown[] = []) {
      // PGlite only supports multiple statements without params via exec()
      if (!params.length && text.includes(';') && text.trim().split(';').filter((s) => s.trim()).length > 1) {
        const res = await pg.exec(text);
        return (res[res.length - 1]?.rows ?? []) as T[];
      }
      return (await pg.query(text, storableParams(text, params))).rows as T[];
    },
  };
}

/** Raw database handle (schema not guaranteed). Prefer `ready()` from ./schema. */
export function getDb(): Promise<Db> {
  if (!shared.__orbDb) {
    shared.__orbDb = connect().catch((e) => {
      shared.__orbDb = null;
      throw e;
    });
  }
  return shared.__orbDb;
}
