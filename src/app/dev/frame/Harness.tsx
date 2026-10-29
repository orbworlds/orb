'use client';
// Client side of the /dev/frame runtime harness. Query params:
//   world=<id> (default "draft-harness"), name=<world name>, sample=<key>|none, external=<url>,
//   bg=<css color> (page background behind the frame), ui=0 (hide the panel, for screenshots).
// Tests drive it through window.__orbHarness.
import { useEffect, useMemo, useRef, useState } from 'react';
import WorldFrame, { type FrameProbe, type WorldFrameHandle } from '@/components/world/WorldFrame';
import { setFriendPeers, setRoomIdentity } from '@/lib/runtime/realtime';
import { injectRuntime } from '@/lib/runtime/sdk';
import type { ProbeResult, ProbeUnavailable, RuntimeContext, WorldRuntimeError } from '@/lib/types';

interface HarnessEvent {
  t: number;
  type: 'ready' | 'error' | 'toast' | 'title' | 'capture' | 'invite' | 'people' | 'purchase' | 'drop';
  data?: unknown;
}

interface HarnessApi {
  setHtml(html: string | null): void;
  setExternal(url: string | null): void;
  setWorldId(id: string): void;
  capture(): Promise<string | null>;
  probe(req: FrameProbe): Promise<ProbeResult | ProbeUnavailable>;
  reload(): void;
  inject(html: string): string;
  /** As a friends sync would: these peer ids are friends, vouched for by an answer asked at `askedAt`. */
  setFriendPeers(peers: string[], askedAt?: number): void;
  /** As the You tab would: the player's blob now wears these (their rooms tell the others). */
  setWears(wears: string[]): void;
  /** Record a clip of the world: its type, size and an object URL to play it, or why not. */
  clip(ms: number, label?: string): Promise<{ type: string; size: number; url: string } | { error: string }>;
  /** What "the player" answers when the world asks to sell something (orb.shop.buy), after `shopDelay` ms. */
  shopAnswer: { ok: boolean; reason?: string };
  shopDelay: number;
  events: HarnessEvent[];
}

declare global {
  interface Window {
    __orbHarness?: HarnessApi;
  }
}

const THREE_IMPORTMAP = `<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/"}}</script>`;

