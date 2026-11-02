// nature.js — beautiful outdoor scenes for three.js r186: golden light, sky, haze, wind-blown grass and flowers, trees,
// rocks, water, drifting pollen, bloom. Self-contained ES module.
//   import { createNature } from './orb/nature.js';
//   const world = createNature(renderer, scene, camera, { time: 'golden' }); // or 'morning' 'noon' 'dusk' 'night'
//     // sets up the renderer (tone mapping, shadows), sun, sky, haze and fill light; world.sunDir points at the sun
//   const land = world.terrain({ size: 200, height: 10, flat: [[0, 0, 15]] }); // or height: (x, z) => y; flat: [x, z, radius]
//   land.heightAt(x, z)                                   // the ground's height: stand your things on it
//   world.grass(land, { height: 0.5, where: (x, z) => true }); // swaying, to the horizon; colors: [deep, mid, straw]
//   world.flowers(land, { colors: ['#c8352d', '#3a59c9', '#f2eee2'] }); // in drifts in the grass
//   world.trees(land, { kind: 'oak', count: 40, where });   // 'oak' 'birch' 'pine'; or at: [[x, z], …]
//   world.rocks(land, { count: 20 }); world.water(land, { level: -1 }); world.motes();
//   every frame: world.render() instead of renderer.render; on resize: world.setSize(innerWidth, innerHeight)
//   Your meshes: MeshStandardMaterial; the light, haze and shadows take them in (no lights or fog of your own).
// Taste:
// 1. Camera low (1.5-3 m) looking across the land, 20-60° beside the sun (world.sunDir): backlit grass and leaves glow.
// 2. Layers: grass and flowers right in front, the subject in the middle, trees framing a side, hills fading into haze.
// 3. Trees in groups, rocks half sunk, a path or clearing (where: … false) to lead the eye; never a bare flat plane.
// 4. Muted natural colours, one or two strong accents (red poppies, a red cloak).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Reflector } from 'three/addons/objects/Reflector.js';

const DEG = Math.PI / 180;
const PLANTS = 1; // the layer grass, flowers and motes are on: the main camera sees it, water's mirror doesn't

// ---------- times of day (sun: [degrees around from -z toward +x, degrees up]) ----------
const TIMES = {
  golden: { sun: [25, 11], light: ['#ffc58a', 4.4], fill: ['#9db4e3', '#5c5a3c', 0.55], env: 0.55, zenith: '#4a74bd', mid: '#a6bcdb', horizon: '#f1d0aa', haze: '#b0b5c9', glow: '#ffb55a', density: 0.0055, clouds: 0.5, stars: 0, exposure: 1.1, bloom: 0.5 },
  morning: { sun: [-40, 17], light: ['#ffe2c2', 3.6], fill: ['#b3c6ea', '#59604a', 0.55], env: 0.55, zenith: '#7ca4da', mid: '#b6cbe5', horizon: '#e8ddd2', haze: '#c2c9d8', glow: '#ffcf96', density: 0.008, clouds: 0.3, stars: 0, exposure: 1.1, bloom: 0.4 },
  noon: { sun: [30, 58], light: ['#fff3e0', 3.4], fill: ['#a9c3ee', '#5f6748', 0.55], env: 0.6, zenith: '#4a82d4', mid: '#8fb4e2', horizon: '#c4d8ee', haze: '#c0d0e2', glow: '#fff0d2', density: 0.0035, clouds: 0.4, stars: 0, exposure: 1.05, bloom: 0.3 },
  dusk: { sun: [15, 3], light: ['#ff9a5a', 3.0], fill: ['#8a90c6', '#463c3c', 0.45], env: 0.45, zenith: '#3a4a80', mid: '#a49cba', horizon: '#f0a070', haze: '#8a8fb0', glow: '#ff8c4a', density: 0.0055, clouds: 0.5, stars: 0, exposure: 1.1, bloom: 0.7 },
  night: { sun: [-30, 32], light: ['#a9bcff', 0.7], fill: ['#3b4a7c', '#0f1218', 0.35], env: 0.35, zenith: '#050a1c', mid: '#0e1730', horizon: '#1b2540', haze: '#18213a', glow: '#3a4f8c', density: 0.005, clouds: 0.15, stars: 1, exposure: 1.1, bloom: 0.6 },
};

const TREES = {
  oak: { height: [7, 11], girth: 0.034, lean: 0.08, start: 0.38, boughs: [5, 7], spread: [48, 72], reach: 0.42, twigs: 2, crown: 0.2, cards: 120, card: 1.3, bark: '#6e5c4a', leaf: ['#4f6e2c', '#86963e'], spacing: 6 },
  birch: { height: [9, 14], girth: 0.02, lean: 0.05, start: 0.45, boughs: [6, 9], spread: [25, 45], reach: 0.3, twigs: 1, crown: 0.15, cards: 80, card: 1.05, bark: '#e8e3d8', leaf: ['#6f8c34', '#aeb04a'], droop: 0.3, birch: true, spacing: 3.5 },
  pine: { height: [10, 16], girth: 0.028, lean: 0.02, start: 0.18, boughs: [14, 20], spread: [80, 100], reach: 0.26, twigs: 0, crown: 0.12, cards: 34, card: 1.3, bark: '#5a4636', leaf: ['#2c4628', '#4a6234'], droop: 0.15, cone: true, spacing: 4 },
};

// ---------- noise: JS for placing, GLSL twins for shading ----------
const hashU = (x, y) => {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
export function noise(x, y) { // smooth value noise in [0, 1]
  const xi = Math.floor(x), yi = Math.floor(y);
  let u = x - xi, v = y - yi;
  u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
  const a = hashU(xi, yi), b = hashU(xi + 1, yi), c = hashU(xi, yi + 1), d = hashU(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, y, oct = 4) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) { s += a * noise(x, y); n += a; x = x * 2.03 + 17.1; y = y * 2.03 + 5.3; a *= 0.5; }
  return s / n;
}
export function rng(seed = 1) { // seeded Math.random replacement
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const NK = /* glsl */ `
uint nkPcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float nkHash(vec2 p) { uvec2 q = uvec2(ivec2(floor(p)) + 65536); return float(nkPcg(q.x + nkPcg(q.y))) * 2.3283064e-10; }
float nkNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(nkHash(i), nkHash(i + vec2(1.0, 0.0)), f.x), mix(nkHash(i + vec2(0.0, 1.0)), nkHash(i + vec2(1.0, 1.0)), f.x), f.y); }
float nkFbm(vec2 p) { return (nkNoise(p) * 4.0 + nkNoise(p * 2.03 + 17.1) * 2.0 + nkNoise(p * 4.07 + 5.3)) / 7.0; }
`;

// The land, as every ground-hugging shader sees it: height and where-grass-grows textures, palette, water level.
const LAND = /* glsl */ `
uniform sampler2D nkLand, nkWhere; uniform vec4 nkRect; uniform float nkLevel, nkUnder, nkTime;
uniform vec3 nkC0, nkC1, nkC2, nkDirt, nkRock, nkSand;
vec2 nkLandUv(vec2 p) { return ((p - nkRect.xy) * nkRect.z * (nkRect.w - 1.0) + 0.5) / nkRect.w; }
float nkInside(vec2 p) { vec2 t = (p - nkRect.xy) * nkRect.z; return step(0.0, min(t.x, t.y)) * step(max(t.x, t.y), 1.0); }
vec3 nkGrassColor(vec2 p) {
  float drift = nkFbm(p * 0.025), streak = nkFbm(p * 0.13 + 7.0);
  return mix(mix(nkC0, nkC1, smoothstep(0.3, 0.7, drift)), nkC2, smoothstep(0.52, 0.8, streak) * 0.6);
}
float nkSway(vec2 p, float wind) { // slow gusts rolling across the land, a quick flutter on top
  float gust = nkNoise(p * 0.04 - vec2(nkTime * 0.35, nkTime * 0.12));
  return wind * (0.25 + 0.9 * gust) * (0.8 + 0.2 * sin(nkTime * 2.3 + dot(p, vec2(0.9, 0.6))));
}
`;

// Light through thin leaves and petals: what makes backlit grass glow.
function glowFragment(s, power) {
  const direct = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  s.fragmentShader = s.fragmentShader
    .replace('#include <normal_fragment_begin>', 'float faceDirection = 1.0;\nvec3 normal = normalize( vNormal );\nvec3 nonPerturbedNormal = normal;')
    .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replaceAll(direct, `${direct}
      reflectedLight.directDiffuse += directLight.color * diffuseColor.rgb * nkGlow * pow( max( dot( - geometryViewDir, directLight.direction ), 0.0 ), ${power.toFixed(1)} ) * ( 0.25 + 0.75 * vNkT * vNkT );`));
}

