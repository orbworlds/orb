// What Orb's link-preview images share (./opengraph-image.tsx, ./w/[id]/opengraph-image.tsx): the
// fonts, ink, and the soft pastel light and glossy orb of the card without a picture.

export const INK = '#0c0c14';
export const GLOSS = 'radial-gradient(circle at 32% 28%, #ffffff 0%, #fbf8ff 14%, #cbbcff 38%, #93d6ff 62%, #ffc3a8 82%, #ff9fd2 100%)';

type OgFont = { name: string; data: ArrayBuffer; weight: 400 | 500; style: 'normal' | 'italic' };

const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500&display=swap';
const FONT_RETRY_MS = 5 * 60_000;
let fontsPromise: Promise<OgFont[]> | null = null;
let fontsFailedAt = 0;

/** Fetch Instrument Serif + Geist as TTF (Google serves TTF to clients without a modern UA). */
async function fetchFonts(timeoutMs: number): Promise<OgFont[]> {
  const signal = AbortSignal.timeout(timeoutMs);
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

/** Fonts for ImageResponse (cached; tried again after a few minutes), or undefined for next/og's built-in sans. */
export async function loadFonts(timeoutMs = 2500): Promise<OgFont[] | undefined> {
  if (!fontsPromise) {
    if (Date.now() - fontsFailedAt < FONT_RETRY_MS) return undefined;
    fontsPromise = fetchFonts(timeoutMs).catch((e) => {
      console.warn('[orb] OG fonts unavailable, using the built-in font:', (e as Error).message);
      fontsFailedAt = Date.now();
      fontsPromise = null;
      return [];
    });
  }
  const fonts = await fontsPromise;
  return fonts.length ? fonts : undefined;
}

/**
 * A soft round light of `color`, `d` px across, in a box at (left, top). It is drawn over the whole card:
 * next/og cuts a box that reaches past the card down to the card's height, and its light with it.
 */
export function blob(color: string, left: number, top: number, d: number) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: 1200,
        height: 630,
        backgroundImage: `radial-gradient(circle ${Math.round(d / Math.SQRT2)}px at ${left + d / 2}px ${top + d / 2}px, ${color} 0%, rgba(255,255,255,0) 68%)`,
      }}
    />
  );
}
