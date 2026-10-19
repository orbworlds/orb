// Open Graph image for a world (1200×630). With a thumbnail: the world full-bleed, a soft dark
// gradient at the bottom, the name in Instrument Serif, "by Author" and a small Orb wordmark.
// Without one (or for private/missing worlds): a luminous iridescent pastel card.
//
// Kept fast and failure-proof: fonts come from Google Fonts only if reachable (cached per process,
// short timeout, else the built-in sans), and any image problem falls back to the gradient card.
// next/og cannot decode WebP, so WebP thumbnails are converted with `sharp` when it is available
// (next/og itself loads it optionally the same way); without sharp we use the gradient card.

import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { headers } from 'next/headers';
import { getPublicThumb, getPublicWorld, sniffImage } from '@/server/worlds';

export const alt = 'A world made with Orb';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const INK = '#0c0c14';
const IRIDESCENT = 'linear-gradient(135deg, #8b7bff 0%, #5ec8ff 36%, #ffb38a 70%, #ff8fc8 100%)';
const FETCH_TIMEOUT_MS = 2500;

// --- fonts -------------------------------------------------------------------------------------

type OgFont = { name: string; data: ArrayBuffer; weight: 400 | 500; style: 'normal' | 'italic' };

const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500&display=swap';
const FONT_RETRY_MS = 5 * 60_000;
let fontsPromise: Promise<OgFont[]> | null = null;
let fontsFailedAt = 0;

/** Fetch Instrument Serif + Geist as TTF (Google serves TTF to clients without a modern UA). */
async function fetchFonts(): Promise<OgFont[]> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const css = await (await fetch(FONT_CSS, { signal })).text();
  const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
  const fonts = await Promise.all(
    faces.map(async (face): Promise<OgFont | null> => {
      const family = /font-family:\s*'([^']+)'/.exec(face)?.[1];
      const url = /src:\s*url\(([^)]+)\)\s*format\('(?:truetype|opentype)'\)/.exec(face)?.[1];
      if (!family || !url) return null;
      const res = await fetch(url, { signal });
      if (!res.ok) return null;
      return {
        name: family,
        data: await res.arrayBuffer(),
        weight: /font-weight:\s*500/.test(face) ? 500 : 400,
        style: /font-style:\s*italic/.test(face) ? 'italic' : 'normal',
      };
    }),
  );
  const ok = fonts.filter((f): f is OgFont => !!f);
  if (!ok.some((f) => f.name === 'Instrument Serif')) throw new Error('serif font missing');
  return ok;
}

/** Fonts for ImageResponse, or undefined to use next/og's built-in sans (Geist). */
async function loadFonts(): Promise<OgFont[] | undefined> {
  if (!fontsPromise) {
    if (Date.now() - fontsFailedAt < FONT_RETRY_MS) return undefined;
    fontsPromise = fetchFonts().catch((e) => {
      console.warn('[orb] OG fonts unavailable, using the built-in font:', (e as Error).message);
      fontsFailedAt = Date.now();
      fontsPromise = null;
      return [];
    });
  }
  const fonts = await fontsPromise;
  return fonts.length ? fonts : undefined;
}

// --- thumbnail -----------------------------------------------------------------------------------

type SharpFactory = (input: Uint8Array) => {
  resize(w: number, h: number, o: { fit: 'cover' }): { jpeg(o: { quality: number }): { toBuffer(): Promise<Buffer> } };
};
let sharpPromise: Promise<SharpFactory | null> | null = null;

/** `sharp` ships with Next as an optional dependency; it may be absent on some platforms. */
function loadSharp(): Promise<SharpFactory | null> {
  sharpPromise ??= import('sharp').then((m) => (m.default ?? m) as unknown as SharpFactory).catch(() => null);
  return sharpPromise;
}

/** A data URI next/og can draw (PNG/JPEG), or null. */
async function toDrawable(bytes: Uint8Array): Promise<string | null> {
  const type = sniffImage(bytes);
  if (!type) return null;
  if (type === 'image/webp') {
    const sharp = await loadSharp();
    if (!sharp) return null;
    const jpeg = await sharp(bytes).resize(size.width, size.height, { fit: 'cover' }).jpeg({ quality: 84 }).toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  }
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** Read a curated thumbnail: from /public when it's a local path, else over HTTP(S). */
async function readImageUrl(url: string): Promise<Uint8Array | null> {
  if (url.startsWith('/')) {
    const pub = path.join(process.cwd(), 'public');
    const file = path.join(pub, decodeURIComponent(url.split('?')[0]));
    if (file.startsWith(pub + path.sep)) {
      try {
        return new Uint8Array(await readFile(file));
      } catch {}
    }
    // Not on disk (e.g. serverless bundles don't include /public): fetch it from our own origin.
    const h = await headers();
    const host = h.get('x-forwarded-host') ?? h.get('host');
    if (!host) return null;
    url = `${h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')}://${host}${url}`;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.byteLength <= 5_000_000 ? buf : null;
}

async function thumbnailFor(id: string): Promise<string | null> {
  try {
    const thumb = await getPublicThumb(id);
    if (!thumb) return null;
    const bytes = thumb.kind === 'image' ? thumb.bytes : await readImageUrl(thumb.url);
    return bytes ? await toDrawable(bytes) : null;
  } catch (e) {
    console.warn('[orb] OG thumbnail unavailable for', id, (e as Error).message);
    return null;
  }
}

// --- drawing ---------------------------------------------------------------------------------------

function nameSize(name: string): number {
  const n = Array.from(name).length;
  return n <= 16 ? 104 : n <= 26 ? 88 : n <= 40 ? 72 : 60;
}

function Wordmark({ light }: { light: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: 999,
          backgroundImage: `radial-gradient(circle at 34% 30%, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0) 46%), ${IRIDESCENT}`,
          boxShadow: light ? '0 0 24px rgba(160,150,255,0.55)' : '0 6px 18px rgba(139,123,255,0.35)',
        }}
      />
      <div style={{ fontFamily: 'Geist', fontWeight: 500, fontSize: 30, letterSpacing: -0.5, color: light ? '#ffffff' : INK }}>Orb</div>
    </div>
  );
}