// ---------- the world: renderer, sun, sky, haze, light, post ----------
export function createNature(renderer, scene, camera, opts = {}) {
  const o = { ...TIMES.golden, ...TIMES[opts.time], ...opts };
  const quality = opts.quality ?? autoQuality(renderer);
  const sunDir = new THREE.Vector3(Math.sin(o.sun[0] * DEG) * Math.cos(o.sun[1] * DEG), Math.sin(o.sun[1] * DEG), -Math.cos(o.sun[0] * DEG) * Math.cos(o.sun[1] * DEG));
  const u = { time: { value: 0 } };

  renderer.setPixelRatio(Math.min(renderer.getPixelRatio(), quality < 1 ? 1.25 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = o.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  // Haze: three's fog, made to thin with height and glow toward the sun, for every material in the scene.
  const glow = new THREE.Color(o.glow);
  patchShaders(sunDir, glow, new THREE.Color(o.light[0]).multiplyScalar(o.light[1] * 0.35));
  scene.fog = new THREE.FogExp2(o.haze, o.density);
  scene.background = null;
  scene.traverse((m) => { if (m.material) [].concat(m.material).forEach((x) => { x.needsUpdate = true; }); });

  const skyU = {
    uZenith: { value: new THREE.Color(o.zenith) }, uMid: { value: new THREE.Color(o.mid) }, uHorizon: { value: new THREE.Color(o.horizon) }, uHaze: { value: new THREE.Color(o.haze) },
    uGlow: { value: glow }, uSun: { value: sunDir }, uSunColor: { value: new THREE.Color(o.light[0]) }, uGround: { value: new THREE.Color(o.fill[1]) },
    uClouds: { value: o.clouds }, uStars: { value: o.stars }, uTime: u.time,
  };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), skyMaterial(skyU, false));
  sky.renderOrder = -1e6; sky.frustumCulled = false; sky.userData.nature = true;
  scene.add(sky);

  const sun = new THREE.DirectionalLight(o.light[0], o.light[1]);
  const S = quality < 1 ? 30 : 38; // half the shadowed square, in metres, around where the camera looks
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(quality < 0.6 ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 400 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04; sun.shadow.radius = 2;
  const fill = new THREE.HemisphereLight(o.fill[0], o.fill[1], o.fill[2]);
  scene.add(sun, sun.target, fill);

  // The sky, blurred, lights every standard material from all around (blue shade, warm bounce).
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(sky.geometry, skyMaterial(skyU, true));
  envSky.scale.setScalar(50);
  envScene.add(envSky);
  scene.environment = pmrem.fromScene(envScene, 0.04).texture;
  scene.environmentIntensity = o.env;
  pmrem.dispose();

  // Post: bloom on the bright sky and glints, filmic tone mapping, then a gentle grade.
  const size = renderer.getSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: quality < 0.9 ? 0 : 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), o.bloom, 0.6, 1.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  grade.uniforms.uTime = u.time;
  composer.addPass(grade);
  composer.setSize(size.x, size.y);

  camera.layers.enable(PLANTS);
  const camPos = new THREE.Vector3(), camFwd = new THREE.Vector3(), followers = [];
  const world = {
    sun, fill, sky, sunDir, composer, bloom, grade, quality, uniforms: u, followers,
    terrain: (opts) => makeTerrain(world, opts),
    grass: (land, opts) => makeGrass(world, land, opts),
    flowers: (land, opts) => makeFlowers(world, land, opts),
    trees: (land, opts) => makeTrees(world, land, opts),
    rocks: (land, opts) => makeRocks(world, land, opts),
    water: (land, opts) => makeWater(world, land, opts),
    motes: (opts) => makeMotes(world, scene, opts),
    render() { composer.render(); },
    setSize(w, h) { renderer.setSize(w, h); composer.setSize(w, h); },
  };

  // Each frame, before the scene renders (and before its shadows): time, sky, shadows and grass follow the camera.
  const t0 = performance.now();
  let frames = 0;
  const seen = new WeakSet(), scale = new THREE.Vector3();
  const lx = new THREE.Vector3(), ly = new THREE.Vector3(), focus = new THREE.Vector3();
  const before = scene.onBeforeRender;
  scene.onBeforeRender = function (...args) {
    u.time.value = (performance.now() - t0) / 1000;
    camera.getWorldPosition(camPos);
    camera.getWorldDirection(camFwd);
    sky.position.copy(camPos);
    sky.scale.setScalar(camera.far * 0.9);
    if (scene.fog) skyU.uHaze.value.copy(scene.fog.color);
    // the shadowed square sits ahead of the camera and moves in whole shadow texels (no shimmer)
    const flat = Math.hypot(camFwd.x, camFwd.z) || 1;
    focus.set(camPos.x + (camFwd.x / flat) * S * 0.5, camPos.y, camPos.z + (camFwd.z / flat) * S * 0.5);
    lx.crossVectors(THREE.Object3D.DEFAULT_UP, sunDir).normalize();
    ly.crossVectors(sunDir, lx);
    const texel = (2 * S) / sun.shadow.mapSize.x, snap = (v) => Math.round(v / texel) * texel;
    const a = snap(focus.dot(lx)), b = snap(focus.dot(ly)), c = focus.dot(sunDir);
    focus.copy(lx).multiplyScalar(a).addScaledVector(ly, b).addScaledVector(sunDir, c);
    sun.target.position.copy(focus);
    sun.position.copy(focus).addScaledVector(sunDir, 150);
    sun.target.updateMatrixWorld();
    for (const f of followers) f(camPos, camFwd);
    // your meshes cast and take shadows (not huge or see-through ones; userData.noShadow opts out)
    if (frames++ % 30 === 0) scene.traverse((m) => {
      if (!m.isMesh || seen.has(m) || m.userData.nature) return;
      seen.add(m);
      m.receiveShadow = true;
      const mat = [].concat(m.material)[0];
      if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
      const r = (m.geometry.boundingSphere?.radius ?? 0) * m.getWorldScale(scale).x;
      if (!mat?.transparent && r < 30 && !m.userData.noShadow) m.castShadow = true;
    });
    return before.apply(this, args);
  };
  return world;
}

