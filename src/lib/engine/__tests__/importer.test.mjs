// Importing a GitHub repository as a world (src/server/importer.ts): local-dev three.js import
// maps and root-absolute files in the tree are rewritten so the page runs from Orb's file tree.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('./resolve-hooks.mjs', import.meta.url);

const { rewritePageForOrb, rewriteModuleForOrb, bareImports, stripTrackers } = await import('../../../server/importer.ts');

const PAGE = `<!doctype html>
<html><head>
<script type="importmap">
{
  "imports": {
    "three": "/node_modules/three/build/three.module.js",
    "three/addons/": "/node_modules/three/examples/jsm/"
  }
}
</script>
</head>
<body>
<script type="module" src="/src/main.js"></script>
<img src="/media/shot.jpg">
<link href="/missing.css" rel="stylesheet">
</body></html>`;

test('three.js from node_modules becomes jsdelivr; files in the tree become relative', () => {
  const html = rewritePageForOrb(PAGE, new Set(['src/main.js', 'media/shot.jpg']), JSON.stringify({ dependencies: { three: '^0.186.1' } }));
  assert.match(html, /cdn\.jsdelivr\.net\/npm\/three@0\.186\.1\/build\/three\.module\.js/);
  assert.match(html, /cdn\.jsdelivr\.net\/npm\/three@0\.186\.1\/examples\/jsm\//);
  assert.doesNotMatch(html, /node_modules\/three/);
  assert.match(html, /src="src\/main\.js"/);
  assert.match(html, /src="media\/shot\.jpg"/);
  assert.match(html, /href="\/missing\.css"/, 'paths that are not in the tree stay absolute');
});

test('a page that already uses jsdelivr is left alone', () => {
  const page = `<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"}}</script><script src="/src/main.js"></script>`;
  const html = rewritePageForOrb(page, new Set(['src/main.js']));
  assert.match(html, /three@0\.160\.0/);
  assert.match(html, /src="src\/main\.js"/);
});

test('tracker stripping still runs on a rewritten page', () => {
  const dirty = `${PAGE}<script src="https://www.google-analytics.com/analytics.js"></script>`;
  const html = rewritePageForOrb(stripTrackers(dirty), new Set(['src/main.js']));
  assert.doesNotMatch(html, /google-analytics/);
  assert.match(html, /cdn\.jsdelivr\.net\/npm\/three@/);
});

test('code that imports three by name gets an import map for it, first in the head', () => {
  const page = `<!doctype html><html><head><title>x</title></head><body><script type="module" src="/src/main.js"></script></body></html>`;
  const html = rewritePageForOrb(page, new Set(['src/main.js']), JSON.stringify({ dependencies: { three: '^0.170.0' } }), { bare: ['three'] });
  const map = JSON.parse(/<script type="importmap">([^<]+)<\/script>/.exec(html)[1]);
  assert.equal(map.imports.three, 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js');
  assert.equal(map.imports['three/addons/'], 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/');
  assert.ok(html.indexOf('importmap') < html.indexOf('src/main.js'));
  assert.equal(rewritePageForOrb(PAGE, new Set(), null, { bare: ['three'] }).match(/importmap/g).length, 1, 'a page with its own map keeps just that');
});

test('packages imported by name: found in the code, mapped to esm.sh sharing three', () => {
  const js = `import * as THREE from 'three';\nimport { EffectComposer } from "postprocessing";\nimport { N8AOPass } from 'n8ao';\nimport x from './local.js';\nimport '@scope/pkg/sub.js';\nconst m = await import('lil-gui');`;
  assert.deepEqual(bareImports(js).sort(), ['@scope/pkg', 'lil-gui', 'n8ao', 'postprocessing', 'three']);
  const html = rewritePageForOrb('<html><head></head></html>', new Set(), JSON.stringify({ dependencies: { postprocessing: '^6.36.0' } }), { bare: ['three', 'postprocessing'] });
  const map = JSON.parse(/<script type="importmap">([^<]+)<\/script>/.exec(html)[1]).imports;
  assert.equal(map.postprocessing, 'https://esm.sh/postprocessing@6.36.0?external=three');
  assert.match(map.three, /cdn\.jsdelivr\.net\/npm\/three@/);
});

test('a module written for Vite: imported stylesheets become links, import.meta.env a production build', () => {
  const js = rewriteModuleForOrb(`import './style.css';\nimport "../ui/hud.css"\nif (import.meta.env.DEV) console.log('dev');\nimport { a } from './a.js';`);
  assert.doesNotMatch(js, /import\s*['"][^'"]+\.css/);
  assert.match(js, /new URL\("\.\/style\.css", import\.meta\.url\)/);
  assert.match(js, /new URL\("\.\.\/ui\/hud\.css", import\.meta\.url\)/);
  assert.match(js, /DEV: false/);
  assert.match(js, /import \{ a \} from '\.\/a\.js'/);
});
