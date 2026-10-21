// The Orb kit's browser helpers, for tests of worlds (the kit's `orb test`, a game's own suite, Orb's
// scripts): Chrome with software WebGL, and three.js from node_modules instead of a CDN (for machines
// that can't reach one). Playwright and three.js come from the project that uses the kit. Usage:
//   import { launch, routeCdn } from '@orbworlds/kit/browser'
//   const browser = await launch(); const page = await browser.newPage(); await routeCdn(page)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const requireHere = createRequire(path.join(process.cwd(), 'package.json'));
const { chromium } = requireHere('playwright');
// three.js wherever Node finds it from the project using the kit (only routeCdn needs it).
const three = () => { try { return path.resolve(path.dirname(requireHere.resolve('three')), '..'); } catch { return null; } };
// A Chrome on the machine (GitHub's runners have one), else Playwright's own (`npx playwright install chromium`).
export const CHROMIUM = [process.env.ORB_CHROMIUM, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) => p && fs.existsSync(p));

export function launch(opts = {}) {
  return chromium.launch({
    ...(CHROMIUM ? { executablePath: CHROMIUM } : {}),
    // IsolateSandboxedIframes moves sandboxed iframes into another process, where Playwright's
    // request routing (routeCdn) misses some of their requests — keep them in-process for tests.
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-features=IsolateSandboxedIframes'],
    ...opts,
  });
}

const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };

// Map https://cdn.jsdelivr.net/npm/three@<ver>/<path> (and unpkg/esm.sh equivalents) to node_modules/three/<path>.
export async function routeCdn(target) {
  const handler = async (route) => {
    const url = new URL(route.request().url());
    const m = url.pathname.match(/^\/(?:npm\/)?three@[^/]+\/(.*)$/);
    if (!m) return route.abort();
    const dir = three();
    if (!dir) return route.continue(); // no three.js installed here: the CDN it is
    const file = path.join(dir, m[1]);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'access-control-allow-origin': '*' } });
  };
  await target.route(/^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|esm\.sh)\//, handler);
}
