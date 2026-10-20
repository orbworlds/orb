// Start pages for curated open-source worlds whose repository has none a world can run (a Next.js
// app, say): convertSeeds (src/server/seed.ts) puts one at the top of the imported files. Each just
// boots the project's own code, as its app did.

export const SEED_PAGES: Record<string, string> = {
  // Verdant Forest's app/page.tsx, as a page.
  'aw-verdant-forest': `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verdant Forest</title>
<link rel="stylesheet" href="app/globals.css">
<style>body { background: #111a12; }</style>
</head>
<body>
<main class="forest" aria-label="Interactive 3D forest">
  <div class="forest-canvas"></div>
  <div class="loading" role="status"><span class="loading-mark"></span><span class="loading-text">Entering the forest</span></div>
  <div class="camera-hint">Drag to look · WASD to move · Q / E to descend / rise</div>
</main>
<script type="module">
import { createForest } from './app/forest/engine.js';
const loading = document.querySelector('.loading');
createForest(document.querySelector('.forest-canvas'), () => {
  loading.remove();
  document.querySelector('.camera-hint').classList.add('ready');
}).catch((e) => {
  console.error(e);
  loading.querySelector('.loading-text').textContent = /WebGL|context/i.test(e?.message || '')
    ? 'This browser cannot run 3D. Enable hardware acceleration or try another browser.'
    : 'The forest could not load. Please reload to try again.';
});
</script>
</body>
</html>
`,
};
