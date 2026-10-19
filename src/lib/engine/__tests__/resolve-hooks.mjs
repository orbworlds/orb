// Test-only module resolution hooks (registered by setup.mjs via node:module register()).
// The app's sources use extensionless relative imports (resolved by the bundler); node's type
// stripping needs real file paths, so try ".ts"/".tsx"/"/index.ts". Modules that can't be loaded
// by type stripping or that touch the network are swapped for small stubs in ./stubs.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STUBS = {
  '/src/lib/api.ts': new URL('./stubs/api.mjs', import.meta.url).href,
  '/src/server/worlds.ts': new URL('./stubs/worlds.mjs', import.meta.url).href,
};

const SRC = new URL('../../../', import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  // The "@/…" path alias (tsconfig) → src/…
  if (specifier.startsWith('@/')) specifier = new URL(specifier.slice(2), SRC).href;
  // next has no exports map: plain Node needs the file name.
  if (specifier === 'next/server') specifier = 'next/server.js';
  let result;
  try {
    result = await nextResolve(specifier, context);
  } catch (err) {
    if (!(/^\.{1,2}\//.test(specifier) || specifier.startsWith('file:')) || !context.parentURL) throw err;
    let found = null;
    for (const ext of ['.ts', '.tsx', '/index.ts']) {
      const url = new URL(specifier + ext, context.parentURL);
      if (existsSync(fileURLToPath(url))) {
        found = url.href;
        break;
      }
    }
    if (!found) throw err;
    result = await nextResolve(found, context);
  }
  for (const [suffix, stub] of Object.entries(STUBS)) {
    if (result.url.startsWith('file:') && result.url.endsWith(suffix)) return { url: stub, shortCircuit: true };
  }
  return result;
}

// The app imports JSON without `with { type: 'json' }` (the bundler allows it): load it as a module.
export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.json') && !context.importAttributes?.type) {
    const { readFile } = await import('node:fs/promises');
    return { format: 'module', source: `export default ${await readFile(new URL(url), 'utf8')};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