const SAMPLES: Record<string, string> = {
  three: `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Floating gem</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#1d1b3a}</style>
${THREE_IMPORTMAP}
</head>
<body>
<script type="module">
import * as THREE from 'three';
// === SCENE ===
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#2a2550');
scene.fog = new THREE.Fog('#2a2550', 6, 18);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 1.2, 6);
camera.lookAt(0, -0.2, 0);
// === SKY & LIGHT ===
scene.add(new THREE.HemisphereLight('#c9b8ff', '#3a2a50', 1.4));
const sun = new THREE.DirectionalLight('#ffd2b0', 2.2);
sun.position.set(3, 5, 4);
scene.add(sun);
// === WORLD ===
const gem = new THREE.Mesh(new THREE.IcosahedronGeometry(1.2, 0), new THREE.MeshStandardMaterial({ color: '#8b7bff', roughness: 0.35, flatShading: true }));
scene.add(gem);
const ground = new THREE.Mesh(new THREE.CircleGeometry(6, 48), new THREE.MeshStandardMaterial({ color: '#5ec8ff', roughness: 0.9 }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -1.6;
scene.add(ground);
// === LOOP ===
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime();
  gem.rotation.set(t * 0.4, t * 0.6, 0);
  gem.position.y = Math.sin(t * 1.5) * 0.2;
  renderer.render(scene, camera);
});
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
window.orb?.toast('Hello from the gem');
</script>
</body>
</html>`,

  canvas2d: `<!doctype html>
<html><head><meta charset="utf-8"><title>Glow dots</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#0f2a2a}canvas{display:block;width:100%;height:100%}</style>
</head><body><canvas id="c"></canvas>
<script>
const c = document.getElementById('c'), g = c.getContext('2d');
function size() { c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio; }
size(); addEventListener('resize', size);
function frame(t) {
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, '#16424a'); grad.addColorStop(1, '#ffb38a');
  g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 24; i++) {
    const x = (Math.sin(t / 1300 + i) * 0.4 + 0.5) * c.width, y = (Math.cos(t / 1700 + i * 1.7) * 0.4 + 0.5) * c.height;
    g.fillStyle = 'hsla(' + (i * 15) + ',80%,75%,.8)'; g.beginPath(); g.arc(x, y, 18 * devicePixelRatio, 0, 7); g.fill();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script></body></html>`,

  storage: `<!doctype html>
<html><head><meta charset="utf-8"><title>Counter</title>
<style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#f6f0ff;font:600 15px system-ui;color:#2a2550}
b{font-size:96px;display:block;text-align:center}button{font:inherit;padding:10px 18px;border-radius:999px;border:0;background:#8b7bff;color:#fff}</style>
</head><body><div><b id="n">0</b><p id="info"></p><button id="inc">+1</button></div>
<script>
const n = Number(localStorage.getItem('count') || 0) + 1;
localStorage.setItem('count', n);
document.getElementById('n').textContent = n;
document.getElementById('info').textContent = 'visits on this device · keys: ' + Object.keys(localStorage).join(', ');
document.getElementById('inc').onclick = () => { localStorage.count = Number(localStorage.count) + 1; document.getElementById('n').textContent = localStorage.count; };
</script></body></html>`,

  errors: `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Broken on purpose</title>
</head>
<body style="background:#fff3ef">
<script>
setTimeout(function later() {
  throw new Error('Timer exploded');
}, 50);
Promise.reject(new Error('Nobody caught me'));
console.error('Something odd', { code: 42 });
</script>
<script type="module">
import { Nope } from 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/does-not-exist.js';
console.log(Nope);
</script>
</body>
</html>`,

  store: `<!doctype html>
<html><head><meta charset="utf-8"><title>Guestbook</title>
<style>html,body{margin:0;height:100%;background:#fdf6ee;font:15px system-ui;color:#2a2550}main{max-width:420px;margin:40px auto;padding:0 16px}
input,button{font:inherit;padding:10px 14px;border-radius:999px;border:1px solid #ddd}li{padding:6px 0}</style>
</head><body><main><h2>Guestbook</h2><form id="f"><input id="t" placeholder="Say hi" maxlength="80"> <button>Sign</button></form><p id="v"></p><ul id="l"></ul></main>
<script>
const orb = window.orb;
const list = document.getElementById('l');
const render = (items) => { list.innerHTML = ''; (items || []).slice().reverse().forEach((it) => { const li = document.createElement('li'); li.textContent = it.name + ': ' + it.text; list.appendChild(li); }); };
orb?.store.incr('visits').then((v) => { document.getElementById('v').textContent = v + ' visits'; });
orb?.store.get('book').then(render);
document.getElementById('f').onsubmit = async (e) => { e.preventDefault(); const text = document.getElementById('t').value.trim(); if (!text) return; render(await orb.store.push('book', { name: orb.me.name, text }, 20)); document.getElementById('t').value = ''; };
</script></body></html>`,

  room: `<!doctype html>
<html><head><meta charset="utf-8"><title>Dots</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#101826;font:14px system-ui;color:#fff}#hud{position:fixed;left:12px;top:12px;opacity:.8}.dot{position:fixed;width:18px;height:18px;margin:-9px;border-radius:50%}</style>
</head><body><div id="hud">connecting…</div>
<script>
const orb = window.orb, dots = new Map();
function dot(p) { let d = dots.get(p.id); if (!d) { d = document.createElement('div'); d.className = 'dot'; d.style.background = p.color; document.body.appendChild(d); dots.set(p.id, d); } if (p.state) { d.style.left = p.state.x * innerWidth + 'px'; d.style.top = p.state.y * innerHeight + 'px'; } }
const room = orb?.room.join((e) => {
  if (e.type === 'joined') e.peers.forEach(dot);
  if (e.type === 'join' || e.type === 'state') dot(e.peer);
  if (e.type === 'leave') { dots.get(e.peer.id)?.remove(); dots.delete(e.peer.id); }
  document.getElementById('hud').textContent = (room ? room.peers.size : 0) + ' others here';
});
addEventListener('pointermove', (e) => { const s = { x: e.clientX / innerWidth, y: e.clientY / innerHeight }; room?.setState(s); dot({ id: 'me', color: orb.me.color, state: s }); });
</script></body></html>`,
};

