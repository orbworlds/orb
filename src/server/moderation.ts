// Keeping worlds out of Explore by hand, from the lab (/lab/<key>/hide): a script's worlds, say. The
// script check (./buildlimits.ts scripted) hides its worlds by itself.

import type { Db } from './db';
import { resolvePath } from './paths';
import { isWorldId } from './worlds';

/**
 * Keep worlds out of Explore (`hidden`: they still play by link, and Explore shows them under "N
 * hidden" after its list) or let them back in: each named by its id or its link on Orb (/w/<id> or
 * /<handle>/<world>). The ids it changed.
 */
export async function hideWorlds(db: Db, refs: string[], hidden: boolean): Promise<string[]> {
  const ids = new Set<string>();
  for (const ref of refs) {
    const path = ref.trim().replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
    const parts = path.split('/');
    const id = parts.length === 1 ? parts[0] : parts[0] === 'w' ? decodeURIComponent(parts[1] ?? '') : await resolvePath(db, parts[0], parts[1] ?? '');
    if (id && isWorldId(id)) ids.add(id);
  }
  if (!ids.size) return [];
  const rows = await db.query<{ id: string }>(`update orb_worlds set hidden = $2 where id = any($1::text[]) and hidden <> $2 returning id`, [[...ids], hidden]);
  return rows.map((r) => r.id);
}
