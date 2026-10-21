// Dev-only fixtures for /dev/panels: procedural "world" thumbnails (SVG), realistic world
// cards, versions, and an in-page mock of the /api routes the panels use.

import type { ApiConfig, MeResponse, WorldCard, WorldFull, WorldVersionInfo } from '@/lib/types';

// ---------------------------------------------------------------------------------------------
// Seeded randomness

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Procedural thumbnails (640×400 SVG scenes)

type Scene = 'island' | 'hills' | 'night' | 'blocks' | 'neon' | 'paint' | 'room' | 'clouds' | 'reef' | 'snow';

const W = 640;
const H = 400;

function hillPath(rand: () => number, baseY: number, amp: number, steps = 6) {
  let d = `M0 ${H} L0 ${baseY}`;
  const seg = W / steps;
  let prevY = baseY;
  for (let i = 1; i <= steps; i++) {
    const x = i * seg;
    const y = baseY + (rand() - 0.5) * amp;
    d += ` C${x - seg * 0.6} ${prevY} ${x - seg * 0.4} ${y} ${x} ${y}`;
    prevY = y;
  }
  return `${d} L${W} ${H} Z`;
}

function sky(id: string, top: string, mid: string, bottom: string) {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset=".6" stop-color="${mid}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>`;
}

function cube(x: number, y: number, s: number, top: string, left: string, right: string) {
  const h = s * 0.58;
  return `<path d="M${x} ${y} l${s} ${-h} l${s} ${h} l${-s} ${h}Z" fill="${top}"/><path d="M${x} ${y} l${s} ${h} v${s * 1.15} l${-s} ${-h}Z" fill="${left}"/><path d="M${x + s} ${y + h} l${s} ${-h} v${s * 1.15} l${-s} ${h}Z" fill="${right}"/>`;
}