function autoQuality(renderer) {
  let name = '';
  try {
    const gl = renderer.getContext();
    name = String(gl.getParameter(gl.RENDERER) || '');
    if (!name || /^webkit webgl$/i.test(name)) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
    }
  } catch { /* unknown: assume a real GPU */ }
  if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)) return 0.8;
  return globalThis.matchMedia?.('(pointer: coarse)').matches ? 0.55 : 1;
}

// Every material: haze that thins with height and glows toward the sun; a rim of sunlight on what stands against it.
const LIGHTS_END = THREE.ShaderChunk.lights_fragment_end;
function patchShaders(sunDir, glow, rim) {
  const v = (x) => `vec3(${x.toArray().map((n) => n.toFixed(5)).join(', ')})`;
  const C = THREE.ShaderChunk;
  C.lights_fragment_end = LIGHTS_END + /* glsl */ `
#if defined( RE_Direct )
	{
		vec3 nkSunV = normalize( ( viewMatrix * vec4( ${v(sunDir)}, 0.0 ) ).xyz );
		float nkRim = pow( 1.0 - saturate( dot( geometryNormal, geometryViewDir ) ), 3.0 ) * pow( saturate( dot( - geometryViewDir, nkSunV ) ), 2.0 );
		reflectedLight.directDiffuse += ${v(rim)} * nkRim * material.diffuseColor;
	}
#endif`;
  C.fog_pars_vertex = '#ifdef USE_FOG\n\tvarying float vFogDepth;\n\tvarying vec3 vFogWorld;\n#endif';
  C.fog_vertex = '#ifdef USE_FOG\n\tvFogDepth = - mvPosition.z;\n\tvFogWorld = cameraPosition + ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;\n#endif';
  C.fog_pars_fragment = /* glsl */ `#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorld;
	#ifdef FOG_EXP2
		uniform float fogDensity;
		vec4 nkHaze( vec3 from, vec3 to, vec3 base, float density ) {
			vec3 d = to - from; float len = length( d );
			float k = clamp( d.y / 80.0, -10.0, 10.0 );                 // haze thins with height (80 m scale)
			float lay = abs( k ) > 1e-3 ? ( 1.0 - exp( - k ) ) / k : 1.0;
			float tau = density * exp( - clamp( from.y, -40.0, 400.0 ) / 80.0 ) * max( len - 20.0, 0.0 ) * lay; // the first 20 m stay clear
			float c = max( dot( d / max( len, 1e-3 ), ${v(sunDir)} ), 0.0 );
			vec3 col = base + ${v(glow)} * ( 0.3 * pow( c, 4.0 ) + 0.25 * pow( c, 14.0 ) + 0.25 * pow( c, 48.0 ) );
			return vec4( col, 1.0 - exp( - tau ) );
		}
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`;
  C.fog_fragment = /* glsl */ `#ifdef USE_FOG
	#ifdef FOG_EXP2
		vec4 nkFog = nkHaze( cameraPosition, vFogWorld, fogColor, fogDensity );
		gl_FragColor.rgb = mix( gl_FragColor.rgb, nkFog.rgb, nkFog.a );
	#else
		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, smoothstep( fogNear, fogFar, vFogDepth ) );
	#endif
#endif`;
}

