// Open Graph image for the home page (1200×630): the Orb brand card — a glossy iridescent orb on
// a luminous pastel field, "Orb" in Instrument Serif.
// Static (rendered at build time). Fonts come from Google Fonts when reachable; otherwise the card
// renders with next/og's built-in sans so the build never depends on the network.

import { ImageResponse } from 'next/og';

export const alt = 'Orb';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const INK = '#0c0c14';
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@500&display=swap';

type OgFont = { name: string; data: ArrayBuffer; weight: 400 | 500; style: 'normal' | 'italic' };

/** Instrument Serif (regular + italic) and Geist 500 as TTF, or undefined if unreachable. */
async function loadFonts(): Promise<OgFont[] | undefined> {
  try {
    const signal = AbortSignal.timeout(4000);
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
    return ok.some((f) => f.name === 'Instrument Serif') ? ok : undefined;
  } catch (e) {
    console.warn('[orb] OG fonts unavailable, using the built-in font:', (e as Error).message);
    return undefined;
  }
}

function blob(color: string, left: number, top: number, d: number) {
  return (
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
}

export default async function Image() {
  const fonts = await loadFonts();
  return new ImageResponse(
    (
      <div
        style={{
          position: 'relative',
          width: 1200,
          height: 630,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#f6f5fb',
          fontFamily: 'Geist',
        }}
      >
        {blob('rgba(139,123,255,0.55)', -240, -340, 920)}
        {blob('rgba(94,200,255,0.50)', 560, -400, 980)}
        {blob('rgba(255,179,138,0.50)', -220, 160, 880)}
        {blob('rgba(255,143,200,0.48)', 620, 150, 920)}

        <div style={{ display: 'flex', alignItems: 'center', gap: 72 }}>
          {/* The orb: layered gradients for a soft glassy sphere. */}
          <div
            style={{
              width: 280,
              height: 280,
              borderRadius: 999,
              display: 'flex',
              backgroundImage:
                'radial-gradient(circle at 32% 28%, #ffffff 0%, #fbf8ff 14%, #cbbcff 38%, #93d6ff 62%, #ffc3a8 82%, #ff9fd2 100%)',
              boxShadow: '0 44px 100px rgba(139,123,255,0.38), 0 12px 34px rgba(255,143,200,0.28)',
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontFamily: 'Instrument Serif', fontSize: 168, lineHeight: 0.92, letterSpacing: -3, color: INK }}>Orb</div>
          </div>
        </div>

        <div
          style={{
            position: 'absolute',
            bottom: 48,
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
            fontSize: 24,
            fontWeight: 500,
            letterSpacing: 0.2,
            color: 'rgba(12,12,20,0.5)',
          }}
        >
          Say what you imagine — watch it come alive
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
