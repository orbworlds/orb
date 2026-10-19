import type { TemplateInfo } from './types';

// Hand-crafted starter worlds: the blank island (public/templates/blank.html) and Orb Originals, whose
// code is the Original's (made in its own repository, src/data/originals.json). Thumbnails: public/templates/<id>.webp.
export const TEMPLATES: TemplateInfo[] = [
  {
    id: 'blank',
    name: 'Blank',
    blurb: 'A quiet little island in the sky',
    suggestions: ['A castle on a cloud', 'A forest with glowing mushrooms', 'A cozy village by the sea'],
    path: '/templates/blank.html',
    thumb: '/templates/blank.webp',
    tag: 'blank',
  },
  {
    id: 'island',
    name: 'Island',
    blurb: 'Explore a sunny island on foot',
    suggestions: ['Add a hidden treasure', 'Make it sunset', 'Add a little boat on the water'],
    world: 'orb-island',
    thumb: '/templates/island.webp',
    tag: 'world',
  },
  {
    id: 'blocks',
    name: 'Blocks',
    blurb: 'Build anything, block by block',
    suggestions: ['Add glass and lava blocks', 'Make it snow', 'Start with a little house'],
    world: 'orb-blocks',
    thumb: '/templates/blocks.webp',
    tag: 'toy',
  },
  {
    id: 'runner',
    name: 'Star Runner',
    blurb: 'A tiny game: dash, jump, collect stars',
    suggestions: ['Add enemies to dodge', 'Make it faster each level', 'Add a high-score board'],
    world: 'orb-runner',
    thumb: '/templates/runner.webp',
    tag: 'game',
  },
  {
    id: 'paint',
    name: 'Glow Paint',
    blurb: 'Paint with light in 3D space',
    suggestions: ['Add a rainbow brush', 'Make strokes float like ribbons', 'Add music that follows my brush'],
    world: 'orb-paint',
    thumb: '/templates/paint.webp',
    tag: 'art',
  },
  {
    id: 'hangout',
    name: 'Hangout',
    blurb: 'Meet friends in a glowing plaza',
    suggestions: ['Add a dance floor', 'Make it a beach party', 'Add a game of tag'],
    world: 'orb-hangout',
    thumb: '/templates/hangout.webp',
    tag: 'world',
  },
  {
    id: 'lanterns',
    name: 'Wish Lanterns',
    blurb: 'Release a wish into the night sky',
    suggestions: ['Add shooting stars', 'Make the lanterns different colors', 'Add soft music by the lake'],
    world: 'orb-lanterns',
    thumb: '/templates/lanterns.webp',
    tag: 'world',
  },
  {
    id: 'garden',
    name: 'Garden',
    blurb: 'Plant a flower everyone can see',
    suggestions: ['Add a vegetable patch', 'Make it autumn', 'Add a friendly snail'],
    world: 'orb-garden',
    thumb: '/templates/garden.webp',
    tag: 'world',
  },
  {
    id: 'room',
    name: 'Dream Room',
    blurb: 'Decorate a cozy room, your way',
    suggestions: ['Add a sleepy cat', 'Make it a treehouse', 'Add a window with rain'],
    world: 'orb-room',
    thumb: '/templates/room.webp',
    tag: 'world',
  },
];

export const TEMPLATE_BY_ID: Record<string, TemplateInfo> = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));

/** Small thumbnail for template cards (scripts/gen-template-cards.mjs); `thumb` is full size. */
export const templateCard = (t: TemplateInfo): string => `/templates/cards/${t.id}.webp`;

export async function fetchTemplate(id: string): Promise<string> {
  const t = TEMPLATE_BY_ID[id] ?? TEMPLATE_BY_ID.blank;
  if (t.world) {
    const res = await fetch(`/api/worlds/${encodeURIComponent(t.world)}`);
    const code = res.ok ? ((await res.json()) as { world?: { code?: string | null } }).world?.code : null;
    if (!code) throw new Error(`Template ${id} failed to load`);
    return code;
  }
  const res = await fetch(t.path ?? '/templates/blank.html', { cache: 'force-cache' });
  if (!res.ok) throw new Error(`Template ${id} failed to load`);
  return res.text();
}