function skyMaterial(uniforms, env) {
  return new THREE.ShaderMaterial({
    name: env ? 'NatureSkyLight' : 'NatureSky', uniforms, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    defines: env ? { NK_ENV: '' } : {},
    vertexShader: 'varying vec3 vDir;\nvoid main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith, uMid, uHorizon, uHaze, uGlow, uSun, uSunColor, uGround; uniform float uClouds, uStars, uTime;
      varying vec3 vDir;
      ${NK}
      void main() {
        vec3 dir = normalize( vDir );
        float y = dir.y, toward = max( dot( dir, uSun ), 0.0 );
        float h = clamp( y, 0.0, 1.0 );
        vec3 col = mix( mix( uHorizon, uMid, smoothstep( 0.0, 0.16, h ) ), uZenith, smoothstep( 0.1, 0.7, h ) );
        if ( y > 0.0 && uStars > 0.0 ) {
          vec2 sp = dir.xz / ( y + 1.0 ) * 160.0, id = floor( sp );
          float h = nkHash( id );
          vec2 at = vec2( nkHash( id + 7.0 ), nkHash( id + 13.0 ) ) * 0.6 + 0.2;
          col += vec3( 0.85, 0.9, 1.0 ) * smoothstep( 0.14, 0.0, length( fract( sp ) - at ) ) * step( 0.985, h ) * ( h - 0.985 ) * 140.0 * uStars * smoothstep( 0.05, 0.3, y );
        }
        if ( y > 0.0 && uClouds > 0.0 ) {
          vec2 q = dir.xz / ( y + 0.1 ) * 1.3 + vec2( uTime * 0.004, uTime * 0.0015 );
          float n = nkFbm( q ) * 0.7 + nkFbm( q * 2.7 + 3.1 ) * 0.3;
          float cover = smoothstep( 1.0 - uClouds * 0.6, 1.25 - uClouds * 0.6, n ) * smoothstep( 0.0, 0.18, y );
          vec3 lit = mix( uHorizon, uSunColor * 1.4, pow( toward, 2.0 ) * 0.8 + 0.2 );
          col = mix( col, mix( mix( uZenith, uHaze, 0.5 ), lit, smoothstep( 0.55, 0.85, n ) ), cover * 0.9 );
        }
        float c = toward;
        vec3 haze = uHaze + uGlow * ( 0.3 * pow( c, 4.0 ) + 0.25 * pow( c, 14.0 ) + 0.25 * pow( c, 48.0 ) );
        col = mix( haze, col, smoothstep( -0.02, 0.14, y ) ); // the horizon melts into the haze
        #ifdef NK_ENV
          col = mix( col, uGround, smoothstep( 0.0, -0.25, y ) ); // light bounced off the ground
        #else
          col += uSunColor * ( smoothstep( 0.99955, 0.99975, toward ) * 14.0 + pow( toward, 2500.0 ) * 2.5 + pow( toward, 300.0 ) * 0.5 );
        #endif
        gl_FragColor = vec4( col, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

const GradeShader = {
  name: 'NatureGrade',
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uSat: { value: 1.15 }, uCurve: { value: 0.3 }, uVignette: { value: 0.32 }, uGrain: { value: 0.016 } },
  vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime, uSat, uCurve, uVignette, uGrain; varying vec2 vUv;
    ${NK}
    void main() {
      vec3 c = texture2D( tDiffuse, vUv ).rgb;
      float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
      c = mix( vec3( l ), c, uSat );
      c = mix( c, c * c * ( 3.0 - 2.0 * c ), uCurve );                                                 // gentle S-curve
      c *= mix( vec3( 0.94, 0.97, 1.06 ), vec3( 1.04, 1.0, 0.94 ), smoothstep( 0.1, 0.8, l ) );       // cool shade, warm light
      vec2 q = vUv - 0.5;
      c *= 1.0 - uVignette * dot( q, q ) * 1.6;
      c += ( nkHash( gl_FragCoord.xy + fract( uTime * 7.0 ) * 997.0 ) - 0.5 ) * uGrain;
      gl_FragColor = vec4( c, 1.0 );
    }`,
};

// ---------- terrain ----------
function makeTerrain(world, { size = 200, height = 10, flat = [], seed = 1, colors = ['#58722e', '#9aa04a', '#c8b25e'], dirt = '#7d6a4c', rock = '#8a8377', sand = '#b9a47c' } = {}) {
  const half = size / 2, ox = hashU(seed, 7) * 1000, oz = hashU(seed, 9) * 1000;
  const shape = typeof height === 'function' ? height : (x, z) =>
    (fbm((x + ox) / 70, (z + oz) / 70, 5) - 0.5) * 2 * height + smooth(0.8, 1.35, Math.hypot(x, z) / half) * Math.max(height, 4) * 2.5; // the edge rises
  const heightAt = (x, z) => {
    let y = shape(x, z);
    for (const [fx, fz, fr] of flat) y += (shape(fx, fz) - y) * smooth(fr * 1.6, fr, Math.hypot(x - fx, z - fz));
    return y;
  };
  const e = 0.5, n = new THREE.Vector3();
  const normalAt = (x, z) => n.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize();

  // one mesh to the horizon: fine (about 1.2 m) over the land, coarse beyond it
  const seg = world.quality < 1 ? 160 : 220, outer = size * 1.6, k = 0.8;
  const warp = (t) => Math.sign(t) * (Math.abs(t) <= k ? (Math.abs(t) / k) * half : half + ((Math.abs(t) - k) / (1 - k)) * (outer - half));
  const geo = new THREE.PlaneGeometry(2, 2, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = warp(p.getX(i)), z = warp(p.getZ(i)); p.setXYZ(i, x, heightAt(x, z), z); }
  geo.computeVertexNormals();

  const N = 257, hd = new Uint16Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) hd[j * N + i] = THREE.DataUtils.toHalfFloat(heightAt(-half + (i * size) / (N - 1), -half + (j * size) / (N - 1)));
  const col = (c) => ({ value: new THREE.Color(c) });
  const land = {
    size, half, N, heightAt, normalAt, flat, level: -Infinity,
    u: {
      nkLand: { value: dataTexture(hd, N, THREE.HalfFloatType) }, nkWhere: { value: dataTexture(new Uint8Array([255]), 1, THREE.UnsignedByteType) },
      nkRect: { value: new THREE.Vector4(-half, -half, 1 / size, N) }, nkLevel: { value: -1e4 }, nkUnder: { value: 0.9 }, nkTime: world.uniforms.time,
      nkC0: col(colors[0]), nkC1: col(colors[1]), nkC2: col(colors[2] ?? colors[1]), nkDirt: col(dirt), nkRock: col(rock), nkSand: col(sand),
    },
  };
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, land.u);
    s.vertexShader = 'varying vec3 vNkWorld;\n' + s.vertexShader.replace('#include <fog_vertex>', '#include <fog_vertex>\nvNkWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    s.fragmentShader = `varying vec3 vNkWorld;\n${NK}\n${LAND}\n` + s.fragmentShader.replace('#include <color_fragment>', /* glsl */ `
      vec2 nkP = vNkWorld.xz;
      float nkD = distance( nkP, cameraPosition.xz );
      float nkWant = mix( 1.0, texture( nkWhere, nkLandUv( nkP ) ).r, nkInside( nkP ) );
      vec3 nkCol = nkGrassColor( nkP ) * mix( nkUnder, 0.82, smoothstep( 4.0, 30.0, nkD ) ); // soil under the blades, the meadow's colour far off
      nkCol *= 0.8 + 0.4 * nkFbm( nkP * 0.06 + 3.0 );                                                    // patches
      float nkWoods = smoothstep( 0.52, 0.66, nkFbm( nkP * 0.012 + 9.0 ) ) * smoothstep( 60.0, 110.0, nkD );   // woods on far hills
      nkCol = mix( nkCol, nkC0 * ( 0.3 + 0.35 * nkNoise( nkP * 0.4 ) ), nkWoods );
      nkCol = mix( nkDirt * ( 0.8 + 0.4 * nkNoise( nkP * 0.7 ) ), nkCol, smoothstep( 0.15, 0.7, nkWant ) );
      vec3 nkN = normalize( cross( dFdx( vNkWorld ), dFdy( vNkWorld ) ) );
      nkCol = mix( nkCol, nkRock * ( 0.8 + 0.4 * nkNoise( nkP * 1.3 ) ), smoothstep( 0.8, 0.62, abs( nkN.y ) ) ); // steep: bare rock
      nkCol = mix( nkCol, nkSand, smoothstep( nkLevel + 0.7, nkLevel + 0.15, vNkWorld.y ) );                  // the shore
      diffuseColor.rgb *= nkCol;`);
  };
  mat.customProgramCacheKey = () => 'nature-terrain';
  land.mesh = new THREE.Mesh(geo, mat);
  land.mesh.receiveShadow = true;
  land.mesh.userData.nature = true;
  world.sky.parent.add(land.mesh);
  return land;
}

function dataTexture(data, n, type) {
  const t = new THREE.DataTexture(data, n, n, THREE.RedFormat, type);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

// where (x, z) → true/false or 0-1, sampled over the land, with steep slopes and water left out
function whereTexture(land, where) {
  const N = land.N, d = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = -land.half + (i * land.size) / (N - 1), z = -land.half + (j * land.size) / (N - 1);
    const w = where ? Number(where(x, z)) : 1;
    d[j * N + i] = Math.round(255 * Math.min(1, Math.max(0, Number.isFinite(w) ? w : 0)) * smooth(0.6, 0.8, land.normalAt(x, z).y));
  }
  return dataTexture(d, N, THREE.UnsignedByteType);
}

// ---------- grass and flowers: blades placed on the GPU in rings that follow the camera ----------
function ring(world, land, { cell, reach, geometry, material, inner = 0 }) {
  const side = Math.ceil((2 * reach) / cell);
  geometry.instanceCount = side * side;
  const ru = { nkOrigin: { value: new THREE.Vector2() }, nkCell: { value: cell }, nkSide: { value: side }, nkReach: { value: reach }, nkInner: { value: inner } };
  Object.assign(material.userData.uniforms, ru, land.u);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.userData.nature = true; mesh.layers.set(PLANTS);
  world.followers.push((pos, fwd) => {
    const f = Math.hypot(fwd.x, fwd.z) || 1, cx = pos.x + (fwd.x / f) * reach * 0.45, cz = pos.z + (fwd.z / f) * reach * 0.45;
    ru.nkOrigin.value.set(Math.floor((cx - reach) / cell) * cell, Math.floor((cz - reach) / cell) * cell);
  });
  world.sky.parent.add(mesh);
  return mesh;
}

const RING = /* glsl */ `
uniform vec2 nkOrigin; uniform float nkCell, nkReach, nkInner; uniform int nkSide;
varying vec3 vNkColor; varying float vNkT;
`;
const RING_CELL = /* glsl */ `
  vec2 nkId = floor( nkOrigin / nkCell + 0.5 ) + vec2( float( gl_InstanceID % nkSide ), float( gl_InstanceID / nkSide ) );
  float h1 = nkHash( nkId + SALT ), h2 = nkHash( nkId + SALT + 101.0 ), h3 = nkHash( nkId + SALT + 211.0 ), h4 = nkHash( nkId + SALT + 307.0 );
  vec2 nkP = ( nkId + vec2( h1, h2 ) ) * nkCell;
  vec2 nkUv = nkLandUv( nkP );
  float nkGround = texture( nkLand, nkUv ).r;
  float nkD = distance( nkP, cameraPosition.xz );
  float nkKeep = texture( nkWhere, nkUv ).r * nkInside( nkP ) * step( nkLevel + 0.15, nkGround )
    * ( 1.0 - smoothstep( nkReach * 0.6, nkReach, nkD ) ) * smoothstep( nkInner * 0.75, nkInner, nkD );
`;

function plantMaterial(key, uniforms, body, power, params) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0, side: THREE.DoubleSide, ...params });
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, m.userData.uniforms);
    s.vertexShader = `${NK}\n${LAND}\n${RING}\n${body.head ?? ''}\n` + s.vertexShader
      .replace('#include <beginnormal_vertex>', body.vertex)
      .replace('#include <begin_vertex>', 'vec3 transformed = nkPos;');
    s.fragmentShader = `varying vec3 vNkColor; varying float vNkT; uniform float nkGlow;\n${body.fragmentHead ?? ''}\n` + s.fragmentShader
      .replace('#include <color_fragment>', body.color ?? 'diffuseColor.rgb *= vNkColor;');
    glowFragment(s, power);
  };
  m.customProgramCacheKey = () => key;
  return m;
}

function bladeGeometry(segs) {
  const pos = [], idx = [];
  for (let i = 0; i < segs; i++) pos.push(-0.5, i / segs, 0, 0.5, i / segs, 0);
  pos.push(0, 1, 0);
  for (let i = 0; i < segs - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  idx.push((segs - 1) * 2, (segs - 1) * 2 + 1, segs * 2);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.length, 3)); // made in the shader; present so it isn't flat-shaded
  g.setIndex(idx);
  return g;
}

const GRASS = {
  vertex: RING_CELL.replaceAll('SALT', '0.0') + /* glsl */ `
  float nkGrow = clamp( ( nkKeep - h3 ) * 6.0, 0.0, 1.0 );         // thins out by shrinking, never popping
  float nkTall = nkHeight * ( 0.55 + 0.9 * h4 ) * ( 0.65 + 0.7 * nkNoise( nkP * 0.07 ) ) * nkGrow;
  float nkT = position.y, nkAng = h1 * 6.2832 + h2 * 3.0;
  vec3 nkFace = vec3( cos( nkAng ), 0.0, sin( nkAng ) ), nkSideV = vec3( - nkFace.z, 0.0, nkFace.x );
  vec3 nkBend = nkFace * ( 0.12 + 0.3 * h3 ) + vec3( 0.8, 0.0, 0.35 ) * nkSway( nkP, nkWind ) * 0.5;
  float nkBt = pow( nkT, 1.4 );
  float nkW = nkWidth * ( 0.7 + 0.6 * h2 ) * ( 1.0 + nkD * 0.05 ) * step( 0.001, nkGrow );
  vec3 nkPos = vec3( nkP.x, nkGround, nkP.y ) + nkSideV * position.x * nkW * pow( 1.0 - nkT, 0.6 )
    + vec3( 0.0, nkT * nkTall * ( 1.0 - 0.25 * length( nkBend ) * nkBt ), 0.0 ) + nkBend * nkBt * nkTall;
  vec3 nkToCam = normalize( cameraPosition - nkPos );
  vec3 objectNormal = normalize( nkFace * sign( dot( nkFace, nkToCam ) + 1e-4 ) * 0.6 + vec3( 0.0, 0.9, 0.0 ) + nkToCam * 0.3 + nkSideV * position.x * 0.7 );
  vec3 nkC = nkGrassColor( nkP ) * ( 0.85 + 0.3 * h2 ) * mix( 0.42, 1.0, nkT );
  vNkColor = mix( nkC, nkC * vec3( 1.15, 1.08, 0.8 ), nkT * nkT * 0.5 );   // tips a little sunburnt
  vNkT = nkT;`,
  head: 'uniform float nkHeight, nkWidth, nkWind;',
};

function makeGrass(world, land, { height = 0.5, colors, where, density = 1, wind = 1, reach } = {}) {
  if (colors) colors.forEach((c, i) => land.u[`nkC${i}`]?.value.set(c));
  if (where || !land.grassy) land.u.nkWhere.value = whereTexture(land, where);
  land.u.nkUnder.value = 0.55;
  land.grassy = true;
  land.grassHeight = height;
  const q = world.quality * density, far = reach ?? Math.min(50, land.size * 0.4);
  const make = (cell, r, segs, inner) => ring(world, land, {
    cell: cell / Math.sqrt(q), reach: r, inner, geometry: bladeGeometry(segs),
    material: plantMaterial('nature-grass', { nkHeight: { value: height }, nkWidth: { value: 0.032 * Math.max(1, height / 0.5) }, nkWind: { value: wind }, nkGlow: { value: 2.2 } }, GRASS, 2.5),
  });
  return [make(0.1, 14, 6, 0), make(0.35, far, 2, 13)];
}

const FLOWERS = {
  vertex: RING_CELL.replaceAll('SALT', '3.0') + /* glsl */ `
  nkKeep *= ( smoothstep( 0.45, 0.75, nkNoise( nkP * 0.07 + 31.0 ) ) * 0.8 + 0.12 ) * nkAmount; // in drifts
  float nkGrow = clamp( ( nkKeep - h3 ) * 6.0, 0.0, 1.0 );
  float nkKind = floor( ( h4 > 0.85 ? fract( h4 * 7.3 ) : nkNoise( nkP * 0.045 + 77.0 ) ) * nkKinds * 0.999 ); // each drift its own kind, a few strays
  vec3 nkBloom = nkKind < 1.0 ? nkF0 : nkKind < 2.0 ? nkF1 : nkKind < 3.0 ? nkF2 : nkF3;
  float nkTall = nkStem * ( 0.75 + 0.5 * h2 ) * nkGrow;
  vec3 nkBend = vec3( 0.8, 0.0, 0.35 ) * nkSway( nkP, nkWind ) * 0.5 + vec3( h1 - 0.5, 0.0, h2 - 0.5 ) * 0.3;
  vec3 nkRight = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
  vec3 nkRoot = vec3( nkP.x, nkGround, nkP.y ), nkPos;
  if ( position.z > 0.5 ) { // the head, turned to the camera
    nkPos = nkRoot + vec3( 0.0, nkTall, 0.0 ) + nkBend * nkTall + ( nkRight * position.x + vec3( 0.0, position.y * 0.8, 0.0 ) ) * nkSize * ( 0.8 + 0.4 * h1 ) * ( 1.0 + nkD * 0.05 ) * nkGrow;
    vNkUv = position.xy; vNkColor = nkBloom; vNkT = 1.0;
  } else {
    nkPos = nkRoot + nkRight * position.x * 0.012 * nkGrow + vec3( 0.0, position.y * nkTall, 0.0 ) + nkBend * pow( position.y, 1.4 ) * nkTall;
    vNkUv = vec2( 9.0 ); vNkColor = nkGrassColor( nkP ) * mix( 0.5, 0.9, position.y ); vNkT = position.y * 0.6;
  }
  vec3 objectNormal = normalize( vec3( 0.0, 1.0, 0.0 ) + normalize( cameraPosition - nkPos ) * 0.6 );`,
  head: 'uniform float nkStem, nkSize, nkAmount, nkKinds, nkWind; uniform vec3 nkF0, nkF1, nkF2, nkF3; varying vec2 vNkUv;',
  fragmentHead: 'varying vec2 vNkUv;',
  color: /* glsl */ `
    vec3 nkCol = vNkColor;
    if ( vNkUv.x < 8.0 ) { // five round petals and a centre
      float r = length( vNkUv ), a = atan( vNkUv.y, vNkUv.x );
      if ( r > 0.62 + 0.38 * abs( cos( a * 2.5 ) ) ) discard;
      vec3 heart = dot( vNkColor, vec3( 0.333 ) ) > 0.45 ? vec3( 0.85, 0.55, 0.05 ) : vec3( 0.05, 0.04, 0.03 );
      nkCol = mix( heart, vNkColor * ( 0.8 + 0.3 * r ), smoothstep( 0.22, 0.3, r ) );
    }
    diffuseColor.rgb *= nkCol;`,
};

function makeFlowers(world, land, { colors = ['#b8322a', '#5068b8', '#ece8dc'], amount = 1, height, size = 0.045 } = {}) {
  const pos = [-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.length, 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  const c = colors.slice(0, 4), un = { nkStem: { value: height ?? (land.grassHeight ?? 0.5) * 1.05 }, nkSize: { value: size }, nkAmount: { value: amount }, nkKinds: { value: c.length }, nkWind: { value: 1 }, nkGlow: { value: 0.45 } };
  for (let i = 0; i < 4; i++) un[`nkF${i}`] = { value: new THREE.Color(c[i] ?? c[0]) };
  return ring(world, land, { cell: 0.35 / Math.sqrt(world.quality), reach: 28, geometry: g, material: plantMaterial('nature-flowers', un, FLOWERS, 3, { roughness: 0.6 }) });
}

// ---------- trees: tapered tubes for wood, alpha-cut leaf cards for crowns, a few variants instanced ----------
function makeTrees(world, land, { kind = 'oak', count = 30, where, at, size = 1, wind = 1, seed = 1 } = {}) {
  const P = TREES[kind] ?? TREES.oak, r = rng(seed * 7919 + kind.length);
  const spots = at ?? place(land, { count, where, spacing: P.spacing * size, groups: true }, r);
  const group = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: P.bark, map: barkTexture(P), roughness: 0.95 });
  const leaves = new THREE.MeshStandardMaterial({ map: leafTexture(P), alphaTest: 0.45, side: THREE.DoubleSide, vertexColors: true, roughness: 0.8 });
  const un = { nkTime: world.uniforms.time, nkWind: { value: wind }, nkGlow: { value: 0.55 } };
  leaves.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, un);
    s.vertexShader = 'uniform float nkTime, nkWind;\nvarying float vNkT;\n' + s.vertexShader.replace('#include <begin_vertex>', /* glsl */ `
      vec3 transformed = position;
      #ifdef USE_INSTANCING
        vec2 nkSeed = instanceMatrix[ 3 ].xz;
      #else
        vec2 nkSeed = vec2( 0.0 );
      #endif
      float nkSway = sin( nkTime * 1.1 + nkSeed.x * 0.37 + nkSeed.y * 0.21 ) * 0.5 + sin( nkTime * 2.3 + nkSeed.x * 0.11 ) * 0.25;
      transformed.xz += vec2( 0.8, 0.35 ) * nkSway * nkWind * 0.012 * max( position.y, 0.0 );
      transformed += sin( nkTime * 3.7 + dot( position, vec3( 2.1, 1.7, 2.9 ) ) ) * 0.03 * nkWind;
      vNkT = 1.0;`);
    s.fragmentShader = 'uniform float nkGlow;\nvarying float vNkT;\n' + s.fragmentShader;
    glowFragment(s, 6);
  };
  leaves.customProgramCacheKey = () => 'nature-leaves';
  const crowns = { ...P, cards: Math.round(P.cards * Math.min(1, world.quality + 0.2)) }; // lighter crowns on phones
  const variants = [0, 1, 2].map((v) => treeGeometry(crowns, seed * 31 + v * 977 + kind.length));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), y = new THREE.Vector3(0, 1, 0);
  variants.forEach((g, v) => {
    const mine = spots.filter((_, i) => i % 3 === v);
    if (!mine.length) return;
    const meshes = [new THREE.InstancedMesh(g.wood, wood, mine.length), new THREE.InstancedMesh(g.leaves, leaves, mine.length)];
    mine.forEach(([x, z], i) => {
      q.setFromAxisAngle(y, r() * Math.PI * 2);
      m.compose(new THREE.Vector3(x, land.heightAt(x, z) - 0.15, z), q, s.setScalar(size * (0.8 + 0.4 * r())));
      for (const mesh of meshes) mesh.setMatrixAt(i, m);
    });
    for (const mesh of meshes) { mesh.castShadow = mesh.receiveShadow = true; mesh.userData.nature = true; mesh.computeBoundingSphere(); group.add(mesh); }
  });
  group.userData.nature = true;
  world.sky.parent.add(group);
  return { mesh: group, at: spots };
}

// random spots on the land: in `where`, not steep, dry, not in a flattened clearing, apart; in groups if asked
function place(land, { count, where, spacing, groups }, r) {
  const out = [], half = land.half - 4;
  for (let tries = 0; tries < count * 60 && out.length < count; tries++) {
    const x = (r() * 2 - 1) * half, z = (r() * 2 - 1) * half;
    if (groups && r() > smooth(0.38, 0.62, fbm(x / 45 + 9.1, z / 45 + 3.7, 3))) continue;
    if ((where && !where(x, z)) || land.normalAt(x, z).y < 0.8 || land.heightAt(x, z) < land.level + 0.4) continue;
    if (land.flat.some(([fx, fz, fr]) => Math.hypot(x - fx, z - fz) < fr)) continue;
    if (out.some(([a, b]) => (a - x) ** 2 + (b - z) ** 2 < spacing * spacing)) continue;
    out.push([x, z]);
  }
  return out;
}

function treeGeometry(P, seed) {
  const r = rng(seed), pick = ([a, b]) => a + (b - a) * r();
  const H = pick(P.height), R0 = P.girth * H, wood = tubes(), clusters = [];
  const lean = [(r() - 0.5) * P.lean * 2, (r() - 0.5) * P.lean * 2];
  const trunk = [];
  for (let i = 0; i <= 6; i++) { const t = i / 6; trunk.push(new THREE.Vector3(lean[0] * t * H + (r() - 0.5) * 0.15 * t, t * H, lean[1] * t * H + (r() - 0.5) * 0.15 * t)); }
  wood.add(trunk, (t) => R0 * (1 - 0.8 * t) * (1 + 0.6 * Math.pow(1 - t, 8)), 8);
  const n = Math.round(pick(P.boughs));
  for (let b = 0; b < n; b++) {
    const t0 = P.cone ? P.start + ((0.95 - P.start) * b) / n : P.start + (0.9 - P.start) * r();
    const from = along(trunk, t0), az = b * 2.39996 + r() * 0.6, el = pick(P.spread) * DEG;
    const dir = new THREE.Vector3(Math.sin(el) * Math.cos(az), Math.cos(el), Math.sin(el) * Math.sin(az));
    const len = H * P.reach * (P.cone ? (1.05 - t0) * 1.4 : 1 - (t0 - P.start) * 0.5) * (0.8 + 0.4 * r());
    const pts = [from];
    for (let i = 1; i <= 4; i++) { const t = i / 4, p = from.clone().addScaledVector(dir, len * t); p.y += (P.droop ? -P.droop : 0.15) * len * t * t; pts.push(p); }
    wood.add(pts, (t) => R0 * 0.5 * (1 - t0 * 0.7) * (1 - 0.85 * t), 5);
    const cr = H * P.crown * (0.8 + 0.4 * r());
    if (P.cone) for (let i = 1; i <= 3; i++) clusters.push([along(pts, i / 3), cr * (1.1 - t0 * 0.6)]);
    else clusters.push([pts[4], cr], [along(pts, 0.55), cr * 0.7]);
    for (let k = 0; k < P.twigs; k++) {
      const s = along(pts, 0.45 + 0.3 * r()), d = dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), (r() - 0.5) * 1.6).add(new THREE.Vector3(0, 0.5, 0)).normalize();
      const tw = [s, s.clone().addScaledVector(d, len * 0.25), s.clone().addScaledVector(d, len * 0.5)];
      wood.add(tw, (t) => R0 * 0.22 * (1 - 0.8 * t), 4);
      clusters.push([tw[2], cr * 0.75]);
    }
  }
  clusters.push([trunk[6], H * P.crown * (P.cone ? 0.6 : 1.1)]);
  return { wood: wood.geometry(), leaves: leafCards(clusters, P, r) };
}

const along = (pts, t) => { const f = t * (pts.length - 1), i = Math.min(Math.floor(f), pts.length - 2); return pts[i].clone().lerp(pts[i + 1], f - i); };

function tubes() {
  const pos = [], nor = [], uv = [], idx = [];
  return {
    add(pts, radius, sides) {
      const base = pos.length / 3, n = new THREE.Vector3(), b = new THREE.Vector3(), tan = new THREE.Vector3();
      let v = 0;
      pts.forEach((p, i) => {
        tan.subVectors(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]).normalize();
        if (!i && n.set(0, 0, 1).cross(tan).lengthSq() < 1e-6) n.set(1, 0, 0);
        n.addScaledVector(tan, -n.dot(tan)).normalize(); // carried along the curve without twisting
        b.crossVectors(tan, n);
        if (i) v += p.distanceTo(pts[i - 1]) / 1.5;
        const rad = radius(i / (pts.length - 1));
        for (let s = 0; s <= sides; s++) {
          const a = (s / sides) * Math.PI * 2, x = n.x * Math.cos(a) + b.x * Math.sin(a), y = n.y * Math.cos(a) + b.y * Math.sin(a), z = n.z * Math.cos(a) + b.z * Math.sin(a);
          pos.push(p.x + x * rad, p.y + y * rad, p.z + z * rad); nor.push(x, y, z); uv.push(s / sides, v);
        }
      });
      for (let i = 0; i < pts.length - 1; i++) for (let s = 0; s < sides; s++) {
        const a = base + i * (sides + 1) + s, c = a + sides + 1;
        idx.push(a, a + 1, c, a + 1, c + 1, c);
      }
    },
    geometry() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      return g;
    },
  };
}

function leafCards(clusters, P, r) {
  const pos = [], nor = [], col = [], uv = [], idx = [];
  const center = new THREE.Vector3(), d = new THREE.Vector3(), out = new THREE.Vector3(), corner = new THREE.Vector3(), q = new THREE.Quaternion(), e = new THREE.Euler();
  for (const [c] of clusters) center.add(c);
  center.divideScalar(clusters.length);
  const c0 = new THREE.Color(P.leaf[0]), c1 = new THREE.Color(P.leaf[1]), tint = new THREE.Color();
  const avg = clusters.reduce((s, [, R]) => s + R, 0) / clusters.length;
  for (const [c, R] of clusters) {
    const n = Math.round(P.cards * (R / avg) ** 2);
    for (let k = 0; k < n; k++) {
      d.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize();
      const dist = R * (0.3 + 0.7 * Math.sqrt(r())), p = c.clone().addScaledVector(d, dist);
      p.y = c.y + (p.y - c.y) * 0.75;
      out.subVectors(p, center).normalize().lerp(d, 0.5).normalize(); // shaded as one soft, round crown
      const shade = (0.55 + 0.45 * (dist / R)) * (0.8 + 0.2 * Math.max(0, out.y));
      tint.copy(c0).lerp(c1, r()).multiplyScalar(shade * (0.85 + 0.3 * r()));
      q.setFromEuler(e.set(r() * 6.28, r() * 6.28, r() * 6.28));
      const s = P.card * (0.7 + 0.6 * r()), base = pos.length / 3;
      for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        corner.set((a - 0.5) * s, (b - 0.5) * s, 0).applyQuaternion(q).add(p);
        pos.push(corner.x, corner.y, corner.z); nor.push(out.x, out.y, out.z); col.push(tint.r, tint.g, tint.b); uv.push(a, b);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), rng(w * 31 + h));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function leafTexture(P) {
  return canvasTexture(128, 128, (g, r) => {
    if (P.cone) { // needles
      g.lineCap = 'round';
      for (let i = 0; i < 70; i++) {
        const a = r() * Math.PI * 2, l = 20 + r() * 34, x = 64 + (r() - 0.5) * 30, y = 64 + (r() - 0.5) * 30;
        g.strokeStyle = `hsl(0,0%,${65 + r() * 35}%)`; g.lineWidth = 1.6 + r();
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
      }
      return;
    }
    for (let i = 0; i < 22; i++) { // a spray of leaves
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 40, L = 20 + r() * 16, W = 7 + r() * 5;
      g.save(); g.translate(64 + Math.cos(a) * d, 64 + Math.sin(a) * d); g.rotate(r() * Math.PI * 2);
      g.fillStyle = `hsl(0,0%,${68 + r() * 32}%)`;
      g.beginPath(); g.moveTo(0, -L / 2); g.quadraticCurveTo(W, 0, 0, L / 2); g.quadraticCurveTo(-W, 0, 0, -L / 2); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, -L / 2); g.lineTo(0, L / 2); g.stroke();
      g.restore();
    }
  });
}

function barkTexture(P) {
  return canvasTexture(64, 128, (g, r) => {
    g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 128);
    if (P.birch) { // dark dashes across white bark
      for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(30,25,20,${0.4 + r() * 0.5})`; g.fillRect(r() * 64, r() * 128, 4 + r() * 14, 1 + r() * 2.5); }
      return;
    }
    for (let i = 0; i < 26; i++) { g.fillStyle = `rgba(0,0,0,${0.12 + r() * 0.3})`; g.fillRect(r() * 64, 0, 1 + r() * 3, 128); } // furrows
  });
}

