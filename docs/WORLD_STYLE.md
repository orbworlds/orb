# How an Orb world is made (style & craft guide)

Shared by the hand-made templates and the AI system prompt. The bar: someone opens the link and
says "wow" within one second, on a phone or a laptop.

## Format
- One self-contained HTML document. No build step, no local assets. Everything procedural
  (geometry, textures via canvas, sound via WebAudio).
- Libraries only from jsDelivr, pinned. Default stack is three.js via an import map:
  ```html
  <script type="importmap">{"imports":{
    "three":"https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js",
    "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/"}}</script>
  <script type="module"> import * as THREE from 'three'; … </script>
  ```
  2D worlds may use plain Canvas 2D. Other libraries are fine when they clearly help.
- Structure the code in clearly commented sections so later edits can find them:
  `// === CONFIG ===`, `// === SCENE ===`, `// === SKY & LIGHT ===`, `// === WORLD ===`,
  `// === PLAYER / CONTROLS ===`, `// === UI ===`, `// === LOOP ===`.
  Keep tweakable values (colors, speeds, counts) in a `CONFIG` object at the top.
- Size: a template is 250–700 lines. Prefer clarity over cleverness.

## Look
- Renderer: `antialias: true`, `outputColorSpace = SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping`
  (exposure ~1.0–1.2), `setPixelRatio(Math.min(devicePixelRatio, 2))`, soft shadows
  (`PCFShadowMap` with `shadow.radius`/`blurSamples` or `VSMShadowMap` — note three r186 removed
  `PCFSoftShadowMap` (it warns and falls back); one shadow-casting sun, map 2048, tight shadow camera).
- Sky: a gradient sky dome (custom shader: zenith → horizon, optional sun glow) or three's `Sky`
  addon. Always add fog matched to the horizon color so the world melts into the distance.
- Light: `HemisphereLight` (sky tint / ground bounce) + one warm `DirectionalLight` sun. Optional
  `RoomEnvironment` + PMREM for nice reflections.
- Color: harmonious, slightly desaturated palettes (pastel dusk, golden hour, mint & coral,
  moonlit blues). Never pure #ff0000/#00ff00/#0000ff. Vary colors subtly per instance (HSL jitter).
- Materials: `MeshStandardMaterial` (roughness 0.6–0.95), `flatShading` for charming low-poly,
  emissive for glow. Gentle rim/ambient light so nothing is pitch black.
- A style the request names (anime, Ghibli, pixel art, watercolor, realistic, a film's or a game's)
  replaces the low-poly default everywhere, starter island included: a world never mixes the two.
- Motion: the world is alive — swaying plants, drifting clouds, bobbing water, floating particles
  (fireflies, petals, dust motes), smooth eased camera. Use `THREE.Timer` (r186 deprecates `THREE.Clock`: `timer.update(t); const dt = THREE.MathUtils.clamp(timer.getDelta(), 0, 0.05)`): clamp delta at both ends — the first frames can report a negative one.
- Glow: `UnrealBloomPass` only when it makes things magical (night, neon, crystals); keep strength
  low (~0.4–0.8) and skip on low-end/mobile if heavy.

## Feel
- Camera: smooth (`OrbitControls` with damping and sensible limits, or a lerped third-person
  follow cam). Never let the camera go under the ground.
- Controls must work on desktop AND touch: WASD/arrows + mouse, and on touch a virtual joystick or
  tap-to-move. Show a short hint ("Drag to look · WASD to move") that fades after a few seconds.
- Keep the bottom-right corner (~90×90 px) free — the Orb floats there. On phones, bottom bars go left/center-left.
- In-world UI: minimal, rounded, frosted glass (`backdrop-filter: blur(16px)`), system font stack
  or a Google Font, small and out of the way (corners). Never cover the center of the screen.
- Games: clear goal, juicy feedback (particles, squash & stretch, sounds), score, win/lose and
  instant restart. Difficulty ramps gently.
- Sound: WebAudio synthesized, soft, only after the first user gesture; include a mute toggle if
  there is music.

## Performance & robustness
- 60 fps on a laptop, smooth on a phone. `InstancedMesh` for many repeated things, merge static
  geometry, reuse materials, cap particles, no per-frame allocations in hot loops.
- Handle `resize`. Handle `visibilitychange` (pause audio). No `alert()`.
- Never throw at startup: guard optional features. Everything must work offline from the CDN libs.
- The page fills the window (`html, body { margin:0; height:100%; overflow:hidden }`).

## Platform (inside Orb)
- `window.orb` is available inside Orb only. Always guard: `const orb = window.orb;` then `orb?.…`.
- `localStorage` works and is saved per player per world — use it for personal progress.
- `orb.store` = state shared by every visitor (guestbook, high scores, community builds).
- Worlds you move around in show everyone who's there, by default:
  `orb.visitors.show({ THREE, scene, camera, player })` puts each visitor in as a character the size of
  yours, in their color, with a name tag. That soft blob is only the default: a world with a
  character of its own gives everyone that character (`avatar: (v) => …`, animated by
  `update(v, model, dt)`), and what a player wears there (a hat from its shop) rides in their pose
  (`pose: () => ({ x, y, z, ry, hat })` instead of `player`) so the others see it on them. A world
  that can also be explored from the air passes `pose: () => …` with `fly: true` while the camera
  flies free, and those people show as glowing orbs up where they are;
  `orb.visitors.join(() => ({ x, y }))` shares where you are in 2D or custom worlds, which draw
  `visitors.list` themselves. Not for dioramas you orbit, toys, puzzles or tools.
- `orb.room.join(cb)` = realtime presence/messages with other people in the world right now;
  `orb.room.join(cb, { name })` = a separate room (one per match), `orb.room.invite(name)` shares a
  link into it and `orb.room.invited` is the room such a link asked for.
- `orb.shop` = things players buy with their Orb credits, when a world wants a shop: the page lists them
  (`<script type="application/json" id="orb-shop">{"items":[{ id, name, price, emoji, description }]}</script>`),
  `orb.shop.buy(id)` asks the player in Orb's own sheet at that price, `orb.shop.owned()` is what their
  account owns here; the world's maker earns from what sells.
- `orb.me` = `{ id, name, color, wears }` of the current player (`wears`: what their blob wears on Orb,
  like `['crown', 'shades']`; visitors carry it too as `v.wears`, and the default blob shows it).
- Call `orb?.capture()` at a beautiful moment (e.g. 2–3 s after load) to set the world's thumbnail.
