// paint.js v2 — painterly watercolour look for three.js r186 (storybook key art). Self-contained ES module.
//   import { createPainter, paint, skyMesh, clumps, scatter } from './orb/paint.js';
//   renderer: toneMapping = THREE.NoToneMapping, setClearColor(0x000000, 0), setPixelRatio(Math.min(devicePixelRatio, 1.25))
//   const painter = createPainter(renderer, scene, camera); // on resize painter.setSize(w, h); each frame painter.render(t), not renderer.render
//   scene.add(skyMesh('night'));     // or 'day', or { preset, top, bottom, wash, haze, stars, grain }: watercolour sky; stars only when stars > 0
//   paint('#93a63c', { color2: '#62762a' })  // material for EVERY surface: MeshStandardMaterial + brush dabs
//                                            // (opts: scale ≈ 12 / object size, grain, mottle, rim, vertexColors, any material params)
//   clumps({ color, color2, count: 12, radius: 0.5, size: 0.18 }) // Mesh: blob cluster = foliage, bush; clouds/smoke: lumpy: 0.1, flat: 0.45
//   scatter(groundMesh, 'tuft' | 'flower' | 'pebble' | geometry, 2000, { size: 0.05, where: (p, n) => n.y > 0.6, colors })
//                                            // InstancedMesh of small detail on the mesh's surface, added as its child
// Taste rules (each mattered more than any shader setting):
// 1. Stage it like an illustration: camera 35-45° down on a compact scene, subject a little off-centre, sky all around.
// 2. Hero props big and upright: a character ~0.5x the ground's radius; on curved ground lean props only ~30% toward the
//    normal and stretch them ~1.2x in y (cancels the look-down foreshortening).
// 3. Dense small detail everywhere: thousands of tufts, dozens of flowers and pebbles, moss/rock patches in vertex colours.
// 4. Organic = clusters, never one sphere: trees, bushes, clouds, smoke are clumps(). Smoke = a thin wavy stem of small
//    puffs rising in world space, growing and billowing out on top.
// 5. Hard shapes from profiles: volcano, hill, pot, tower = LatheGeometry with concave flanks and a lip, noise ridges,
//    vertex colours by height (orange crater rim, pale flanks).
// 6. Every paint() gets a color2 (darker/cooler or lighter/warmer twin); flat colour reads as plastic.
// 7. One warm key DirectionalLight (~3, upper left) + cool HemisphereLight (~1.3); muted palette, 1-2 saturated accents.
//    No bloom, no dark outlines, no extra post: the painter adds paper seams, canvas grain, grade and vignette.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';

