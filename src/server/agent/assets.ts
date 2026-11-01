// Files from the web for a world (the agent's add_asset tool, ./workspace.ts): a 3D model, a
// texture, a sky, a sound or a font, copied into the world's files, so the world itself only ever
// loads its own files (and the CDN): links to other sites break, and every visitor's browser would
// tell those sites it came. Only https to public addresses (checked as each connection is made, so
// a name can't point somewhere private in between), at most FILE_LIMITS.file, and only files that
// are what their name says.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import https from 'node:https';
import { isIP } from 'node:net';
import { FILE_LIMITS } from '../files';

const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 4;

/** Whether an address is one only a private network (or this machine) reaches. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateAddress(mapped[1]);
  return v === '::' || v === '::1' || /^(fc|fd|fe[89ab]|ff)/.test(v) || v.startsWith('64:ff9b:') || v.startsWith('2001:db8');
}

/** DNS for the download: refuses a name with any private address, as the connection is made. */
function publicLookup(hostname: string, options: unknown, callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void): void {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) return callback(Object.assign(new Error('not a public address'), { code: 'EPRIVATE' }), '', 4);
    if ((options as { all?: boolean } | null)?.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

/** The extensions a world can take from the web, and how each file starts. */
const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  glb: (b) => text(b, 0, 4) === 'glTF',
  gltf: (b) => /^\s*\{/.test(text(b, 0, 64)),
  bin: () => true,
  png: (b) => b[0] === 0x89 && text(b, 1, 3) === 'PNG',
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8,
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8,
  webp: (b) => text(b, 0, 4) === 'RIFF' && text(b, 8, 4) === 'WEBP',
  gif: (b) => text(b, 0, 4) === 'GIF8',
  ktx2: (b) => b[0] === 0xab && text(b, 1, 6) === 'KTX 20',
  hdr: (b) => /^#\?(RADIANCE|RGBE)/.test(text(b, 0, 10)),
  mp3: (b) => text(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  ogg: (b) => text(b, 0, 4) === 'OggS',
  wav: (b) => text(b, 0, 4) === 'RIFF' && text(b, 8, 4) === 'WAVE',
  m4a: (b) => text(b, 4, 4) === 'ftyp',
  woff2: (b) => text(b, 0, 4) === 'wOF2',
  woff: (b) => text(b, 0, 4) === 'wOFF',
  ttf: (b) => (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) || text(b, 0, 4) === 'true',
  otf: (b) => text(b, 0, 4) === 'OTTO',
};
export const ASSET_EXTENSIONS = Object.keys(SIGNATURES);

function text(b: Uint8Array, at: number, n: number): string {
  return String.fromCharCode(...b.subarray(at, at + n));
}

const extOf = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';

/** Why a file from the web can't go in the world at `path` (its kind), or null when it can. */
export function pathProblem(path: string): string | null {
  return SIGNATURES[extOf(path)] ? null : `A file from the web can be ${ASSET_EXTENSIONS.map((e) => `.${e}`).join(' ')}; give the path one of those.`;
}

/** Why `bytes` can't go in the world as `path`, or null when they can. */
export function assetProblem(path: string, bytes: Uint8Array): string | null {
  const bad = pathProblem(path);
  if (bad) return bad;
  const ext = extOf(path);
  const sig = SIGNATURES[ext];
  if (!bytes.length) return 'That link gave an empty file.';
  if (/^\s*</.test(text(bytes, 0, 64)) && ext !== 'gltf') return 'That link is a web page, not the file itself: find the direct link to the file.';
  if (!sig(bytes)) return `That file isn't a .${ext}: find the direct link to the file itself.`;
  return null;
}

type Got = { status: number; location?: string; type: string; bytes: Uint8Array };

function get(url: URL, signal?: AbortSignal): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', lookup: publicLookup as never, timeout: TIMEOUT_MS, signal, headers: { 'user-agent': 'OrbWorlds/1.0 (+https://orbworlds.com)', accept: '*/*', 'accept-encoding': 'identity' } }, (res) => {
      const status = res.statusCode ?? 0;
      const type = String(res.headers['content-type'] ?? '');
      if (status >= 300 && status < 400) {
        res.resume();
        return resolve({ status, location: res.headers.location, type, bytes: new Uint8Array() });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > FILE_LIMITS.file) req.destroy(Object.assign(new Error('too big'), { code: 'ETOOBIG' }));
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status, type, bytes: new Uint8Array(Buffer.concat(chunks)) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

/** Why a link can't be fetched (or null): https only, by name, on the usual port. */
export function urlProblem(u: URL): string | null {
  if (u.protocol !== 'https:') return 'Only https links can be added.';
  if (u.username || u.password || (u.port && u.port !== '443')) return 'That link can’t be added.';
  if (isIP(u.hostname.replace(/^\[|\]$/g, ''))) return 'Use the link with the site’s name, not an address.';
  return null;
}

/** A file from the web, for a world: its bytes, or why it couldn't be had. */
export async function fetchAsset(raw: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array } | { error: string }> {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return { error: 'That isn’t a link.' };
  }
  for (let hop = 0; ; hop++) {
    const bad = urlProblem(u);
    if (bad) return { error: bad };
    let got: Got;
    try {
      got = await get(u, signal);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ETOOBIG') return { error: `That file is too big (over ${FILE_LIMITS.file / 1e6} MB): find a smaller one.` };
      if (code === 'EPRIVATE') return { error: 'That link doesn’t lead to a public site.' };
      if (code === 'ETIMEDOUT') return { error: 'That site took too long to answer.' };
      return { error: `Couldn’t download it (${code ?? 'network error'}).` };
    }
    if (got.location && hop < MAX_REDIRECTS) {
      try {
        u = new URL(got.location, u);
      } catch {
        return { error: 'That link sent somewhere odd.' };
      }
      continue;
    }
    if (got.status !== 200) return { error: `That link answered ${got.status}${got.status === 404 ? ' (not found)' : ''}.` };
    return { bytes: got.bytes };
  }
}

/** What a model is like, for the agent: its size, the files it needs beside it, its animations. */
export function modelInfo(path: string, bytes: Uint8Array): string {
  let json: Record<string, unknown> | null = null;
  try {
    if (/\.glb$/i.test(path)) {
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const len = v.getUint32(12, true);
      if (v.getUint32(16, true) === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
    } else if (/\.gltf$/i.test(path)) json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return '';
  }
  if (!json) return '';
  const accessors = (json.accessors as Array<{ min?: number[]; max?: number[] }>) ?? [];
  const meshes = (json.meshes as Array<{ primitives?: Array<{ attributes?: { POSITION?: number } }> }>) ?? [];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes)
    for (const p of m.primitives ?? []) {
      const a = accessors[p.attributes?.POSITION ?? -1];
      if (!a?.min || !a.max) continue;
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], a.min[i]);
        hi[i] = Math.max(hi[i], a.max[i]);
      }
    }
  const parts: string[] = [];
  if (Number.isFinite(lo[0])) parts.push(`its meshes span ${[0, 1, 2].map((i) => (hi[i] - lo[i]).toFixed(2)).join(' × ')} (x × y × z, before node scales), y from ${lo[1].toFixed(2)} to ${hi[1].toFixed(2)}`);
  const anims = ((json.animations as Array<{ name?: string }>) ?? []).map((a, i) => a.name || `#${i}`);
  if (anims.length) parts.push(`animations: ${anims.slice(0, 20).join(', ')}`);
  const needs = [...((json.buffers as Array<{ uri?: string }>) ?? []), ...((json.images as Array<{ uri?: string }>) ?? [])].map((x) => x.uri).filter((x): x is string => !!x && !x.startsWith('data:'));
  if (needs.length) parts.push(`it needs these files next to it (add them too): ${needs.slice(0, 20).join(', ')}`);
  return parts.length ? ` A model: ${parts.join('; ')}.` : '';
}