export default function Harness({ params }: { params: Record<string, string> }) {
  const frame = useRef<WorldFrameHandle>(null);
  const [worldId, setWorldId] = useState(params.world || 'draft-harness');
  const [sample, setSample] = useState(params.sample ?? 'three');
  const [custom, setCustom] = useState<string | null>(null);
  const [external, setExternal] = useState<string | null>(params.external || null);
  const [log, setLog] = useState<HarnessEvent[]>([]);
  const [thumb, setThumb] = useState<string | null>(null);
  const events = useRef<HarnessEvent[]>([]);
  const showUi = params.ui !== '0';

  const ctx = useMemo<RuntimeContext>(
    () => ({ worldId, worldName: params.name || 'Harness world', me: { id: params.me || 'dev-player', name: 'Dev Player', color: params.color || '#8b7bff', wears: params.wears ? params.wears.split(',') : [] }, storage: {}, room: params.room || null }),
    [worldId, params.name, params.me, params.color, params.wears, params.room],
  );
  const html = custom ?? SAMPLES[sample] ?? null;

  const push = (type: HarnessEvent['type'], data?: unknown) => {
    const ev = { t: Math.round(performance.now()), type, data };
    events.current.push(ev);
    setLog((l) => [...l.slice(-7), ev]);
  };

  const ctxRef = useRef(ctx);
  useEffect(() => {
    ctxRef.current = ctx;
  }, [ctx]);

  useEffect(() => {
    const api: HarnessApi = {
      setHtml: (h) => {
        setExternal(null);
        setCustom(h);
      },
      setExternal,
      setWorldId,
      capture: () => frame.current?.capture() ?? Promise.resolve(null),
      probe: (req) => frame.current?.probe(req) ?? Promise.resolve({ unavailable: 'no frame' }),
      reload: () => frame.current?.reload(),
      inject: (h) => injectRuntime(h, ctxRef.current),
      setFriendPeers: (peers, askedAt = Date.now()) => setFriendPeers(peers, askedAt),
      setWears: (wears) => setRoomIdentity({ ...ctxRef.current.me, wears }),
      clip: async (ms, label = 'orb.test/harness') => {
        const r = (await frame.current?.recordClip(ms, label)) ?? { error: 'no frame' };
        return 'error' in r ? r : { type: r.blob.type, size: r.blob.size, url: URL.createObjectURL(r.blob) };
      },
      shopAnswer: { ok: true },
      shopDelay: 0,
      events: events.current,
    };
    window.__orbHarness = api;
    return () => {
      if (window.__orbHarness === api) delete window.__orbHarness;
    };
  }, []);

  const doCapture = async () => setThumb(await (frame.current?.capture() ?? Promise.resolve(null)));

  return (
    <div style={{ position: 'fixed', inset: 0, background: params.bg || 'repeating-conic-gradient(#ececf3 0 25%, #f8f8fb 0 50%) 0 0 / 24px 24px' }}>
      <WorldFrame
        ref={frame}
        html={external ? null : html}
        externalUrl={external}
        ctx={ctx}
        onReady={() => push('ready')}
        onError={(e: WorldRuntimeError) => push('error', e)}
        onToast={(t) => push('toast', t)}
        onTitle={(t) => push('title', t)}
        onCapture={(u) => push('capture', u.slice(0, 40))}
        onInvite={(room) => {
          push('invite', room);
          return `https://orb.test/harness?room=${room}`;
        }}
        onPeople={(p) => push('people', p)}
        onPurchase={async (item) => {
          push('purchase', item);
          const h = window.__orbHarness;
          await new Promise((r) => setTimeout(r, h?.shopDelay ?? 0));
          return h?.shopAnswer ?? { ok: true };
        }}
        onDrop={(files) => push('drop', files.map((f) => `${f.name}:${f.type}`))}
      />
      {showUi && (
        <div className="glass-strong" style={{ position: 'absolute', left: 16, bottom: 16, zIndex: 10, width: 'min(360px, calc(100vw - 32px))', borderRadius: 22, padding: 14, fontSize: 13 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {Object.keys(SAMPLES).map((k) => (
              <button
                key={k}
                onClick={() => {
                  setExternal(null);
                  setCustom(null);
                  setSample(k);
                }}
                style={{ padding: '5px 11px', borderRadius: 999, background: !custom && !external && sample === k ? 'var(--ink)' : 'var(--field-bg)', color: !custom && !external && sample === k ? 'var(--paper)' : 'var(--ink)' }}
              >
                {k}
              </button>
            ))}
            <button onClick={() => frame.current?.reload()} style={{ padding: '5px 11px', borderRadius: 999, background: 'var(--field-bg)' }}>
              reload
            </button>
            <button onClick={doCapture} style={{ padding: '5px 11px', borderRadius: 999, background: 'var(--field-bg)' }}>
              capture
            </button>
          </div>
          <div style={{ marginTop: 8, color: 'var(--ink-2)' }}>
            world <code>{worldId}</code>
          </div>
          <ol style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', fontFamily: 'var(--font-mono)', fontSize: 11, maxHeight: 150, overflow: 'auto' }}>
            {log.map((e, i) => (
              <li key={i} style={{ color: e.type === 'error' ? 'var(--bad)' : 'var(--ink-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {e.t}ms {e.type} {e.data === undefined ? '' : typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}
              </li>
            ))}
          </ol>
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL preview */}
          {thumb && <img src={thumb} alt="Captured thumbnail" style={{ marginTop: 8, width: 160, maxWidth: '100%', borderRadius: 12, display: 'block' }} />}
        </div>
      )}
    </div>
  );
}
