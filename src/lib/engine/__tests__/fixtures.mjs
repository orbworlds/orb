// Test fixtures (plain JS, see protocol.test.mjs).
// Realistic inputs for the engine tests: a small three.js world in the Orb house style and a
// model reply that writes a world and then improves it with labelled edits.

export const ISLAND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Sky Island</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #f6d7c3; }
  #hint {
    position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
    padding: 8px 14px; border-radius: 999px; font: 500 13px/1.2 system-ui, sans-serif;
    color: #2a2440; background: rgba(255,255,255,.7); backdrop-filter: blur(16px);
    transition: opacity .8s ease;
  }
</style>
</head>
<body>
<div id="hint">Drag to look around</div>
<script type="importmap">{"imports":{
  "three":"https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js",
  "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// === CONFIG ===
const CONFIG = {
  sky: { top: 0x8fb8ff, horizon: 0xffd9c2 },
  grass: 0x9ad49a,
  rock: 0xb9a89a,
  trees: 9,
};

// === SCENE ===
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(CONFIG.sky.horizon, 30, 90);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 300);
camera.position.set(14, 10, 18);

// === SKY & LIGHT ===
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(150, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { top: { value: new THREE.Color(CONFIG.sky.top) }, bottom: { value: new THREE.Color(CONFIG.sky.horizon) } },
    vertexShader: 'varying vec3 vP; void main(){ vP = (modelMatrix * vec4(position,1.)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vP,1.); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = normalize(vP).y; gl_FragColor = vec4(mix(bottom, top, max(h, 0.)), 1.); }',
  })
);
scene.add(sky);
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x8a6f5a, 1.1));
const sun = new THREE.DirectionalLight(0xffe2c4, 2.2);
sun.position.set(12, 20, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun);

// === WORLD ===
const island = new THREE.Mesh(
  new THREE.CylinderGeometry(9, 5, 4, 9),
  new THREE.MeshStandardMaterial({ color: CONFIG.rock, roughness: 0.9, flatShading: true })
);
island.position.y = -2;
island.receiveShadow = true;
scene.add(island);
const grass = new THREE.Mesh(
  new THREE.CylinderGeometry(9.2, 9, 0.6, 9),
  new THREE.MeshStandardMaterial({ color: CONFIG.grass, roughness: 0.85, flatShading: true })
);
grass.receiveShadow = true;
scene.add(grass);

for (let i = 0; i < CONFIG.trees; i++) {
  const a = (i / CONFIG.trees) * Math.PI * 2;
  const tree = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 1.2, 6), new THREE.MeshStandardMaterial({ color: 0x8b5e3c }));
  const crown = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.8, 7), new THREE.MeshStandardMaterial({ color: 0x6fbf73, flatShading: true }));
  crown.position.y = 1.4;
  trunk.castShadow = crown.castShadow = true;
  tree.add(trunk, crown);
  tree.position.set(Math.cos(a) * 6, 0.6, Math.sin(a) * 6);
  scene.add(tree);
}

// === PLAYER / CONTROLS ===
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.48;
controls.minDistance = 8;
controls.maxDistance = 40;

// === UI ===
setTimeout(() => { document.getElementById('hint').style.opacity = '0'; }, 4000);
const orb = window.orb;
setTimeout(() => orb?.capture(), 2500);

// === LOOP ===
const timer = new THREE.Timer();
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
renderer.setAnimationLoop((t) => {
  timer.update(t);
  const dt = Math.min(timer.getDelta(), 0.05);
  island.rotation.y += dt * 0.05;
  controls.update();
  renderer.render(scene, camera);
});
</script>
</body>
</html>`;

/** Edits a model would plausibly make on ISLAND_HTML (finds copied exactly, per the prompt rules). */
export const REALISTIC_EDITS = [
  {
    label: 'Adding drifting clouds',
    find: `// === PLAYER / CONTROLS ===
const controls = new OrbitControls(camera, renderer.domElement);`,
    replace: `// Soft clouds drifting around the island
const clouds = new THREE.Group();
for (let i = 0; i < 6; i++) {
  const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(1.2 + Math.random(), 0), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }));
  puff.position.set((Math.random() - 0.5) * 30, 6 + Math.random() * 4, (Math.random() - 0.5) * 30);
  clouds.add(puff);
}
scene.add(clouds);

// === PLAYER / CONTROLS ===
const controls = new OrbitControls(camera, renderer.domElement);`,
  },
  {
    label: "Letting the clouds float <gently>",
    find: `  island.rotation.y += dt * 0.05;`,
    replace: `  island.rotation.y += dt * 0.05;
  clouds.rotation.y += dt * 0.02;`,
  },
  {
    label: 'Warming up the sunset',
    find: `  sky: { top: 0x8fb8ff, horizon: 0xffd9c2 },`,
    replace: `  sky: { top: 0x7f8fe8, horizon: 0xffc3a0 },`,
  },
];

/** A full, realistic model reply: narration, title, a write, three edits, closing narration, suggestions. */
export function realisticReply() {
  const edits = REALISTIC_EDITS.map(
    (e) => `<orb:edit label="${e.label.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}">
<orb:find>
${e.find}
</orb:find>
<orb:replace>
${e.replace}
</orb:replace>
</orb:edit>`,
  ).join('\n');
  return `<orb:say>Ooh, a floating island in the sky — let's make it!</orb:say>
<orb:title>Sky Island</orb:title>
<orb:write label="Raising the island">
${ISLAND_HTML}
</orb:write>
${edits}
<orb:say>Drag to look around — the clouds drift by slowly.</orb:say>
<orb:suggest>Make it night|Add a little waterfall|Add soft music</orb:suggest>`;
}

/** The code expected after applying the reply above. */
export function expectedAfterReply() {
  let code = ISLAND_HTML;
  for (const e of REALISTIC_EDITS) {
    const i = code.indexOf(e.find);
    if (i === -1) throw new Error('fixture edit does not apply: ' + e.label);
    code = code.slice(0, i) + e.replace + code.slice(i + e.find.length);
  }
  return code;
}

/** Deterministic PRNG so randomized tests are reproducible (seed printed on failure). */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Split text into random chunks of 1..max characters. */
export function randomChunks(text, rand, max = 24) {
  const out = [];
  for (let i = 0; i < text.length; ) {
    const n = 1 + Math.floor(rand() * max);
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}