function sceneSvg(scene: Scene, seed: number): string {
  const r = mulberry32(seed);
  const parts: string[] = [];
  const defs: string[] = ['<filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="18"/></filter>', '<filter id="s" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter>'];
  switch (scene) {
    case 'island': {
      defs.push(sky('sk', '#7fc4ff', '#bfe3ff', '#ffe2c4'));
      parts.push(`<rect width="${W}" height="${H}" fill="url(#sk)"/>`);
      parts.push(`<circle cx="${460 + r() * 80}" cy="120" r="70" fill="#fff4d6" filter="url(#b)" opacity=".9"/><circle cx="${470}" cy="120" r="34" fill="#fff8e6"/>`);
      parts.push(`<rect y="250" width="${W}" height="150" fill="#5fb7d6"/><rect y="250" width="${W}" height="6" fill="#bfe9f5" opacity=".8"/>`);
      parts.push(`<ellipse cx="300" cy="262" rx="190" ry="34" fill="#f2d39b"/><path d="M150 262 C200 170 380 160 450 262Z" fill="#7cc48a"/><path d="M210 262 C250 200 330 196 380 262Z" fill="#5aa874"/>`);
      for (let i = 0; i < 3; i++) {
        const x = 230 + i * 60 + r() * 20;
        parts.push(`<path d="M${x} 230 q4 -50 ${8 + r() * 10} -78" stroke="#8a6440" stroke-width="5" fill="none" stroke-linecap="round"/><g fill="#3f9a63">${[0, 1, 2, 3, 4].map((k) => `<ellipse cx="${x + 12}" cy="152" rx="30" ry="9" transform="rotate(${k * 72 + r() * 20} ${x + 12} 152) translate(18 0)"/>`).join('')}</g>`);
      }
      for (let i = 0; i < 9; i++) parts.push(`<rect x="${r() * W}" y="${290 + r() * 100}" width="${30 + r() * 50}" height="2" rx="1" fill="#e6f8ff" opacity=".6"/>`);
      break;
    }
    case 'hills': {
      defs.push(sky('sk', '#a99cff', '#ffc2d6', '#ffe4c2'));
      parts.push(`<rect width="${W}" height="${H}" fill="url(#sk)"/><circle cx="${200 + r() * 240}" cy="210" r="90" fill="#fff1dc" filter="url(#b)"/><circle cx="320" cy="215" r="44" fill="#fff6ea" opacity=".9"/>`);
      const layers = ['#e9a7c4', '#c88ab8', '#9d74aa', '#6f5a93'];
      layers.forEach((c, i) => parts.push(`<path d="${hillPath(r, 230 + i * 42, 60 - i * 6)}" fill="${c}"/>`));
      for (let i = 0; i < 14; i++) {
        const x = r() * W;
        const y = 330 + r() * 60;
        parts.push(`<path d="M${x} ${y} l7 -22 l7 22Z" fill="#4c3f73" opacity=".85"/>`);
      }
      break;
    }
    case 'night': {
      defs.push(sky('sk', '#0d1033', '#26285e', '#4a3d78'));
      parts.push(`<rect width="${W}" height="${H}" fill="url(#sk)"/>`);
      for (let i = 0; i < 70; i++) parts.push(`<circle cx="${r() * W}" cy="${r() * 230}" r="${r() * 1.4 + 0.3}" fill="#fff" opacity="${0.4 + r() * 0.6}"/>`);
      parts.push(`<circle cx="${480 + r() * 60}" cy="90" r="60" fill="#d9dcff" filter="url(#b)" opacity=".5"/><circle cx="500" cy="90" r="26" fill="#f4f3ff"/>`);
      parts.push(`<path d="${hillPath(r, 270, 80, 5)}" fill="#1d1f4a"/><path d="${hillPath(r, 320, 50)}" fill="#141538"/>`);
      for (let i = 0; i < 26; i++) {
        const x = r() * W;
        const y = 250 + r() * 140;
        parts.push(`<circle cx="${x}" cy="${y}" r="6" fill="#ffe28a" filter="url(#s)" opacity=".8"/><circle cx="${x}" cy="${y}" r="1.8" fill="#fff6c9"/>`);
      }
      break;
    }
    case 'blocks': {
      defs.push(sky('sk', '#bfe6ff', '#e3f4ff', '#f7fbff'));
      parts.push(`<rect width="${W}" height="${H}" fill="url(#sk)"/><circle cx="120" cy="80" r="60" fill="#fff" filter="url(#b)"/>`);
      const s = 34;
      const palettes: [string, string, string][] = [
        ['#8fd99a', '#5fb46e', '#4a9b5a'],
        ['#f3d48a', '#d8b263', '#c29a4c'],
        ['#a7c7ff', '#7ea6ef', '#6a8fd8'],
        ['#ffb3c7', '#e48ea6', '#cc7690'],
      ];
      for (let gy = 0; gy < 6; gy++)
        for (let gx = 0; gx < 6; gx++) {
          const x = 320 + (gx - gy) * s - s;
          const y = 160 + (gx + gy) * s * 0.58;
          const p = gy < 2 && gx > 3 ? palettes[2] : palettes[gx + gy < 3 ? 1 : 0];
          parts.push(cube(x, y, s, p[0], p[1], p[2]));
          if (r() > 0.72) parts.push(cube(x, y - s * 1.15, s, ...palettes[Math.floor(r() * 4)]));
        }
      break;
    }
    case 'neon': {
      defs.push(sky('sk', '#140a2e', '#3b1661', '#ff6fa8'));
      defs.push('<linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe38a"/><stop offset="1" stop-color="#ff5fa2"/></linearGradient>');
      parts.push(`<rect width="${W}" height="${H}" fill="url(#sk)"/><circle cx="320" cy="200" r="90" fill="url(#sun)"/>`);
      for (let i = 0; i < 5; i++) parts.push(`<rect x="220" y="${215 + i * 13}" width="200" height="${3 + i}" fill="#3b1661"/>`);
      parts.push(`<rect y="240" width="${W}" height="160" fill="#1a0b33"/>`);
      for (let i = -10; i <= 10; i++) parts.push(`<line x1="320" y1="240" x2="${320 + i * 90}" y2="400" stroke="#ff6fd0" stroke-width="1.4" opacity=".7"/>`);
      for (let i = 0; i < 7; i++) {
        const y = 240 + Math.pow(i / 7, 2) * 160;
        parts.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#ff6fd0" stroke-width="1.2" opacity="${0.3 + i * 0.08}"/>`);
      }
      for (let i = 0; i < 5; i++) parts.push(`<path d="M${150 + i * 85 + r() * 20} ${300 + r() * 40} l9 -16 l9 16 l-9 16Z" fill="#7ff3ff" filter="url(#s)"/><path d="M${150 + i * 85} ${300} l6 -10 l6 10 l-6 10Z" fill="#dffcff" opacity=".8"/>`);
      break;
    }
    case 'paint': {
      parts.push(`<rect width="${W}" height="${H}" fill="#0f0e1c"/>`);
      const cols = ['#8b7bff', '#5ec8ff', '#ffb38a', '#ff8fc8', '#7ee0b8'];
      for (let i = 0; i < 7; i++) {
        const c = cols[i % cols.length];
        const y0 = 60 + r() * 280;
        const d = `M${-20} ${y0} C${150 + r() * 100} ${r() * H} ${380 + r() * 100} ${r() * H} ${660} ${60 + r() * 280}`;
        parts.push(`<path d="${d}" stroke="${c}" stroke-width="${14 + r() * 10}" fill="none" stroke-linecap="round" filter="url(#b)" opacity=".8"/><path d="${d}" stroke="${c}" stroke-width="3" fill="none" stroke-linecap="round" opacity=".95"/>`);
      }
      for (let i = 0; i < 40; i++) parts.push(`<circle cx="${r() * W}" cy="${r() * H}" r="${r() * 1.6}" fill="#fff" opacity="${r() * 0.7}"/>`);
      break;
    }
    case 'room': {
      parts.push(`<rect width="${W}" height="${H}" fill="#f6e3d3"/>`);
      parts.push(`<path d="M320 40 L560 150 L560 330 L320 220Z" fill="#f2c9b0"/><path d="M320 40 L80 150 L80 330 L320 220Z" fill="#f8d9c4"/><path d="M80 330 L320 220 L560 330 L320 440Z" fill="#d9a882"/>`);
      parts.push(`<path d="M390 110 L490 156 L490 236 L390 190Z" fill="#a9dcff"/><path d="M390 110 L490 156 L490 236 L390 190Z" fill="none" stroke="#fff3e8" stroke-width="5"/><circle cx="455" cy="160" r="12" fill="#fff6d0" opacity=".9"/>`);
      parts.push(`<path d="M150 270 l90 -42 l70 32 l-90 42Z" fill="#8b7bff"/><path d="M150 270 v26 l70 32 v-26Z" fill="#6f61d6"/><path d="M220 302 v26 l90 -42 v-26Z" fill="#5b4fc0"/>`);
      parts.push(`<rect x="458" y="250" width="34" height="36" rx="6" fill="#ffffff"/><g fill="#6cbf8a"><ellipse cx="475" cy="236" rx="10" ry="26"/><ellipse cx="462" cy="244" rx="8" ry="20" transform="rotate(-25 462 244)"/><ellipse cx="489" cy="244" rx="8" ry="20" transform="rotate(25 489 244)"/></g>`);
      parts.push(`<ellipse cx="320" cy="330" rx="90" ry="34" fill="#ffb3c7" opacity=".75"/>`);
      break;
    }
    case 'clouds': {
      defs.push(sky('sk', '#ffc6e0', '#ffe3ef', '#fff4e8'));
      parts.push(`<rect width="${W}" height="${H}" fill="url(#sk)"/>`);
      for (let i = 0; i < 6; i++) parts.push(`<ellipse cx="${r() * W}" cy="${80 + r() * 260}" rx="${80 + r() * 90}" ry="${24 + r() * 20}" fill="#fff" opacity=".85" filter="url(#s)"/>`);
      parts.push(`<ellipse cx="320" cy="300" rx="200" ry="44" fill="#fff"/><ellipse cx="250" cy="285" rx="80" ry="40" fill="#fff"/><ellipse cx="400" cy="282" rx="90" ry="44" fill="#fff"/>`);
      parts.push(`<rect x="270" y="170" width="100" height="110" fill="#f4b6d2"/><rect x="250" y="140" width="34" height="140" fill="#eaa1c3"/><rect x="356" y="140" width="34" height="140" fill="#eaa1c3"/><path d="M250 140 l17 -40 l17 40Z M356 140 l17 -40 l17 40Z" fill="#9b8cff"/><path d="M300 170 l20 -46 l20 46Z" fill="#9b8cff"/><rect x="306" y="230" width="28" height="50" rx="14" fill="#c27aa5"/>`);
      break;
    }
    case 'reef': {
      defs.push(sky('sk', '#38c3d9', '#1d8fb8', '#0f4e7a'));
      parts.push(`<rect width="${W}" height="${H}" fill="url(#sk)"/>`);
      for (let i = 0; i < 6; i++) parts.push(`<path d="M${r() * W} 0 L${r() * W - 60} ${H} L${r() * W + 40} ${H}Z" fill="#bff6ff" opacity=".07"/>`);
      parts.push(`<path d="${hillPath(r, 330, 30)}" fill="#e8cf9a"/>`);
      const cor = ['#ff8fa8', '#ffb38a', '#b49bff', '#ff7fb8'];
      for (let i = 0; i < 9; i++) {
        const x = 30 + i * 70 + r() * 20;
        const c = cor[i % cor.length];
        parts.push(`<path d="M${x} 340 q-10 -40 -24 -60 M${x} 340 q2 -50 0 -80 M${x} 340 q12 -36 26 -54" stroke="${c}" stroke-width="9" fill="none" stroke-linecap="round"/>`);
      }
      for (let i = 0; i < 6; i++) {
        const x = 80 + r() * 480;
        const y = 90 + r() * 160;
        parts.push(`<g transform="translate(${x} ${y})"><ellipse rx="18" ry="9" fill="#ffd36e"/><path d="M16 0 l12 -9 v18Z" fill="#ffb84a"/><circle cx="-9" cy="-2" r="2" fill="#2b2b40"/></g>`);
      }
      for (let i = 0; i < 20; i++) parts.push(`<circle cx="${r() * W}" cy="${r() * 300}" r="${2 + r() * 4}" fill="none" stroke="#dff9ff" opacity=".5"/>`);
      break;
    }
    case 'snow': {
      defs.push(sky('sk', '#9fb7e8', '#cfdcf5', '#eef3fb'));
      parts.push(`<rect width="${W}" height="${H}" fill="url(#sk)"/>`);
      parts.push(`<path d="${hillPath(r, 250, 70, 4)}" fill="#e3ebf7"/><path d="${hillPath(r, 300, 40)}" fill="#f7faff"/>`);
      for (let i = 0; i < 5; i++) {
        const x = 90 + i * 110 + r() * 30;
        const y = 280 + r() * 30;
        parts.push(`<path d="M${x} ${y} l-22 0 l22 -30 l22 30Z M${x} ${y - 22} l-18 0 l18 -26 l18 26Z" fill="#5b8f86"/><rect x="${x - 3}" y="${y}" width="6" height="10" fill="#7a5a44"/>`);
      }
      parts.push(`<rect x="290" y="250" width="70" height="50" fill="#ffd9b8"/><path d="M280 252 l45 -36 l45 36Z" fill="#c9667a"/><rect x="316" y="272" width="16" height="28" fill="#8a5a4a"/><rect x="298" y="262" width="12" height="12" fill="#ffe9a8"/>`);
      for (let i = 0; i < 80; i++) parts.push(`<circle cx="${r() * W}" cy="${r() * H}" r="${r() * 2 + 0.6}" fill="#fff" opacity=".9"/>`);
      break;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice"><defs>${defs.join('')}</defs>${parts.join('')}</svg>`;
}

export function sceneDataUrl(scene: Scene, seed: number): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sceneSvg(scene, seed))}`;
}

// ---------------------------------------------------------------------------------------------
// Worlds

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

type Seed = [name: string, author: string, scene: Scene | null, tags: string[], plays: number, likes: number, opts?: Partial<WorldCard>];

const SEEDS: Seed[] = [
  ['Lighthouse Cove', 'Mira', 'room', ['world'], 48210, 3120, { kind: 'external', verified: true, featured: 100, externalUrl: 'https://lighthouse.example.com', sourceUrl: 'https://github.com/example/lighthouse', forkable: false, description: 'A seaside cove with a lighthouse to climb' }],
  ['Cloud Castle', 'Mira', 'clouds', ['world'], 23400, 1890, { verified: true, featured: 90, description: 'A pink castle floating on a cloud' }],
  ['Firefly Forest', 'Sora', 'night', ['world'], 18700, 1404, { verified: true, featured: 80, description: 'Wander a moonlit forest full of fireflies' }],
  ['Neon Runner', 'Theo', 'neon', ['game'], 31250, 2210, { verified: true, featured: 70, description: 'Dash down a synthwave highway, grab the crystals' }],
  ['Glow Paint', 'Orb', 'paint', ['art'], 12040, 960, { verified: true, featured: 60, description: 'Paint with light in 3D space' }],
  ['Sunny Island', 'Orb', 'island', ['world'], 9800, 740, { verified: true, featured: 50, description: 'Explore a sunny island on foot' }],
  ['Blocky Builders', 'Leo K.', 'blocks', ['toy'], 15320, 1022],
  ['Coral Reef Drift', 'Noor', 'reef', ['world'], 8900, 610],
  ['Snow Globe Village', 'Ava & Dad', 'snow', ['world', 'toy'], 7420, 688],
  ['Lavender Hills', 'Ines', 'hills', ['world'], 6130, 402],
  ['Star Catcher', 'Kai', 'neon', ['game'], 5980, 455],
  ['Bubble Pop!', 'Jun', 'reef', ['game'], 5210, 390],
  ['Dream Room', 'Misty Otter', 'room', ['toy'], 4380, 311],
  ['Moonlit Meadow', 'Brave Lynx', 'night', ['art'], 3970, 288],
  ['Marble Run', 'Theo', 'blocks', ['toy', 'game'], 3650, 250],
  ['Candy Clouds', 'Mira', 'clouds', ['art'], 3120, 270],
  ['Pebble Beach', 'Sora', 'island', ['world'], 2870, 199],
  ['Ribbon Dance', 'Noor', 'paint', ['art'], 2440, 230],
  ['Cozy Cabin', 'Ines', 'snow', ['world'], 2210, 160],
  ['Dusk Valley', 'Leo K.', 'hills', ['world'], 1980, 133],
  ['Pixel Garden', 'Kai', 'blocks', ['art', 'toy'], 1720, 140],
  ['Comet Chase', 'Jun', 'neon', ['game'], 1490, 98],
  ['Little Lighthouse', 'Ava & Dad', 'island', ['world'], 1210, 87],
  ['Koi Pond', 'Sora', 'reef', ['art'], 980, 77],
  ['Sleepy Fox Den', 'Misty Otter', 'night', ['world'], 760, 54],
  ['Treehouse Hideout', 'Brave Lynx', 'hills', ['world'], 540, 41],
  ['Rainbow Road', 'Theo', 'paint', ['game'], 410, 33],
  ['Origami Zoo', 'Ines', 'room', ['toy'], 290, 21],
  ['Aurora Lake', 'Noor', 'snow', ['art'], 180, 15],
  ['Tiny Planet', 'Kai', null, ['world'], 96, 8, { description: 'A planet small enough to walk around in a minute' }],
  ['Dino Dash', 'Leo K.', 'hills', ['game'], 64, 5],
  ['Paper Boats', 'Mira', 'reef', ['toy'], 12, 1],
];

function makeCard(s: Seed, i: number): WorldCard {
  const [name, authorName, scene, tags, plays, likes, opts] = s;
  const id = `w${(i + 1).toString(36).padStart(3, '0')}${name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 6)}`;
  const created = new Date(NOW - (i * 1.7 + 0.2) * DAY).toISOString();
  return {
    id,
    name,
    description: opts?.description ?? '',
    kind: 'native',
    authorName,
    verified: false,
    featured: 0,
    tags,
    thumbUrl: scene ? sceneDataUrl(scene, i * 7919 + 13) : null,
    plays,
    likes,
    forks: Math.floor(likes / 9),
    forkable: true,
    visibility: 'public',
    externalUrl: null,
    sourceUrl: null,
    forkedFrom: null,
    createdAt: created,
    updatedAt: created,
    ...opts,
  };
}

const WORLDS: WorldCard[] = SEEDS.map(makeCard);

const MINE_SEEDS: Seed[] = [
  ['Pink Castle', 'Misty Otter', 'clouds', ['world'], 42, 6, { visibility: 'public' }],
  ['Secret Garden', 'Misty Otter', 'hills', ['world'], 0, 0, { visibility: 'private' }],
  ['My First Game', 'Misty Otter', 'neon', ['game'], 7, 1, { visibility: 'public' }],
  ['Untitled world', 'Misty Otter', null, [], 0, 0, { visibility: 'private' }],
  ['Rainy Window', 'Misty Otter', 'room', ['art'], 3, 0, { visibility: 'public' }],
];
const MY_WORLDS: WorldCard[] = MINE_SEEDS.map((s, i) => ({ ...makeCard(s, 100 + i), updatedAt: new Date(NOW - [0.08, 0.9, 3, 6, 21][i] * DAY).toISOString() }));

const VERSIONS: WorldVersionInfo[] = [
  [12, 'Make the castle pink and add a moat with tiny glowing fish swimming around it', 0.02],
  [11, 'Add fireflies at night', 0.2],
  [10, null, 0.21],
  [9, 'Make the clouds puffier and slower, and let me jump higher when I press space so I can reach the tower windows', 1.1],
  [8, 'Add a rainbow bridge', 1.3],
  [7, 'Make it sunset', 2.5],
  [6, 'Add a dragon that sleeps on the tallest tower', 3],
  [5, 'Add music', 4],
  [4, 'Put flowers everywhere', 6],
  [3, 'Make the castle bigger', 9],
  [2, 'A pink castle on a cloud', 9.01],
  [1, null, 9.02],
].map(([version, prompt, daysAgo]) => ({ version: version as number, prompt: prompt as string | null, createdAt: new Date(Date.now() - (daysAgo as number) * DAY).toISOString() }));

export function sampleWorld(): WorldFull {
  return {
    ...MY_WORLDS[0],
    code: '<!doctype html><title>Cloud Castle</title>',
    template: null,
    version: 12,
    tree: null,
    thumbVersion: 3,
    canEdit: true,
    liked: false,
    remixes: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Mock /api

interface MockOptions {
  latency: number;
  signedIn: boolean;
  oauth: boolean;
  /** Return no worlds / versions. */
  empty: boolean;
  /** Make list/versions/me requests fail. */
  error: boolean;
}

export function createMockApi(opts: MockOptions) {
  const state = {
    signedIn: opts.signedIn,
    name: 'Misty Otter',
    userName: 'Mira',
  };

  const me = (): MeResponse => ({
    user: state.signedIn ? { id: 'u_mira', name: state.userName } : null,
    deviceId: '3fa2c1d9e0b7',
    name: state.name,
  });

  const config: ApiConfig = { ai: true, model: 'anthropic/claude-sonnet-5.5', githubOAuth: opts.oauth, realtime: null, passkeys: true };

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fail = () => json({ error: 'unavailable', message: 'Mock failure' }, 503);

  function list(sp: URLSearchParams) {
    if (opts.empty) return { worlds: [] as WorldCard[] };
    let items = sp.get('mine') ? [...MY_WORLDS] : [...WORLDS];
    const q = sp.get('q')?.toLowerCase();
    if (q) items = items.filter((w) => `${w.name} ${w.description} ${w.authorName} ${w.tags.join(' ')}`.toLowerCase().includes(q));
    const tag = sp.get('tag');
    if (tag) items = items.filter((w) => w.tags.includes(tag) || w.kind === tag);
    if (sp.get('verified')) items = items.filter((w) => w.verified);
    const sort = sp.get('sort');
    if (sort === 'new') items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    else if (sort === 'featured') items.sort((a, b) => b.featured - a.featured || b.plays - a.plays);
    else if (sort === 'popular') items.sort((a, b) => b.plays - a.plays);
    const limit = Math.max(1, Math.min(60, Number(sp.get('limit')) || 24));
    const start = Number(sp.get('cursor') || 0);
    const page = items.slice(start, start + limit);
    return { worlds: page, ...(start + limit < items.length ? { nextCursor: String(start + limit) } : {}) };
  }

  return async function handle(url: URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method || 'GET').toUpperCase();
    await new Promise((r) => setTimeout(r, opts.latency * (0.6 + Math.random() * 0.8)));
    const p = url.pathname;
    if (p === '/api/config') return json(config);
    if (p === '/api/me' && method === 'GET') return opts.error ? fail() : json(me());
    if (p === '/api/me' && method === 'PATCH') {
      const body = JSON.parse(String(init?.body || '{}')) as { name?: string };
      if (body.name) {
        if (state.signedIn) state.userName = body.name;
        else state.name = body.name;
      }
      return json(me());
    }
    if (p === '/api/auth/logout') {
      state.signedIn = false;
      return json({ ok: true });
    }
    if (p === '/api/worlds' && method === 'GET') return opts.error ? fail() : json(list(url.searchParams));
    const versions = p.match(/^\/api\/worlds\/([^/]+)\/versions$/);
    if (versions) return opts.error ? fail() : json({ versions: opts.empty ? [] : VERSIONS });
    return json({ error: 'not_found', message: `No mock for ${method} ${p}` }, 404);
  };
}
