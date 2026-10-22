// Importing a GitHub repository as a world (src/server/importer.ts): local-dev three.js import
// maps and root-absolute files in the tree are rewritten so the page runs from Orb's file tree.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('./resolve-hooks.mjs', import.meta.url);

const { rewritePageForOrb, rewriteModuleForOrb, rewriteCssForOrb, bareImports, stripTrackers, servePublicAtTop } = await import('../../../server/importer.ts');

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
  assert.equal(map.postprocessing, 'https://esm.sh/postprocessing@^6.36.0?external=three');
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

test('a module written for Vite: JSON imports and import.meta.glob run in the browser', () => {
  const files = new Set(['src/scenes/full.js', 'src/world/sky.js', 'src/world/sea.js', 'src/world/data.json', 'src/fx/rain.js', 'src/meta.json']);
  const js = rewriteModuleForOrb(
    `import meta from '../meta.json';\nimport ok from './a.json' with { type: 'json' };\nconst M = import.meta.glob(['../world/*.js', '../fx/*.js']);\nconst T = import.meta.glob('../world/sky.js');`,
    { path: 'src/scenes/full.js', files },
  );
  assert.match(js, /import meta from '\.\.\/meta\.json' with \{ type: 'json' \};/);
  assert.match(js, /from '\.\/a\.json' with \{ type: 'json' \};/);
  assert.doesNotMatch(js, /with \{ type: 'json' \} with/);
  assert.match(js, /const M = \(\{ "\.\.\/fx\/rain\.js": \(\) => import\("\.\.\/fx\/rain\.js"\), "\.\.\/world\/sea\.js": \(\) => import\("\.\.\/world\/sea\.js"\), "\.\.\/world\/sky\.js": \(\) => import\("\.\.\/world\/sky\.js"\) \}\);/);
  assert.match(js, /const T = \(\{ "\.\.\/world\/sky\.js": \(\) => import\("\.\.\/world\/sky\.js"\) \}\);/);
});

test('a module written for a bundler: imports without a file name extension, and paths from the site’s top', () => {
  const files = new Set(['app/forest/engine.js', 'app/forest/config.js', 'app/forest/trees.js', 'app/forest/lib/index.js', 'textures/bark.jpg']);
  const js = rewriteModuleForOrb(
    `import {A} from './config';\nimport {t} from './trees.js';\nimport * as L from './lib';\nexport {B} from './config.ts';\nconst m = await import('./config');\nimport x from './missing';\nload('/textures/bark.jpg'); load('/elsewhere/none.jpg'); go('/'); glb('/textures/' + name); tpl(\`/textures/\${name}.jpg\`); new Worker(new URL('./config.ts', import.meta.url));`,
    { path: 'app/forest/engine.js', files },
  );
  assert.match(js, /from '\.\/config\.js';\nimport \{t\} from '\.\/trees\.js';\nimport \* as L from '\.\/lib\/index\.js';\nexport \{B\} from '\.\/config\.js';/);
  assert.match(js, /import\('\.\/config\.js'\)/);
  assert.match(js, /from '\.\/missing'/);
  assert.match(js, /load\('textures\/bark\.jpg'\); load\('\/elsewhere\/none\.jpg'\); go\('\/'\); glb\('textures\/' \+ name\); tpl\(`textures\/\$\{name\}\.jpg`\)/);
  assert.match(js, /new URL\('\.\/config\.js', import\.meta\.url\)/);
});

test('an import map of files at the site’s top becomes relative', () => {
  const html = rewritePageForOrb(`<script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/vendor/addons/","x":"/nope.js"}}</script>`, new Set(['vendor/three.module.js', 'vendor/addons/utils/a.js']));
  assert.match(html, /"three":"\.\/vendor\/three\.module\.js","three\/addons\/":"\.\/vendor\/addons\/","x":"\/nope\.js"/);
});

test('eager import.meta.glob, a TypeScript entry and package ranges', () => {
  const files = new Set(['src/main.js', 'src/modules/a.js', 'src/modules/b.js']);
  const js = rewriteModuleForOrb(`const found = import.meta.glob('./modules/*.js', { eager: true });\nconst d = import.meta.glob('./modules/*.js', { import: 'default', eager: true });`, { path: 'src/main.js', files });
  assert.match(js, /^import \* as __orbGlob0 from "\.\/modules\/a\.js"; import \* as __orbGlob1 from "\.\/modules\/b\.js"; import \* as __orbGlob2/);
  assert.match(js, /const found = \(\{ "\.\/modules\/a\.js": __orbGlob0, "\.\/modules\/b\.js": __orbGlob1 \}\);/);
  assert.match(js, /const d = \(\{ "\.\/modules\/a\.js": __orbGlob2\["default"\], "\.\/modules\/b\.js": __orbGlob3\["default"\] \}\);/);
  const html = rewritePageForOrb('<script type="module" src="/src/main.ts"></script><script src="./other.ts"></script>', files, JSON.stringify({ dependencies: { n8ao: '^1.9.9', three: '^0.180.0' } }), { bare: ['three', 'n8ao'] });
  assert.match(html, /src="src\/main\.js"/);
  assert.match(html, /src="\.\/other\.ts"/);
  assert.match(html, /esm\.sh\/n8ao@\^1\.9\.9\?external=three/);
  assert.match(html, /three@0\.180\.0\/build/);
});

test('a Vite worker import', () => {
  const js = rewriteModuleForOrb(`import TerrainWorker from './terrain.worker.js?worker&inline';\nconst w = new TerrainWorker();`, { path: 'src/a.js', files: new Set(['src/terrain.worker.js']) });
  assert.match(js, /const TerrainWorker = function \(o\) \{ return new Worker\(new URL\("\.\/terrain\.worker\.js", import\.meta\.url\), \{ type: 'module', \.\.\.o \}\); \};/);
});

test('a stylesheet’s files from the site’s top', () => {
  const css = rewriteCssForOrb(`@font-face { src: url('/fonts/a.woff2') format('woff2'), url(/fonts/b.woff?v=2); } x { background: url(/nope.png); }`, 'src/styles/main.css', new Set(['fonts/a.woff2', 'fonts/b.woff']));
  assert.equal(css, `@font-face { src: url('../../fonts/a.woff2') format('woff2'), url(../../fonts/b.woff?v=2); } x { background: url(/nope.png); }`);
});

test('a Vite project serves public/ at the top, with or without a vite.config', () => {
  const repo = (...more) => new Map([['index.html', Buffer.from('<!doctype html>')], ['public/models/a.glb', Buffer.from('a')], ['public/index.html', Buffer.from('not this')], ...more.map(([p, s]) => [p, Buffer.from(s)])]);
  const noConfig = repo(['package.json', '{"devDependencies":{"vite":"^6.0.0"}}']);
  servePublicAtTop(noConfig);
  assert.equal(noConfig.get('models/a.glb')?.toString(), 'a');
  assert.equal(noConfig.get('index.html')?.toString(), '<!doctype html>');
  const config = repo(['vite.config.ts', 'export default {}']);
  servePublicAtTop(config);
  assert.equal(config.get('models/a.glb')?.toString(), 'a');
  const notVite = repo(['package.json', '{"dependencies":{"three":"^0.180.0"}}']);
  servePublicAtTop(notVite);
  assert.equal(notVite.has('models/a.glb'), false);
});