// ---------- noise (GLSL + JS twins) ----------
export const NOISE = /* glsl */ `
float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float hash12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s / 0.9375; }
`;
const hash3 = (x, y, z) => { let h = (x * 374761393 + y * 668265263 + z * 1274126177) | 0; h = Math.imul(h ^ (h >>> 13), 1103515245); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
export function noise3(x, y, z) { // smooth value noise in [0, 1]
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), l = (a, b, t) => a + (b - a) * t, h = (a, b, c) => hash3(xi + a, yi + b, zi + c);
  let u = x - xi, v = y - yi, w = z - zi; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v); w = w * w * (3 - 2 * w);
  return l(l(l(h(0, 0, 0), h(1, 0, 0), u), l(h(0, 1, 0), h(1, 1, 0), u), v), l(l(h(0, 0, 1), h(1, 0, 1), u), l(h(0, 1, 1), h(1, 1, 1), u), v), w);
}
export function fbm3(x, y, z, oct = 4) { let s = 0, a = 0.5, n = 0; for (let i = 0; i < oct; i++) { s += a * noise3(x, y, z); n += a; x = x * 2.03 + 17.1; y = y * 2.03 + 5.3; z = z * 2.03 + 9.7; a *= 0.5; } return s / n; }
export const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export function rng(seed = 1) { // seeded Math.random replacement
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------- painted material: albedo mottled toward color2 + warped-cell dabs (each its own tone and temperature) ----------
export function paint(color, { color2, scale = 12, mottle = 0.5, grain = 0.45, rim = 0, rimColor = '#ffd7a0', ...params } = {}) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, ...params });
  const a = new THREE.Color(color), b = new THREE.Color(color2 ?? color);
  const u = {
    uTint: { value: new THREE.Vector3(b.r / Math.max(a.r, 1e-3), b.g / Math.max(a.g, 1e-3), b.b / Math.max(a.b, 1e-3)) },
    uScale: { value: scale }, uMottle: { value: mottle }, uGrain: { value: grain }, uRim: { value: new THREE.Color(rimColor).multiplyScalar(rim) },
  };
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, u);
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vPaint;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vPaint = position;
        #ifdef USE_INSTANCING
          vPaint = (instanceMatrix * vec4(position, 1.0)).xyz;
        #endif`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPaint;\nuniform vec3 uTint, uRim;\nuniform float uScale, uMottle, uGrain;\n' + NOISE)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 pp = vPaint * uScale;
        diffuseColor.rgb *= mix(vec3(1.0), uTint, smoothstep(0.3, 0.72, fbm(pp)) * uMottle);
        vec3 cp = pp * 3.5 + 1.6 * vec3(vnoise(pp * 1.2), vnoise(pp * 1.2 + 7.0), vnoise(pp * 1.2 + 13.0));
        float dab = hash13(floor(cp)), hue = hash13(floor(cp) + 19.7);
        diffuseColor.rgb *= (1.0 + uGrain * (0.7 * dab + 0.3 * vnoise(pp * 5.0) - 0.5)) * mix(vec3(1.0), mix(vec3(0.9, 0.93, 1.1), vec3(1.07, 1.0, 0.9), hue), uGrain * 0.8);`)
      .replace('#include <opaque_fragment>', `outgoingLight += uRim * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
        #include <opaque_fragment>`);
  };
  m.userData.paint = u;
  return m;
}

// ---------- watercolour sky: baked once per size, screen space, alpha 0 marks "sky" for the stars ----------
export const SKIES = {
  night: { top: '#081530', bottom: '#081530', wash: '#172b52', washAmount: 1, haze: '#6a6a6e', stars: 1, paper: 0.6, grain: 0.28 },
  day: { top: '#3f78c4', bottom: '#cfe2ee', wash: '#ffffff', washAmount: 0.7, haze: '#fff1d6', stars: 0, paper: 0.3, grain: 0.1 },
};
const skyState = { stars: { value: 0 }, paper: { value: 0.3 } }; // the wash pass reads these
export function skyMesh(opts = 'night') {
  const o = typeof opts === 'string' ? SKIES[opts] : { ...SKIES[opts.preset ?? 'night'], ...opts };
  if (opts.deep) o.top = o.bottom = opts.deep; if (opts.navy) o.wash = opts.navy; // v1 keys
  const srgb = (h) => new THREE.Color(h).convertLinearToSRGB(); // shader mixes in sRGB, converts at the end
  const bakeMat = new THREE.ShaderMaterial({
    uniforms: { uRes: { value: new THREE.Vector2(1, 1) }, uTop: { value: srgb(o.top) }, uBottom: { value: srgb(o.bottom) }, uWash: { value: srgb(o.wash) }, uHaze: { value: srgb(o.haze) }, uAmt: { value: o.washAmount }, uGrain: { value: o.grain } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */ `
      uniform vec2 uRes; uniform vec3 uTop, uBottom, uWash, uHaze; uniform float uAmt, uGrain; varying vec2 vUv;
      ${NOISE}
      void main() {
        vec2 p = gl_FragCoord.xy / uRes.y;
        float big = fbm(vec3(p * 2.2, 1.7)), mid = fbm(vec3(p * 6.0 + big * 2.0, 4.2));
        float t = smoothstep(0.4, 0.6, big) * 0.6 + smoothstep(0.5, 0.56, mid) * 0.3;     // washes with hard-ish bloom edges
        vec3 col = mix(mix(uBottom, uTop, smoothstep(0.0, 0.9, vUv.y)), uWash, t * uAmt);
        vec2 nq = (vUv - vec2(0.0, 1.0)) * vec2(1.6, 2.0);                                  // mottled haze / sun glow, top-left
        col = mix(col, uHaze, 0.7 * exp(-dot(nq, nq) * 3.2) * smoothstep(0.42, 0.62, fbm(vec3(p * 5.0, 8.0)) + 0.1 * big));
        vec2 fp = gl_FragCoord.xy / (uRes.y / 800.0), cp = fp / 9.0 + 1.5 * vec2(vnoise(vec3(fp / 11.0, 2.0)), vnoise(vec3(fp / 11.0, 5.0)));
        col *= 1.0 + uGrain * (0.65 * hash12(floor(cp)) + 0.35 * vnoise(vec3(fp / 3.0, 9.1)) - 0.5);  // dab cells + grain
        gl_FragColor = vec4(pow(col, vec3(2.2)), 0.0);
      }`,
  });
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }), bake = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bakeMat), cam = new THREE.Camera();
  bake.frustumCulled = false;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false, uniforms: { tSky: { value: rt.texture } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D tSky; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(tSky, vUv).rgb, 0.0); }',
  }));
  m.frustumCulled = false; m.renderOrder = -1000; m.userData.bake = bakeMat;
  const size = new THREE.Vector2();
  m.onBeforeRender = (r) => { // (re)bake when the drawing buffer size changes; tell the wash about stars and paper
    skyState.stars.value = o.stars; skyState.paper.value = o.paper;
    r.getDrawingBufferSize(size);
    if (size.equals(bakeMat.uniforms.uRes.value)) return;
    bakeMat.uniforms.uRes.value.copy(size); rt.setSize(size.x, size.y);
    const prev = r.getRenderTarget(); r.setRenderTarget(rt); r.render(bake, cam); r.setRenderTarget(prev);
  };
  return m;
}