// ---------- rocks ----------
function makeRocks(world, land, { count = 20, size = 1, color = '#8b8478', moss = '#5d6b34', where, at, seed = 3 } = {}) {
  const r = rng(seed * 4099), spots = at ?? place(land, { count, where, spacing: 2.5 * size }, r);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 });
  const base = new THREE.Color(color), green = new THREE.Color(moss), c = new THREE.Color();
  const group = new THREE.Group();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3();
  [0, 1, 2].forEach((v) => {
    const mine = spots.filter((_, i) => i % 3 === v);
    if (!mine.length) return;
    const g = mergeVertices(new THREE.IcosahedronGeometry(1, 4).deleteAttribute('normal').deleteAttribute('uv'));
    const p = g.attributes.position, o = v * 13.7;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = 1 + (fbm(x * 1.1 + o, z * 1.1 + y * 0.8 + o, 4) - 0.5) * 0.7;
      p.setXYZ(i, x * k * 1.1, Math.max(y * k * 0.62, -0.35), z * k * 0.9);
    }
    g.computeVertexNormals();
    const n = g.attributes.normal, cols = [];
    for (let i = 0; i < p.count; i++) {
      c.copy(base).multiplyScalar(0.75 + 0.35 * noise(p.getX(i) * 3 + o, p.getZ(i) * 3)).lerp(green, smooth(0.6, 0.95, n.getY(i)) * (0.2 + 0.5 * noise(p.getX(i) * 2, p.getZ(i) * 2 + o)));
      if (p.getY(i) < -0.15) c.multiplyScalar(0.7);
      cols.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const mesh = new THREE.InstancedMesh(g, mat, mine.length);
    mine.forEach(([x, z], i) => {
      const k = size * (0.4 + 1.2 * r() * r());
      q.setFromEuler(e.set((r() - 0.5) * 0.3, r() * 6.28, (r() - 0.5) * 0.3));
      m.compose(s.set(x, land.heightAt(x, z) - 0.12 * k, z), q, new THREE.Vector3(k, k, k));
      mesh.setMatrixAt(i, m);
    });
    mesh.castShadow = mesh.receiveShadow = true; mesh.userData.nature = true; mesh.computeBoundingSphere();
    group.add(mesh);
  });
  world.sky.parent.add(group);
  return { mesh: group, at: spots };
}

