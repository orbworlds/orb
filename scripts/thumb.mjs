// What the Originals' thumbnail renderers (thumb-*.mjs) share: the game at full quality on a steady
// clock, its title drawn on a page of its own, and the finishing layers.
import fs from 'node:fs';
import sharp from 'sharp';

/**
 * Full quality on any machine (the games give up shadows, MSAA and resolution on 4 cores or slow
 * frames) and a steady 60 fps clock, so the shot comes out the same every time.
 */
export function steady(ctx) {
  return ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    const raf = window.requestAnimationFrame.bind(window);
    let t = 0;
    window.requestAnimationFrame = (cb) => raf(() => cb((t += 1000 / 60)));
  });
}

/** The title as `drawTitle(T)` draws it, on a transparent W × H page (at 2×) in the font the game embeds. */
export async function titleShot(browser, gameFile, drawTitle, T, W, H) {
  const fontFace = fs.readFileSync(gameFile, 'utf8').match(/@font-face\s*\{[^}]*"Pixelify Sans"[^}]*\}/)[0];
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><style>${fontFace} html, body { margin: 0; background: transparent; }</style><body></body>`);
  await page.evaluate(drawTitle, T);
  return page.screenshot({ omitBackground: true });
}

/** A W × H SVG, to composite. */
export const svg = (W, H, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`);

/** A faint grain, the same every time (soft-light over the picture), so a smooth sky doesn't band in WebP. */
export function grain(W, H) {
  const noise = Buffer.alloc(W * H);
  let n = 1234567;
  for (let i = 0; i < noise.length; i++) {
    n = (n * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = 128 + Math.round((n / 0x7fffffff - 0.5) * 10);
  }
  return sharp(noise, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
}
