// `orb test`: a world runs through the kit the way Orb runs it, in a headless Chrome, draws, and
// nothing throws. What a world without a suite of its own is tested with.
import path from 'node:path';
import { serve } from './server.mjs';

/**
 * Serve the world in `dir`, open it the way Orb shows it (1280x800, without the kit's bar) in a
 * headless Chrome, wait `wait` ms and return what `then(page)` does; `watch(page)` sees it first.
 */
export async function play(dir, wait, then, watch = () => {}) {
  const { launch } = await import('./browser.mjs');
  const kit = await serve({ dir, port: 0, watch: false, quiet: true });
  let browser;
  try {
    browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    watch(page);
    await page.goto(kit.url + '?bare', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(wait);
    return await then(page);
  } finally {
    await browser?.close().catch(() => {});
    await kit.close();
  }
}

export async function smoke(dir, { wait = Number(process.env.SMOKE_WAIT || 15000), shot = null } = {}) {
  const errors = [];
  // what a browser without a graphics card says about WebGL isn't the world's fault
  const noise = /WebGL|GPU stall|GL_|swiftshader|software rendering|Automatic fallback|AudioContext|Failed to load resource/i;
  const watch = (page) => {
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !noise.test(m.text())) errors.push(m.text()); });
    page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
  };
  return play(dir, wait, async (page) => {
    const world = page.mainFrame().childFrames()[0]; // the world runs in a srcdoc frame, as on Orb
    const drawn = world
      ? await world.evaluate(() => {
          const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
          if (c && c.width > 100 && c.height > 100) return '';
          return document.body && document.body.innerText.trim().length > 0 ? '' : 'nothing on the page';
        }).catch((e) => String(e))
      : 'the world never loaded';
    if (shot) await page.screenshot({ path: path.resolve(shot), timeout: 90000 }).catch(() => {});
    return [...(drawn ? [drawn] : []), ...errors];
  }, watch);
}