// ---------- clumps: a cluster of lumpy painted blobs (foliage, bushes, clouds, smoke puffs) ----------
export function clumps({ count = 10, radius = 0.5, size = 0.18, flat = 0.7, lumpy = 0.3, seed = 1, color = '#5f8c35', color2, ...opts } = {}) {
  const r = rng(seed), v = new THREE.Vector3(), parts = [], room = Math.max(0, radius - size);
  for (let i = 0; i < count; i++) {
    const s = size * (0.65 + 0.35 * r());
    let g = new THREE.IcosahedronGeometry(s, 3); g.deleteAttribute('normal'); g.deleteAttribute('uv'); g = mergeVertices(g);
    const p = g.attributes.position;
    for (let k = 0; k < p.count; k++) { v.fromBufferAttribute(p, k); v.multiplyScalar(1 + (noise3((v.x * 4) / s + i * 7, (v.y * 4) / s, (v.z * 4) / s) - 0.5) * 2 * lumpy); p.setXYZ(k, v.x, v.y, v.z); }
    const a = r() * 6.283, d = Math.sqrt(r()) * room;
    g.translate(Math.cos(a) * d, (r() * 2 - 1) * room * flat * 0.6, Math.sin(a) * d);
    g.computeVertexNormals(); parts.push(g);
  }
  const lit = new THREE.Color(color).offsetHSL(0.04, 0.05, 0.15);
  const m = new THREE.Mesh(mergeGeometries(parts), paint(color, { color2: color2 ?? lit, scale: 2 / size, mottle: 0.8, grain: 0.5, rim: 0.25, ...opts }));
  m.castShadow = m.receiveShadow = true;
  return m;
}

