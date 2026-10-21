// "Orb Originals": Orb's own worlds, listed in Explore by their maker, orbworlds (its page is /orbworlds). Each is made in a GitHub
// repository of its own (src/data/originals.json says which) and its files come from there: every
// Original is linked to its repository like any world kept in sync with GitHub (./reposync.ts),
// which brings in a new commit as the Original's files, in place. This catalog holds what Orb says
// about them (name, Explore copy, tags, order, thumbnail); never their code.
// Idempotent: refreshes the copy once per deployment but never touches plays/likes/forks.
// A preview Original starts private (an admin can hand it to an account to try it out) and keeps
// whatever visibility it has; the others are always public.

import catalog from '@/data/originals.json';
import type { Db } from './db';

export interface Original {
  id: string;
  /** Its repository in the org (catalog.org) and the branch Orb plays: main, or `orb` for a project its CI packages. */
  repo: string;
  branch: string;
  /** The starter template it is (null for worlds that aren't one). */
  template: string | null;
  name: string;
  description: string;
  tags: string[];
  featured: number;
  thumb: string | null;
  /** Not released yet: created private, never made public automatically. */
  preview?: boolean;
  /** Plays by link but isn't listed in Explore (the lab's Hidden worlds list it). */
  hidden?: boolean;
  /** Its repository is public: the world links to it ("Source code · MIT"). */
  public: boolean;
}

/** Orb's GitHub org, and the maker of Orb's own worlds (their author and the handle of their page). */
export const ORG: string = catalog.org;
export const ORIGINALS = catalog.worlds as Original[];
const repoOf = (o: Original) => `${ORG}/${o.repo}`;

/** Originals that were replaced: hidden (not deleted, so remixes keep their history). */
const RETIRED = ['orb-aurora'];

export async function applyOriginals(db: Db): Promise<void> {
  if (!ORIGINALS.length) return;
  const params: unknown[] = [];
  const rows = ORIGINALS.map((o) => {
    const b = params.length;
    params.push(o.id, o.name, o.description, o.template, o.tags, o.featured, o.thumb, o.preview ? 'private' : 'public', !!o.hidden, o.public ? `https://github.com/${repoOf(o)}` : null, o.public ? catalog.license : null);
    return `($${b + 1}, $${b + 2}, $${b + 3}, 'native', '${ORG}', $${b + 8}, true, $${b + 4}, $${b + 5}::text[], $${b + 6}, $${b + 7}, 1, $${b + 9}::boolean, $${b + 10}, $${b + 11})`;
  });
  await db.query(
    `insert into orb_worlds (id, name, description, kind, author_name, visibility, forkable, template, tags, featured, thumb_url, version, hidden, source_url, license)
     values ${rows.join(', ')}
     on conflict (id) do update set
       name = excluded.name, description = excluded.description,
       template = excluded.template, tags = excluded.tags, featured = excluded.featured,
       thumb_url = excluded.thumb_url, source_url = excluded.source_url, license = excluded.license, kind = 'native', author_name = excluded.author_name,
       visibility = case when excluded.visibility = 'private' then orb_worlds.visibility else 'public' end,
       hidden = excluded.hidden, forkable = true, updated_at = now()`,
    params,
  );
  // each follows its repository (the files come in through ./reposync.ts)
  const lp: unknown[] = [];
  const links = ORIGINALS.map((o) => {
    const b = lp.length;
    lp.push(o.id, repoOf(o), o.branch);
    return `($${b + 1}, $${b + 2}, $${b + 3}, '')`;
  });
  await db.query(
    `insert into orb_world_repos (world_id, repo, branch, root) values ${links.join(', ')}
     on conflict (world_id) do update set
       synced_sha = case when orb_world_repos.repo = excluded.repo and orb_world_repos.branch = excluded.branch then orb_world_repos.synced_sha end,
       repo = excluded.repo, branch = excluded.branch, root = ''`,
    lp,
  );
  await db.query(
    `update orb_worlds set visibility = 'private' where id = any($1::text[]) and owner_user is null and owner_device is null and author_name in ('Orb', $2)`,
    [RETIRED, ORG],
  );
}
