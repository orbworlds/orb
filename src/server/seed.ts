// Upserts the curated Explore catalog from src/data/seeds.json. One statement, idempotent:
// re-running refreshes metadata but never touches plays/likes/forks.
//
// A seed is embedded by URL until Orb hosts its code: seeds marked `native` (open source, with a
// license that allows it, and runnable without a build step) are imported from their repository
// once (`convertSeeds`) and from then on are ordinary Orb worlds — playable, remixable, credited.
import type { Db } from './db';
import seeds from '../data/seeds.json';

export interface Seed {
  id: string;
  name: string;
  description: string;
  external_url: string;
  source_url: string | null;
  author_name: string;
  tags: string[];
  verified: boolean;
  featured: number;
  thumb_url: string;
  /** Host its code on Orb (imported from source_url); the license was checked by hand. */
  native?: { license?: string };
  /** Kept out of Explore (playable by link, listed on the secret page in src/app/lab). */
  hidden?: boolean;
  /** Where it came from: its maker's post (and that post's views), the prompt they shared. */
  origin?: SeedOrigin;
}

export interface SeedOrigin {
  post_url?: string | null;
  platform?: string | null;
  views?: number | null;
  likes?: number | null;
  stars?: number | null;
  posted_at?: string | null;
  handle?: string | null;
  author_url?: string | null;
  prompt?: string | null;
  made_with?: string | null;
}

/** The origin as it's stored (orb_worlds.origin, read by toOrigin in ./worlds). */
function originRow(o: SeedOrigin | undefined): Record<string, unknown> | null {
  if (!o) return null;
  return {
    postUrl: o.post_url ?? null,
    platform: o.platform ?? null,
    views: o.views ?? null,
    likes: o.likes ?? null,
    stars: o.stars ?? null,
    postedAt: o.posted_at ?? null,
    handle: o.handle ?? null,
    authorUrl: o.author_url ?? null,
    prompt: o.prompt ?? null,
    madeWith: o.made_with ?? null,
  };
}

export const SEEDS: readonly Seed[] = seeds as Seed[];

const UPSERT = `
insert into orb_worlds as w
  (id, name, description, kind, external_url, source_url, author_name, tags, verified, featured,
   thumb_url, visibility, forkable, license, hidden, origin)
select s.id, s.name, s.description, 'external', s.external_url, s.source_url, s.author_name,
       coalesce(array(select jsonb_array_elements_text(s.tags)), '{}'), s.verified, s.featured,
       s.thumb_url, 'public', false, s.license, s.hidden, s.origin
from jsonb_to_recordset($1::jsonb) as s(
  id text, name text, description text, external_url text, source_url text, author_name text,
  tags jsonb, verified boolean, featured integer, thumb_url text, license text, hidden boolean, origin jsonb)
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  -- a seed whose code Orb hosts now (converted) stays native
  kind = case when w.tree is null then 'external' else w.kind end,
  external_url = excluded.external_url,
  source_url = excluded.source_url,
  author_name = excluded.author_name,
  tags = excluded.tags,
  verified = excluded.verified,
  featured = excluded.featured,
  thumb_url = excluded.thumb_url,
  visibility = 'public',
  forkable = w.tree is not null,
  license = case when w.tree is null then w.license else excluded.license end,
  hidden = excluded.hidden,
  origin = excluded.origin,
  updated_at = now()
-- a curated world that was handed to an account is theirs now: leave it alone
where w.owner_user is null and w.owner_device is null`;

export async function applySeeds(db: Db): Promise<void> {
  if (!SEEDS.length) return;
  const rows = SEEDS.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    external_url: s.external_url,
    source_url: s.source_url ?? null,
    author_name: s.author_name,
    tags: s.tags,
    verified: !!s.verified,
    featured: s.featured | 0,
    thumb_url: s.thumb_url || `/seeds/${s.id}.webp`,
    license: s.native?.license ?? null,
    hidden: !!s.hidden,
    origin: originRow(s.origin),
  }));
  await db.query(UPSERT, [JSON.stringify(rows)]);
  // Curated worlds that were dropped from the list (e.g. a site that went down or stopped allowing
  // embeds) leave Explore too: embedded ones, and hosted ones (imported from their repository).
  // Only unowned rows are touched; Orb's own Originals (orb-…) are managed by ./originals.ts.
  await db.query(
    `delete from orb_worlds
     where owner_device is null and owner_user is null and not (id = any($1::text[]))
       and (kind = 'external' or (source_url is not null and id not like 'orb-%'))`,
    [rows.map((r) => r.id)],
  );
}

/**
 * Host the code of `native` seeds that are still embedded: import each from its repository and
 * turn the row into an Orb world (same id, plays, likes and thumbnail). At most `limit` per call
 * (each downloads a repository). Returns how many were converted and how many are left.
 */
export async function convertSeeds(db: Db, limit = 1, again: string[] = []): Promise<{ converted: string[]; failed: Record<string, string>; left: number }> {
  const want = SEEDS.filter((s) => s.native && s.source_url).map((s) => s.id);
  if (!want.length) return { converted: [], failed: {}, left: 0 };
  // `again`: converted already, but import their code once more (e.g. after an importer fix).
  const rows = await db.query<{ id: string; source_url: string }>(
    `select id, source_url from orb_worlds where id = any($1::text[]) and (tree is null or id = any($2::text[]))`,
    [want, again],
  );
  const { importRepo, parseRepoUrl } = await import('./importer');
  const { SEED_PAGES } = await import('@/data/seed-pages');
  const converted: string[] = [];
  const failed: Record<string, string> = {};
  for (const r of rows.slice(0, limit)) {
    const seed = SEEDS.find((s) => s.id === r.id)!;
    try {
      const ref = parseRepoUrl(r.source_url);
      if (!ref) throw new Error('not a GitHub repository');
      const imp = await importRepo(db, ref, { page: SEED_PAGES[r.id] });
      await db.query(
        `with u as (
           update orb_worlds set kind = 'native', code = (select convert_from(b.data, 'UTF8') from orb_blobs b where b.sha = ((select files from orb_trees where sha = $2) ->> 'index.html')),
             tree = $2, version = version + 1, forkable = true, license = $3, updated_at = now()
           where id = $1 and (tree is null or tree <> $2)
           returning id, version, code, tree
         )
         insert into orb_world_versions (world_id, version, code, tree, prompt) select id, version, code, tree, $4 from u`,
        [r.id, imp.tree, seed.native!.license ?? null, `Imported from ${r.source_url}`],
      );
      converted.push(r.id);
    } catch (e) {
      failed[r.id] = e instanceof Error ? e.message : String(e);
    }
  }
  return { converted, failed, left: rows.length - converted.length };
}