// ---------- scatter: instanced small detail sampled on a mesh surface ----------
const tint = (g, hex) => { const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) c.toArray(a, i * 3); g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; };
const SHAPES = { // unit-sized: scaled by opts.size
  tuft: () => mergeGeometries([0, 1, 2, 3].map((i) => new THREE.ConeGeometry(0.09, 1, 3).translate(0, 0.5, 0).rotateZ(0.25 + i * 0.12).rotateY(i * 1.7))),
  pebble: () => new THREE.DodecahedronGeometry(0.5, 1).scale(1, 0.55, 0.8),
  flower: () => {
    const sh = new THREE.Shape();
    for (let i = 0; i <= 48; i++) { const a = (i / 48) * Math.PI * 2, r = 0.5 * (0.35 + 0.65 * Math.sqrt(Math.abs(Math.cos(a * 4)))); if (i) sh.lineTo(Math.cos(a) * r, Math.sin(a) * r); else sh.moveTo(r, 0); }
    return mergeGeometries([tint(new THREE.ShapeGeometry(sh).rotateX(-Math.PI / 2).translate(0, 0.25, 0), '#fffaf0'),
      tint(new THREE.SphereGeometry(0.15, 8, 6).scale(1, 0.6, 1).translate(0, 0.3, 0), '#f2c23a')]);
  },
};
const SHAPE_COLORS = { tuft: ['#55782f', '#6c8f36', '#93a845', '#c4bf5c'], pebble: ['#b8aea4', '#9a928c', '#c9c0b4'], flower: ['#ffffff'] };
export function scatter(surface, what, count, { size = 0.05, jitter = 0.6, where = () => true, colors, align = 1, material, seed = 1 } = {}) {
  const flower = what === 'flower', geo = typeof what === 'string' ? SHAPES[what]() : what;
  const cols = (colors ?? SHAPE_COLORS[what] ?? ['#ffffff']).map((c) => new THREE.Color(c));
  const im = new THREE.InstancedMesh(geo, material ?? paint('#ffffff', { scale: 0.6 / size, grain: 0.3, mottle: 0.3, vertexColors: flower,
    side: flower ? THREE.DoubleSide : THREE.FrontSide, emissive: flower ? '#3a3328' : '#000000' }), count);
  const rnd = rng(seed), sampler = new MeshSurfaceSampler(surface).setRandomGenerator(rng(seed + 1)).build();
  const p = new THREE.Vector3(), n = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), o = new THREE.Object3D();
  let k = 0;
  for (let tries = 0; k < count && tries < count * 40; tries++) {
    sampler.sample(p, n);
    if (!where(p, n)) continue;
    o.position.copy(p);
    o.quaternion.setFromUnitVectors(up, n.lerp(up, 1 - align).normalize());
    o.rotateY(rnd() * 6.283);
    o.scale.setScalar(size * (1 - jitter / 2 + rnd() * jitter));
    o.updateMatrix(); im.setMatrixAt(k, o.matrix); im.setColorAt(k++, cols[(rnd() * cols.length) | 0]);
  }
  im.count = k; im.receiveShadow = true;
  surface.add(im);
  return im;
}