/** Soft pastel blobs + a glossy orb: the "no thumbnail" backdrop. */
function PastelBackdrop() {
  const blob = (color: string, left: number, top: number, d: number) => (
    <div
      style={{
        position: 'absolute',
        left,
        top,
        width: d,
        height: d,
        borderRadius: 999,
        backgroundImage: `radial-gradient(circle at center, ${color} 0%, rgba(255,255,255,0) 68%)`,
      }}
    />
  );
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: 1200, height: 630, display: 'flex', backgroundColor: '#f6f5fb' }}>
      {blob('rgba(139,123,255,0.55)', -260, -320, 900)}
      {blob('rgba(94,200,255,0.50)', 520, -380, 980)}
      {blob('rgba(255,179,138,0.50)', -200, 180, 860)}
      {blob('rgba(255,143,200,0.48)', 640, 160, 900)}
      <div
        style={{
          position: 'absolute',
          right: 120,
          top: 120,
          width: 250,
          height: 250,
          borderRadius: 999,
          backgroundImage:
            'radial-gradient(circle at 32% 28%, #ffffff 0%, #fbf8ff 14%, #cbbcff 38%, #93d6ff 62%, #ffc3a8 82%, #ff9fd2 100%)',
          boxShadow: '0 40px 90px rgba(139,123,255,0.35), 0 10px 30px rgba(255,143,200,0.25)',
        }}
      />
    </div>
  );
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [world, fonts] = await Promise.all([getPublicWorld(id).catch(() => null), loadFonts()]);
  const thumb = world && world.thumbUrl ? await thumbnailFor(id) : null;

  const name = world?.name || 'A world on Orb';
  const author = world?.authorName;
  const onPhoto = !!thumb;
  const ink = onPhoto ? '#ffffff' : INK;
  const sub = onPhoto ? 'rgba(255,255,255,0.82)' : 'rgba(12,12,20,0.6)';

  return new ImageResponse(
    (
      <div style={{ position: 'relative', width: 1200, height: 630, display: 'flex', backgroundColor: '#0d0d14', fontFamily: 'Geist' }}>
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element -- next/og renders plain <img>
          <img src={thumb} alt="" width={1200} height={630} style={{ position: 'absolute', left: 0, top: 0, width: 1200, height: 630, objectFit: 'cover' }} />
        ) : (
          <PastelBackdrop />
        )}
        {thumb ? (
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: 1200,
              height: 630,
              backgroundImage:
                'linear-gradient(180deg, rgba(8,8,14,0.28) 0%, rgba(8,8,14,0) 22%, rgba(8,8,14,0) 42%, rgba(8,8,14,0.5) 70%, rgba(8,8,14,0.86) 100%)',
            }}
          />
        ) : null}

        <div style={{ position: 'absolute', left: 64, top: 56, display: 'flex' }}>
          <Wordmark light={onPhoto} />
        </div>

        <div style={{ position: 'absolute', left: 64, right: 64, bottom: 58, display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              fontFamily: 'Instrument Serif',
              fontSize: nameSize(name),
              lineHeight: 1.02,
              letterSpacing: -1,
              color: ink,
              maxWidth: onPhoto ? 1072 : 760,
              textShadow: onPhoto ? '0 2px 24px rgba(0,0,0,0.35)' : 'none',
            }}
          >
            {name}
          </div>
          {author ? (
            <div style={{ marginTop: 18, fontSize: 30, color: sub, display: 'flex' }}>
              <span style={{ fontFamily: 'Instrument Serif', fontStyle: 'italic', fontSize: 34, marginRight: 10 }}>by</span>
              <span>{author}</span>
            </div>
          ) : null}
        </div>
      </div>
    ),
    {
      ...size,
      fonts,
      // Worlds change (renames, new thumbnails): cache for a while, not forever.
      headers: { 'cache-control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400' },
    },
  );
}
