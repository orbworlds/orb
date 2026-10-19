// Orb Local: the parent side of Orb's world protocol (SPEC §7 of Orb), in one page. The world runs
// in the same sandboxed, opaque-origin frame as on Orb, with Orb's own runtime (runtime.js, built
// from Orb's source) injected the same way. What Orb's servers do is done here, in this browser:
//   - localStorage saves:   per world and player, in this page's localStorage
//   - orb.store:            shared by every tab of this browser, in localStorage
//   - orb.room / visitors:  every tab is a player; tabs meet over a BroadcastChannel
//   - orb.shop:             the page's own orb-shop list; buying asks in a sheet and charges nothing
// Each tab's player comes from ?player=<n> (1 by default); "+ Player" opens the next one.

import { injectRuntime } from './runtime.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const PLAYER = Math.max(1, Math.min(99, parseInt(params.get('player') || '1', 10) || 1));
const COLORS = ['#5ed1ff', '#ff8fb1', '#ffd36e', '#8ef0a8', '#b69cff', '#ff9f5e', '#6ee7e0', '#f78bff'];
const ROOM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const ITEM_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const STORE_VALUE_LIMIT = 8 * 1024;
const STORAGE_LIMIT = 2 * 1024 * 1024;

const info = await (await fetch('/__orb/world.json', { cache: 'no-store' })).json();
const me = {
  id: `local-p${PLAYER}`,
  name: params.get('name')?.slice(0, 24) || `Player ${PLAYER}`,
  color: COLORS[(PLAYER - 1) % COLORS.length],
  wears: [],
};
const key = (kind, ...parts) => ['orb-local', kind, info.id, ...parts].join(':');
const readJson = (k, d) => {
  try {
    const v = localStorage.getItem(k);
    return v == null ? d : JSON.parse(v);
  } catch {
    return d;
  }
};
const writeJson = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    toast('This browser’s storage is full', 'error');
  }
};

// ---- the bar -----------------------------------------------------------------------------------

$('who').textContent = me.name;
document.title = `${info.name} · Orb Local`;
if (info.url) {
  $('orb').hidden = false;
  $('orb').href = info.url;
}
$('add').onclick = () => {
  const next = Math.max(PLAYER, readJson('orb-local:last-player', 1)) + 1;
  writeJson('orb-local:last-player', next > 8 ? 1 : next);
  const u = new URL(location.href);
  u.searchParams.set('player', String(next));
  window.open(u.toString(), '_blank');
};
if (params.has('bare')) $('bar').hidden = true;

let toastTimes = [];
function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
}

const errors = [];
function showError(e) {
  errors.push(e);
  const where = e.source ? ` (${e.source.replace(/^.*\/api\/tree\/0{64}\//, '')}${e.line ? `:${e.line}` : ''})` : e.line ? ` (index.html:${e.line})` : '';
  console.error(`[world] ${e.message}${where}`, e.stack ?? '');
  $('errors').hidden = false;
  $('errors').textContent = `${errors.length} error${errors.length === 1 ? '' : 's'}`;
  if (errors.length <= 3) toast(`${e.message}${where}`, 'error');
}
$('errors').onclick = () => {
  for (const e of errors.slice(-5)) toast(e.message, 'error');
};

// ---- saves (the world's localStorage) ------------------------------------------------------------

const saveKey = key('ls', me.id);
let saves = readJson(saveKey, {});
let saveTimer;
function applyStorage(op, k, v) {
  if (op === 'clear') saves = {};
  else if (op === 'remove' && typeof k === 'string') delete saves[k];
  else if (op === 'set' && typeof k === 'string' && typeof v === 'string') saves[k] = v;
  else return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSaves, 300);
}
function flushSaves() {
  clearTimeout(saveTimer);
  const size = Object.entries(saves).reduce((n, [k, v]) => n + k.length + v.length, 0);
  if (size > STORAGE_LIMIT) return showError({ message: `World storage is full (max ${STORAGE_LIMIT / 1048576} MB); a localStorage write was dropped` });
  writeJson(saveKey, saves);
}
addEventListener('pagehide', flushSaves);

// ---- orb.store (shared by all tabs, same semantics as Orb's server) ------------------------------

function storeOp(req) {
  const k = key('store');
  const all = readJson(k, {});
  const cur = Object.prototype.hasOwnProperty.call(all, req.key) ? all[req.key] : null;
  let next;
  switch (req.op) {
    case 'get':
      return cur;
    case 'list': {
      const out = {};
      for (const name of Object.keys(all).filter((n) => n.startsWith(req.key)).sort().slice(0, 200)) out[name] = all[name];
      return out;
    }
    case 'set':
      next = req.value ?? null;
      break;
    case 'incr':
      next = (typeof cur === 'number' && Number.isFinite(cur) ? cur : 0) + (req.by ?? 1);
      break;
    case 'push': {
      const max = Math.max(1, Math.min(200, Math.floor(req.max ?? 50)));
      next = [...(Array.isArray(cur) ? cur : []), req.value ?? null].slice(-max);
      break;
    }
    case 'merge': {
      const fields = new Map(cur && typeof cur === 'object' && !Array.isArray(cur) ? Object.entries(cur) : []);
      for (const [f, v] of Object.entries(req.value)) {
        if (v === null) fields.delete(f);
        else fields.set(f, v);
      }
      next = Object.fromEntries(fields);
      break;
    }
    default:
      throw new Error('Unknown store operation');
  }
  if (JSON.stringify(next).length > STORE_VALUE_LIMIT) throw new Error('Value is too large (max 8 KB)');
  all[req.key] = next;
  writeJson(k, all);
  return next;
}