// ---------- post: generalized Kuwahara (8 sectors, polynomial weights, packed in two vec4 lanes) ----------
const quadVS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
export const KuwaharaShader = {
  name: 'Kuwahara',
  uniforms: { tDiffuse: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uR: { value: 2 }, uStep: { value: 1.5 }, uHard: { value: 8 }, uSharp: { value: 8 }, uWarp: { value: 2.0 } },
  vertexShader: quadVS,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform vec2 uRes; uniform int uR; uniform float uStep, uHard, uSharp, uWarp; varying vec2 vUv;
    ${NOISE}
    void main() {
      vec2 px = 1.0 / uRes, fc = vUv * uRes;
      vec2 uv = vUv + (vec2(vnoise(vec3(fc * 0.07, 1.3)), vnoise(vec3(fc * 0.07, 7.9))) - 0.5) * uWarp * px;  // wobbly edges
      vec4 wA = vec4(0.0), rA = wA, gA = wA, bA = wA, rrA = wA, ggA = wA, bbA = wA;   // A = sectors 0,2,4,6; B = 1,3,5,7
      vec4 wB = wA, rB = wA, gB = wA, bB = wA, rrB = wA, ggB = wA, bbB = wA;
      float zeta = 1.0 / float(uR), sz = sin(0.58), eta = (zeta + cos(0.58)) / (sz * sz);
      for (int j = -uR; j <= uR; j++) for (int i = -uR; i <= uR; i++) {   // uniform bounds: no unrolling
        vec2 v = vec2(float(i), float(j)) * (0.5 / float(uR));
        if (dot(v, v) > 0.25) continue;
        vec3 c = texture2D(tDiffuse, uv + vec2(float(i), float(j)) * uStep * px).rgb;
        vec2 q = 0.70710678 * vec2(v.x - v.y, v.x + v.y);
        float vxx = zeta - eta * v.x * v.x, vyy = zeta - eta * v.y * v.y, qxx = zeta - eta * q.x * q.x, qyy = zeta - eta * q.y * q.y;
        vec4 za = max(vec4(0.0), vec4(v.y + vxx, -v.x + vyy, -v.y + vxx, v.x + vyy));
        vec4 zb = max(vec4(0.0), vec4(q.y + qxx, -q.x + qyy, -q.y + qxx, q.x + qyy));
        za *= za; zb *= zb;
        float g = exp(-3.125 * dot(v, v)) / max(dot(za + zb, vec4(1.0)), 1e-5);
        za *= g; zb *= g;
        wA += za; rA += c.r * za; gA += c.g * za; bA += c.b * za; rrA += c.r * c.r * za; ggA += c.g * c.g * za; bbA += c.b * c.b * za;
        wB += zb; rB += c.r * zb; gB += c.g * zb; bB += c.b * zb; rrB += c.r * c.r * zb; ggB += c.g * c.g * zb; bbB += c.b * c.b * zb;
      }
      wA = max(wA, 1e-5); wB = max(wB, 1e-5);
      rA /= wA; gA /= wA; bA /= wA; rB /= wB; gB /= wB; bB /= wB;
      vec4 varA = abs(rrA / wA - rA * rA) + abs(ggA / wA - gA * gA) + abs(bbA / wA - bA * bA);
      vec4 varB = abs(rrB / wB - rB * rB) + abs(ggB / wB - gB * gB) + abs(bbB / wB - bB * bB);
      vec4 kA = 1.0 / (1.0 + pow(min(uHard * 1000.0 * varA, vec4(1e4)), vec4(0.5 * uSharp)));   // calm sectors win (clamped: no black spots)
      vec4 kB = 1.0 / (1.0 + pow(min(uHard * 1000.0 * varB, vec4(1e4)), vec4(0.5 * uSharp)));
      vec3 o = vec3(dot(rA, kA) + dot(rB, kB), dot(gA, kA) + dot(gB, kB), dot(bA, kA) + dot(bB, kB));
      gl_FragColor = vec4(o / max(dot(kA + kB, vec4(1.0)), 1e-30), texture2D(tDiffuse, vUv).a);
    }`,
};

// ---------- post: wash (split-tone grade, light paper seams between dabs, canvas grain, stars on the sky, vignette) ----------
export const WashShader = {
  name: 'Wash',
  uniforms: {
    tDiffuse: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 },
    uPaper: { value: 0.22 }, uPaperSky: { value: 0.6 }, uSeam: { value: 0.3 }, uVignette: { value: 0.45 }, uStars: { value: 1 }, uGrade: { value: 0.5 },
  },
  vertexShader: quadVS,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform vec2 uRes; uniform float uTime, uPaper, uPaperSky, uSeam, uVignette, uStars, uGrade; varying vec2 vUv;
    ${NOISE}
    float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    vec3 stars(vec2 fc) {
      vec3 acc = vec3(0.0);
      float cell = uRes.y / 8.0, k = uRes.y / 800.0;
      vec2 p = fc / cell, ip = floor(p);
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        vec2 c = ip + vec2(float(x), float(y));
        float h = hash12(c * 1.37 + 0.71);
        if (h > 0.6) continue;
        vec2 d = (p - (c + 0.15 + 0.7 * vec2(hash12(c + 3.1), hash12(c + 7.7)))) * cell;
        bool big = hash12(c + 5.5) > 0.42;
        float sz = (big ? mix(10.0, 20.0, pow(hash12(c + 9.1), 1.5)) : mix(1.2, 2.4, hash12(c + 9.1))) * k;
        float tw = 0.75 + 0.25 * sin(uTime * (0.7 + 2.0 * h) + h * 50.0);
        vec2 a = abs(d) / sz; float r = length(d) / sz;
        float spark = big ? pow(max(0.0, 1.0 - sqrt(a.x) - sqrt(a.y)), 1.6) * 3.2 : 0.0;   // 4-point sparkle
        acc += vec3(1.0, 0.8, 0.44) * (spark + exp(-r * r * (big ? 30.0 : 3.0)) * (big ? 0.9 : 1.1) + exp(-r * (big ? 2.5 : 1.2)) * (big ? 0.25 : 0.2)) * tw;
      }
      vec2 q = fc / (5.0 * k), iq = floor(q);                       // dust of faint tiny stars
      if (hash12(iq + 0.3) > 0.992) { vec2 dp = (q - iq - 0.5) * 5.0; acc += vec3(0.9, 0.85, 0.7) * exp(-dot(dp, dp) * 0.9) * 0.45; }
      return acc;
    }
    void main() {
      vec2 px = 1.0 / uRes, fc = vUv * uRes;
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 col = src.rgb;
      float gx = lum(texture2D(tDiffuse, vUv + vec2(px.x, 0.0)).rgb) - lum(texture2D(tDiffuse, vUv - vec2(px.x, 0.0)).rgb);
      float gy = lum(texture2D(tDiffuse, vUv + vec2(0.0, px.y)).rgb) - lum(texture2D(tDiffuse, vUv - vec2(0.0, px.y)).rgb);
      float sky = 1.0 - smoothstep(0.0, 0.5, src.a), l = lum(col);
      col *= mix(vec3(1.0), mix(vec3(0.93, 0.94, 1.07), vec3(1.08, 1.0, 0.86), smoothstep(0.25, 0.75, l)), uGrade * (1.0 - sky));   // golden lights, lilac shadows
      col = mix(col, vec3(0.98, 0.94, 0.86), uSeam * (1.0 - 0.7 * sky) * smoothstep(0.012, 0.09, length(vec2(gx, gy))));  // paper shows between dabs
      float k = uRes.y / 800.0;
      vec2 rc = mat2(0.87, 0.5, -0.5, 0.87) * (fc / k);                                    // canvas: two crossing diagonal fibres
      float fib = 0.6 * vnoise(vec3(rc.x * 0.08, rc.y * 0.7, 4.0)) + 0.4 * vnoise(vec3(rc.y * 0.08, rc.x * 0.7, 7.0));
      float paper = 0.4 * fib + 0.35 * vnoise(vec3(fc / (1.8 * k), 1.0)) + 0.25 * vnoise(vec3(fc / (6.0 * k), 2.0));
      col *= 1.0 - (uPaper + sky * uPaperSky) * (paper - 0.5) * (1.3 - lum(col));
      col += sky * stars(fc) * uStars;
      vec2 q = vUv - 0.5;
      col *= 1.0 - uVignette * dot(q, q) * 1.6;
      gl_FragColor = vec4(col, 1.0);                                                         // alpha 1: never composite with the page
    }`,
};

