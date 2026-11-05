// Orb's own order of the curated worlds, best first. Trending leads with the first CURATED_LEAD of
// them, in this order; after those, every world is ranked by what people play (its plays now and
// all-time, likes and remixes), this order counting a little too, so a world nobody has found yet
// still has its place. Ids that aren't listed (hidden, broken, deleted) are simply skipped.
// The start screen's row shows the first five or so: keep them different kinds of worlds (two
// blocky worlds among them at most, never side by side), and neighbours that don't look alike.

export const CURATED_ORDER: readonly string[] = [
  'orb-craft', 'orb-wildbrush', 'orb-bedwars', 'orb-foxfire', 'ext-tiny-skies', 'aw-turbo-kart-rally',
  'orb-vampirez', 'ext-little-prince', 'ext-walden', 'ext-messenger', 'ext-choo-choo-world', 'aw-fall-line', 'ext-arkenfall', 'aw-verdant-forest', 'ext-cyber-city-orion', 'ext-little-alchemy', 'ext-sisyphus',
  'ext-bruno-island', 'ext-claybound', 'aw-aimees-papercraft', 'aw-athenaion', 'ext-verdant', 'orb-runner', 'ext-clawd-rpg', 'ext-emberglade', 'orbitfall',
  'ext-kanso', 'aw-sakura-realm', 'ext-surfd', 'aw-gogh-strike', 'aw-merge-conflict', 'ext-orb-farm', 'ext-komorebi', 'ext-susurrus', 'ext-tiny-planet', 'ext-beyond-fable',
  'orb-lanterns', 'orb-hangout', 'ext-villa-marea', 'aw-synthcity', 'aw-long-wind', 'orb-garden', 'ext-wrong-physics', 'ext-hexgl', 'ext-pelagic-ocean', 'ext-marble-blast',
  'ext-vesperfall', 'aw-silent-meridian', 'aw-last-courier', 'aw-monolith-wilds', 'aw-backroad-rally', 'aw-kaiju-dokan', 'orb-island',
  'aw-celadon-the-long-ash', 'aw-sakura', 'aw-palmera-bay', 'aw-driftwing', 'ext-point-lookout', 'ext-molazone', 'orb-room', 'orb-paint',
  'ext-fluid', 'ext-singularity', 'aw-quick-grass', 'aw-nova-lancer', 'ext-voxel-frontline', 'aw-claude-of-duty', 'aw-neon-siege', 'ext-meridian-ash', 'aw-racing-game', 'aw-emberwake',
  'ext-still-here', 'orb-blocks', 'ext-brick-town',
  'aw-lumenshaders', 'aw-ez-tree', 'ext-particleverse', 'ext-song-maker', 'ext-rhythm', 'ext-ancient-earth', 'ext-diablo', 'ext-quake', 'ext-quake-2',
];

/** How many of Orb's order lead Trending as they are (at home: the lead tile and the row beside it). */
export const CURATED_LEAD = 6;

/** Position in Orb's order (0 = first), or -1 for a world that isn't in it. */
export const curatedRank = (id: string): number => CURATED_ORDER.indexOf(id);