function parseStore(d) {
  const ops = ['get', 'set', 'incr', 'push', 'merge', 'list'];
  if (!ops.includes(d.op)) return 'Unknown store operation';
  if (typeof d.key !== 'string' || (!d.key && d.op !== 'list') || d.key.length > 64) return 'Store keys must be 1-64 characters';
  if (d.op === 'merge' && (!d.value || typeof d.value !== 'object' || Array.isArray(d.value))) return 'The patch must be an object';
  if (d.op === 'incr' && d.by !== undefined && (typeof d.by !== 'number' || !Number.isFinite(d.by))) return '"by" must be a number';
  if ((d.op === 'set' || d.op === 'push' || d.op === 'merge') && JSON.stringify(d.value ?? null).length > STORE_VALUE_LIMIT) return 'Value is too large (max 8 KB)';
  return { op: d.op, key: d.key, value: d.value, by: d.by, max: d.max };
}

// ---- rooms: every tab of this browser is a player ----------------------------------------------

const HEARTBEAT_MS = 1500;
const GONE_MS = 5000;

function joinRoom(name, onEvent) {
  const channel = new BroadcastChannel(key('room', name));
  const self = { ...me, id: `${me.id}:${Math.random().toString(36).slice(2, 8)}`, state: undefined, friend: false };
  const peers = new Map();
  const seen = new Map();
  let joined = false;
  let left = false;
  const post = (m) => !left && channel.postMessage({ ...m, from: self.id });
  const peerOf = (p) => ({ id: p.id, name: p.name, color: p.color, wears: p.wears ?? [], state: p.state, friend: false });
  const add = (p) => {
    const isNew = !peers.has(p.id);
    peers.set(p.id, peerOf(p));
    seen.set(p.id, Date.now());
    if (joined && isNew) onEvent({ type: 'join', peer: peers.get(p.id) });
  };
  const drop = (id) => {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    seen.delete(id);
    if (joined) onEvent({ type: 'leave', peer: p });
  };
  channel.onmessage = ({ data: m }) => {
    if (!m || m.from === self.id || left) return;
    seen.set(m.from, Date.now());
    switch (m.t) {
      case 'hello':
        add(m.peer);
        post({ t: 'here', to: m.from, peer: self });
        return;
      case 'here':
        if (m.to === self.id) add(m.peer);
        return;
      case 'ping':
        if (!peers.has(m.from)) post({ t: 'who', to: m.from });
        return;
      case 'who':
        if (m.to === self.id) post({ t: 'hello', peer: self });
        return;
      case 'state':
        if (!peers.has(m.from)) return add(m.peer);
        peers.set(m.from, peerOf(m.peer));
        if (joined) onEvent({ type: 'state', peer: peers.get(m.from) });
        return;
      case 'msg':
        if (joined && peers.has(m.from)) onEvent({ type: 'message', peer: peers.get(m.from), data: m.data });
        return;
      case 'bye':
        drop(m.from);
        return;
    }
  };
  post({ t: 'hello', peer: self });
  setTimeout(() => {
    if (left) return;
    joined = true;
    onEvent({ type: 'joined', self: peerOf(self), peers: [...peers.values()], live: true });
  }, 150);
  const beat = setInterval(() => {
    post({ t: 'ping' });
    const now = Date.now();
    for (const [id, at] of seen) if (now - at > GONE_MS) drop(id);
  }, HEARTBEAT_MS);
  const leave = () => {
    if (left) return;
    post({ t: 'bye' });
    left = true;
    clearInterval(beat);
    channel.close();
  };
  addEventListener('pagehide', leave);
  return {
    peers,
    send: (data) => post({ t: 'msg', data }),
    setState: (state) => {
      self.state = state;
      post({ t: 'state', peer: self });
    },
    leave,
  };
}

// ---- shop ----------------------------------------------------------------------------------------

const ownedKey = key('owned', me.id);
let sheetOpen = false;
function askToBuy(item) {
  return new Promise((resolve) => {
    $('sheet-emoji').textContent = item.emoji || '🛍️';
    $('sheet-name').textContent = item.name;
    $('sheet-desc').textContent = item.description || '';
    $('sheet-price').textContent = `${item.price} credits`;
    $('sheet').classList.add('open');
    const done = (ok) => {
      $('sheet').classList.remove('open');
      $('sheet-buy').onclick = $('sheet-cancel').onclick = null;
      resolve(ok);
    };
    $('sheet-buy').onclick = () => done(true);
    $('sheet-cancel').onclick = () => done(false);
  });
}