// ---------- water: reflections of the world and sky, depth tint, sun glints ----------
function makeWater(world, land, { level = 0, color = '#4c8a7c', deep = '#13474f' } = {}) {
  land.level = level;
  land.u.nkLevel.value = level;
  const sky = world.sky.material.uniforms, mirror = world.quality >= 0.5;
  const shader = {
    name: 'NatureWater',
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { tDiffuse: { value: null }, color: { value: null }, textureMatrix: { value: new THREE.Matrix4() }, uShallow: { value: new THREE.Color(color) }, uDeep: { value: new THREE.Color(deep) }, uLevel: { value: level } }]),
    vertexShader: /* glsl */ `
      uniform mat4 textureMatrix;
      varying vec3 vNkWorld; varying vec4 vRefl;
      #include <fog_pars_vertex>
      void main() {
        vRefl = textureMatrix * vec4( position, 1.0 );
        vNkWorld = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
        vec4 mvPosition = viewMatrix * vec4( vNkWorld, 1.0 );
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform vec3 uShallow, uDeep, uZenith, uMid, uHorizon, uHaze, uGlow, uSun, uSunColor; uniform float uLevel;
      varying vec3 vNkWorld; varying vec4 vRefl;
      ${NK}
      ${LAND}
      #include <fog_pars_fragment>
      void main() {
        vec2 p = vNkWorld.xz, g = vec2( 0.0 );
        for ( int i = 0; i < 7; i++ ) { // small waves from all around
          float a = float( i ) * 2.399, f = 0.7 + float( i ) * 0.6;
          vec2 d = vec2( cos( a ), sin( a ) );
          g += d * cos( dot( p, d ) * f + nkTime * ( 1.1 + float( i ) * 0.35 ) ) * 0.09 / ( 1.0 + float( i ) * 0.5 );
        }
        vec3 n = normalize( vec3( - g.x, 1.0, - g.y ) ), v = normalize( cameraPosition - vNkWorld ), rf = reflect( - v, n );
        rf.y = abs( rf.y );
        float c = max( dot( rf, uSun ), 0.0 ), h = clamp( rf.y, 0.0, 1.0 );
        vec3 sky = mix( mix( uHorizon, uMid, smoothstep( 0.0, 0.16, h ) ), uZenith, smoothstep( 0.1, 0.7, h ) );
        sky = mix( uHaze + uGlow * ( 0.3 * pow( c, 4.0 ) + 0.25 * pow( c, 14.0 ) + 0.25 * pow( c, 48.0 ) ), sky, smoothstep( -0.02, 0.14, rf.y ) );
        #ifdef NK_MIRROR
          vec4 uv = vRefl; uv.xy += g * 0.35 * uv.w / ( 1.0 + 0.05 * length( cameraPosition - vNkWorld ) );
          vec3 refl = texture2DProj( tDiffuse, uv ).rgb;
        #else
          vec3 refl = sky + uSunColor * pow( c, 900.0 ) * 12.0;
        #endif
        float ground = mix( uLevel - 4.0, texture( nkLand, nkLandUv( p ) ).r, nkInside( p ) ), depth = max( uLevel - ground, 0.0 );
        vec3 body = mix( uShallow, uDeep, 1.0 - exp( - depth * 0.5 ) ) * ( 0.25 + 0.6 * uSunColor * max( uSun.y, 0.15 ) );
        float fres = 0.3 + 0.7 * pow( 1.0 - max( dot( n, v ), 0.0 ), 4.0 );
        vec3 col = mix( body, refl, fres ) + uSunColor * pow( c, 600.0 ) * 4.0;
        gl_FragColor = vec4( col, smoothstep( 0.0, 0.5, depth ) * 0.88 + fres * 0.12 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  };
  const geo = new THREE.PlaneGeometry(land.size * 3.2, land.size * 3.2);
  const water = mirror ? new Reflector(geo, { shader, textureWidth: 1024, textureHeight: 512, multisample: 0, clipBias: 0.003 }) : new THREE.Mesh(geo, new THREE.ShaderMaterial(shader));
  const mat = water.material;
  Object.assign(mat, { transparent: true, fog: true });
  if (mirror) mat.defines = { NK_MIRROR: '' };
  for (const k of ['uZenith', 'uMid', 'uHorizon', 'uHaze', 'uGlow', 'uSun', 'uSunColor']) mat.uniforms[k] = sky[k];
  Object.assign(mat.uniforms, land.u);
  water.rotation.x = -Math.PI / 2;
  water.position.y = level;
  water.userData.nature = true;
  world.sky.parent.add(water);
  return water;
}

// ---------- motes: pollen (or fireflies) drifting around the camera, sparkling toward the sun ----------
function makeMotes(world, scene, { count = 700, color = '#ffe2a8', size = 1 } = {}) {
  const r = rng(11), seeds = new Float32Array(count * 3).map(() => r());
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
  const mat = new THREE.ShaderMaterial({
    name: 'NatureMotes', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { nkTime: world.uniforms.time, uColor: { value: new THREE.Color(color) }, uSun: { value: world.sunDir }, uSize: { value: size * world.composer.renderer.getPixelRatio() } },
    vertexShader: /* glsl */ `
      uniform float nkTime, uSize; uniform vec3 uSun; varying float vA;
      void main() {
        vec3 box = vec3( 40.0, 8.0, 40.0 ), s = position;
        vec3 p = s * box + vec3( sin( nkTime * 0.2 + s.y * 20.0 ) * 2.0 + nkTime * 0.3, sin( nkTime * 0.5 + s.x * 30.0 ) * 0.6, cos( nkTime * 0.17 + s.z * 20.0 ) * 2.0 + nkTime * 0.1 );
        vec3 o = cameraPosition - box * vec3( 0.5, 0.3, 0.5 );
        p = o + mod( p - o, box );
        vec4 mv = viewMatrix * vec4( p, 1.0 );
        gl_Position = projectionMatrix * mv;
        float d = - mv.z;
        vA = ( 0.35 + 1.8 * pow( max( dot( normalize( p - cameraPosition ), uSun ), 0.0 ), 6.0 ) ) * smoothstep( 0.5, 2.0, d ) * ( 1.0 - smoothstep( 12.0, 20.0, d ) ) * ( 0.6 + 0.4 * sin( nkTime * 2.0 + s.x * 50.0 ) );
        gl_PointSize = uSize * ( 1.0 + 1.5 * fract( s.z * 13.7 ) ) * clamp( 6.0 / d, 0.7, 2.5 );
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; varying float vA;
      void main() { float a = vA * smoothstep( 0.5, 0.1, length( gl_PointCoord - 0.5 ) ); gl_FragColor = vec4( uColor * a, a ); }`,
  });
  const points = new THREE.Points(g, mat);
  points.frustumCulled = false; points.userData.nature = true; points.layers.set(PLANTS);
  scene.add(points);
  return points;
}
