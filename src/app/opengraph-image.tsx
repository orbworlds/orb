// Open Graph image for the home page (1200×630): the Orb brand card — a glossy iridescent orb on
// a luminous pastel field, "Orb" in Instrument Serif.
// Static (rendered at build time). Fonts come from Google Fonts when reachable; otherwise the card
// renders with next/og's built-in sans so the build never depends on the network.

import { ImageResponse } from 'next/og';
import { blob, GLOSS, INK, loadFonts } from './og';

export const alt = 'Orb';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image() {
  const fonts = await loadFonts(4000);
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
              backgroundImage: GLOSS,
              boxShadow: '0 44px 100px rgba(139,123,255,0.38), 0 12px 34px rgba(255,143,200,0.28)',
            }}
          />
          <div style={{ fontFamily: 'Instrument Serif', fontSize: 168, lineHeight: 0.92, letterSpacing: -3, color: INK }}>Orb</div>
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