// ---- the world frame -----------------------------------------------------------------------------

const frame = $('world');
const rooms = new Map();
const people = () => {
  const own = rooms.get('');
  $('here').textContent = `${(own ? own.peers.size : 0) + 1} here`;
};

function post(msg) {
  frame.contentWindow?.postMessage({ __orb: 1, ...msg }, '*');
}

addEventListener('message', async (event) => {
  if (event.source !== frame.contentWindow) return;
  const d = event.data;
  if (!d || d.__orb !== 1 || typeof d.type !== 'string') return;
  switch (d.type) {
    case 'ready':
      return;
    case 'error':
      if (typeof d.message === 'string') showError(d);
      return;
    case 'storage':
      if (d.area === 'local') applyStorage(d.op, d.key, d.value);
      return;
    case 'toast': {
      const now = Date.now();
      toastTimes = toastTimes.filter((t) => now - t < 5000);
      if (typeof d.text === 'string' && d.text.trim() && toastTimes.length < 3) {
        toastTimes.push(now);
        toast(d.text.slice(0, 140));
      }
      return;
    }
    case 'title':
      if (typeof d.text === 'string' && d.text.trim()) document.title = `${d.text.slice(0, 120)} · Orb Local`;
      return;
    case 'capture':
      return;
    case 'store': {
      const req = parseStore(d);
      try {
        if (typeof req === 'string') throw new Error(req);
        post({ type: 'store-result', reqId: d.reqId, ok: true, value: storeOp(req) ?? null });
      } catch (e) {
        post({ type: 'store-result', reqId: d.reqId, ok: false, error: e.message || 'orb.store request failed' });
      }
      return;
    }
    case 'room': {
      const name = d.room === undefined || d.room === '' ? '' : typeof d.room === 'string' && ROOM_RE.test(d.room) ? d.room : null;
      if (name === null) return;
      if (d.op === 'join' && !rooms.has(name) && rooms.size < 4) {
        rooms.set(
          name,
          joinRoom(name, (ev) => {
            post({ type: 'room-event', room: name, event: ev });
            if (name === '') people();
          }),
        );
      } else if (d.op === 'send') rooms.get(name)?.send(d.data);
      else if (d.op === 'state') rooms.get(name)?.setState(d.data);
      else if (d.op === 'leave') {
        rooms.get(name)?.leave();
        rooms.delete(name);
        if (name === '') people();
      }
      return;
    }
    case 'invite': {
      const ok = typeof d.room === 'string' && ROOM_RE.test(d.room);
      post({ type: 'invite-result', reqId: d.reqId, url: ok ? `${location.origin}/?room=${encodeURIComponent(d.room)}` : null });
      return;
    }
    case 'shop': {
      const reply = (value) => post({ type: 'shop-result', reqId: d.reqId, ok: true, value });
      const owned = readJson(ownedKey, []);
      if (d.op === 'items') return reply(info.shop);
      if (d.op === 'owned') return reply(owned);
      if (d.op !== 'buy') return post({ type: 'shop-result', reqId: d.reqId, ok: false, error: 'orb.shop: unknown call' });
      const item = typeof d.item === 'string' && ITEM_RE.test(d.item) ? info.shop.find((i) => i.id === d.item) : null;
      if (!item) return reply({ ok: false, item: d.item ?? null, reason: 'unknown_item' });
      if (owned.includes(item.id)) return reply({ ok: true, item: item.id });
      if (sheetOpen) return reply({ ok: false, item: item.id, reason: 'busy' });
      sheetOpen = true;
      const ok = await askToBuy(item);
      sheetOpen = false;
      if (ok) writeJson(ownedKey, [...readJson(ownedKey, []), item.id]);
      return reply(ok ? { ok: true, item: item.id } : { ok: false, item: item.id, reason: 'cancelled' });
    }
  }
});

function withBase(html, base) {
  const tag = `<base data-orb-base href="${location.origin}${base}">`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const top = /^(\uFEFF?\s*<!doctype[^>]*>)?(\s*<html(\s[^>]*)?>)?/i.exec(html);
  const at = top ? top[0].length : 0;
  return html.slice(0, at) + tag + html.slice(at);
}

async function load() {
  flushSaves();
  for (const r of rooms.values()) r.leave();
  rooms.clear();
  people();
  const html = await (await fetch(`${info.base}index.html`, { cache: 'no-store' })).text();
  const room = params.get('room');
  frame.srcdoc = injectRuntime(withBase(html, info.base), {
    worldId: info.id,
    worldName: info.name,
    me,
    storage: saves,
    room: room && ROOM_RE.test(room) ? room : null,
  });
  frame.focus();
}

await load();

// Live reload: the dev server says when a file of the world changed.
try {
  const events = new EventSource('/__orb/events');
  events.onmessage = async (e) => {
    if (e.data !== 'reload') return;
    Object.assign(info, await (await fetch('/__orb/world.json', { cache: 'no-store' })).json());
    await load();
    toast('Reloaded');
  };
} catch {
  /* no live reload */
}