// radius = brush footprint in px at 800 px screen height; taps `step` px apart (<= 49 taps on any screen)
export function createPainter(renderer, scene, camera, { radius = 3, step = 1.5 } = {}) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass()); // sRGB first: paint in display space (alpha kept = sky mask)
  const kuwahara = new ShaderPass(KuwaharaShader), wash = new ShaderPass(WashShader);
  wash.uniforms.uStars = skyState.stars; wash.uniforms.uPaperSky = skyState.paper; // set by skyMesh each frame
  composer.addPass(kuwahara); composer.addPass(wash);
  const painter = {
    composer, kuwahara, wash,
    setSize(w, h) {
      composer.setSize(w, h);
      const pr = renderer.getPixelRatio(), px = (radius * h * pr) / 800;
      for (const p of [kuwahara, wash]) p.uniforms.uRes.value.set(w * pr, h * pr);
      kuwahara.uniforms.uR.value = Math.min(4, Math.max(1, Math.round(px / step)));
      kuwahara.uniforms.uStep.value = px / kuwahara.uniforms.uR.value;
    },
    render(t = 0) { wash.uniforms.uTime.value = t; composer.render(); },
  };
  const size = renderer.getSize(new THREE.Vector2());
  painter.setSize(size.x, size.y); // sized from the start: unsized, every tap lands on the screen's edges
  return painter;
}
