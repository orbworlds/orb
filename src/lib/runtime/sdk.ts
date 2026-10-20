// The orb runtime: one classic <script> injected as the first child of <head> of every native
// world (SPEC §7). It runs inside the sandboxed, opaque-origin iframe before any world code and
//   - shims localStorage / sessionStorage / document.cookie (the real ones throw there), lets
//     workers start from the world's own files and history keep its state without an address,
//   - forces preserveDrawingBuffer on WebGL contexts (so thumbnails can be captured),
//   - reports runtime errors, failed resource loads and the first console.error calls,
//   - posts 'ready' after load + 2 animation frames,
//   - exposes the frozen world-author SDK as window.orb,
//   - answers probes: Orb's builder plays the world with synthetic input and gets back what it
//     saw (screenshots, errors, console output, frame rate, the text on screen).
// The parent side of the protocol lives in ./bridge.ts.
import type { RuntimeContext } from '../types';

/** Attribute on the injected <script>; the runtime removes its own element once it has run. */
export const RUNTIME_ATTR = 'data-orb-runtime';

/** Max characters (keys + values) a world may keep in its shimmed localStorage (~2 MB). */
export const WORLD_STORAGE_LIMIT = 2 * 1024 * 1024;

/** Max JSON size of one `orb.store` value. */
export const STORE_VALUE_LIMIT = 8 * 1024;

/** Everything the runtime needs, embedded as a JSON literal in the injected script. */
export interface RuntimePayload {
  world: { id: string; name: string };
  me: RuntimeContext['me'];
  /** localStorage seed as [key, value] pairs (an object literal would swallow a "__proto__" key). */
  storage: Array<[string, string]>;
  /**
   * Source line (1-based) where the content of each <script> of the original document begins,
   * keyed by `s:<src attribute>` or `t:<first 64 chars of the trimmed inline text>`.
   * Lets the runtime attribute load failures of a script element to a line of the world.
   */
  scripts: Record<string, number>;
  /** [line, startColumn, endColumn) of the injected runtime itself — its stack frames are skipped. */
  rt: [number, number, number];
  limits: { storage: number; store: number };
  /** `orb.room.invited`: the room an invite link asked for, or null. */
  room: string | null;
}

/** Room names worlds may use (`orb.room.join(cb, { name })`, invite links). */
export const ROOM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

// ---------------------------------------------------------------------------------------------
// Runtime source. ES2019, one IIFE, no imports, invoked with the payload: `(function (P) {…})`.
// Rules for editing (the source is collapsed to a single line when injected):
//   - terminate every statement with a semicolon; use only /* block */ comments;
//   - never put a line break inside a string/regex, and never write the character sequences
//     "</" + "script" or "<!" + "--" (they would end the inline <script> early).
// scripts/test-runtime.mjs checks that the collapsed script parses.
const RUNTIME_SOURCE = String.raw`
(function (P) {
  'use strict';
  var W = window, D = document;
  if (W.__orbRuntime) { return; }
  try { Object.defineProperty(W, '__orbRuntime', { value: true }); } catch (e) { /* ignore */ }

  var PARENT = W.parent;
  var EMBEDDED = PARENT && PARENT !== W;
  var hasOwn = Object.prototype.hasOwnProperty;
  var raf = W.requestAnimationFrame ? W.requestAnimationFrame.bind(W) : function (f) { return setTimeout(f, 16); };
  var nativeConsoleError = console.error;
  var RT = P.rt || [0, 0, 0];

  /* Remove our own <script> so the world's DOM looks exactly like its author wrote it. */
  try { if (D.currentScript && D.currentScript.parentNode) { D.currentScript.parentNode.removeChild(D.currentScript); } } catch (e) { /* ignore */ }

  /* Worlds made of files run in an opaque origin, so their own images and videos count as
     cross-origin and would taint WebGL textures and canvases. Ask for them with CORS instead (the
     file server allows it), so they work like on the author's own site. */
  (function () {
    var TREE = /[/]api[/]tree[/][0-9a-f]{64}[/]/;
    function ours(v) { try { return TREE.test(new URL(String(v), D.baseURI).pathname); } catch (e) { return false; } }
    function cors(el) { try { if (el.getAttribute && el.getAttribute('crossorigin') === null && ours(el.getAttribute('src') || '')) { el.crossOrigin = 'anonymous'; } } catch (e) { /* ignore */ } }
    function patch(proto) {
      var d = Object.getOwnPropertyDescriptor(proto, 'src');
      if (!d || !d.set) { return; }
      Object.defineProperty(proto, 'src', {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set: function (v) { try { if (this.getAttribute('crossorigin') === null && ours(v)) { this.crossOrigin = 'anonymous'; } } catch (e) { /* ignore */ } d.set.call(this, v); }
      });
    }
    try { patch(HTMLImageElement.prototype); patch(HTMLMediaElement.prototype); } catch (e) { /* ignore */ }
    /* Elements written in the page itself: setting crossorigin makes the browser fetch them again with CORS. */
    try {
      new MutationObserver(function (list) {
        for (var i = 0; i < list.length; i++) {
          var nodes = list[i].addedNodes;
          for (var j = 0; j < nodes.length; j++) {
            var n = nodes[j];
            if (n.nodeType !== 1) { continue; }
            if (n.tagName === 'IMG' || n.tagName === 'VIDEO' || n.tagName === 'AUDIO') { cors(n); }
            else if (n.querySelectorAll) { var els = n.querySelectorAll('img,video,audio'); for (var k = 0; k < els.length; k++) { cors(els[k]); } }
          }
        }
      }).observe(D.documentElement, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
  })();

  function post(msg) {
    if (!EMBEDDED) { return; }
    msg.__orb = 1;
    try { PARENT.postMessage(msg, '*'); } catch (e) {
      /* DataCloneError (functions, DOM nodes…): retry with a JSON-normalised copy. */
      try { PARENT.postMessage(JSON.parse(JSON.stringify(msg)), '*'); } catch (e2) { /* give up */ }
    }
  }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
  function describe(v) {
    if (v instanceof Error || (v && typeof v === 'object' && typeof v.message === 'string' && typeof v.name === 'string')) {
      return v.name + ': ' + v.message;
    }
    if (typeof v === 'string') { return v; }
    if (typeof v === 'undefined' || typeof v === 'function' || typeof v === 'symbol') { return String(v); }
    try { return clip(JSON.stringify(v), 300); } catch (e) { return String(v); }
  }

  /* ===== Storage shims ===== */
  function makeStorage(area, seed, limit) {
    var map = new Map();
    var size = 0;
    if (Array.isArray(seed)) {
      for (var si = 0; si < seed.length; si++) {
        var kv = seed[si];
        if (kv && typeof kv[0] === 'string' && typeof kv[1] === 'string') { map.set(kv[0], kv[1]); size += kv[0].length + kv[1].length; }
      }
    }
    function str(v) {
      if (typeof v === 'symbol') { throw new TypeError('Cannot convert a Symbol value to a string'); }
      return String(v);
    }
    function need(n, args, name) {
      if (args.length < n) {
        throw new TypeError("Failed to execute '" + name + "' on 'Storage': " + n + ' argument' + (n > 1 ? 's' : '') + ' required, but only ' + args.length + ' present.');
      }
    }
    function quota() {
      var msg = "Failed to execute 'setItem' on 'Storage': this world's storage is full.";
      try { return new DOMException(msg, 'QuotaExceededError'); } catch (e) { return new Error(msg); }
    }
    var methods = {
      getItem: function (k) { need(1, arguments, 'getItem'); k = str(k); return map.has(k) ? map.get(k) : null; },
      setItem: function (k, v) {
        need(2, arguments, 'setItem');
        k = str(k); v = str(v);
        var had = map.has(k), old = had ? map.get(k) : null;
        if (had && old === v) { return; }
        var next = size - (had ? k.length + old.length : 0) + k.length + v.length;
        if (limit && next > limit) { throw quota(); }
        map.set(k, v); size = next;
        post({ type: 'storage', area: area, op: 'set', key: k, value: v });
      },
      removeItem: function (k) {
        need(1, arguments, 'removeItem');
        k = str(k);
        if (!map.has(k)) { return; }
        size -= k.length + map.get(k).length;
        map.delete(k);
        post({ type: 'storage', area: area, op: 'remove', key: k });
      },
      clear: function () {
        if (!map.size) { return; }
        map.clear(); size = 0;
        post({ type: 'storage', area: area, op: 'clear' });
      },
      key: function (i) {
        need(1, arguments, 'key');
        var n = i >>> 0;
        if (n >= map.size) { return null; }
        var it = map.keys(), r;
        while (n-- >= 0) { r = it.next(); }
        return r.value;
      }
    };
    /* Prototype chain → Storage.prototype, so instanceof Storage and toString() look native. */
    var proto = Object.create(W.Storage ? W.Storage.prototype : Object.prototype);
    Object.keys(methods).forEach(function (name) {
      Object.defineProperty(proto, name, { value: methods[name], writable: true, configurable: true, enumerable: false });
    });
    Object.defineProperty(proto, 'length', { get: function () { return map.size; }, configurable: true, enumerable: false });
    var target = Object.create(proto);
    /* Proxy gives property-style access: ls.foo, ls.foo = 1, delete ls.foo, 'foo' in ls, Object.keys(ls). */
    return new Proxy(target, {
      get: function (t, k, r) {
        if (typeof k === 'symbol' || k in proto || !map.has(k)) { return Reflect.get(t, k, r); }
        return map.get(k);
      },
      set: function (t, k, v) {
        if (typeof k === 'symbol') { t[k] = v; return true; }
        methods.setItem(k, v);
        return true;
      },
      has: function (t, k) { return (typeof k === 'string' && map.has(k)) || k in t; },
      deleteProperty: function (t, k) {
        if (typeof k === 'symbol') { return delete t[k]; }
        methods.removeItem(k);
        return true;
      },
      ownKeys: function (t) { return Array.from(map.keys()).concat(Object.getOwnPropertySymbols(t)); },
      getOwnPropertyDescriptor: function (t, k) {
        if (typeof k === 'string' && map.has(k)) { return { value: map.get(k), writable: true, enumerable: true, configurable: true }; }
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
      defineProperty: function (t, k, d) {
        if (typeof k === 'symbol') { return Reflect.defineProperty(t, k, d); }
        if ('value' in d) { methods.setItem(k, d.value); }
        return true;
      }
    });
  }
  function installGlobal(name, value) {
    try {
      Object.defineProperty(W, name, { configurable: true, enumerable: true, get: function () { return value; }, set: function () { /* read-only, like the real one */ } });
    } catch (e) { /* ignore */ }
  }
  installGlobal('localStorage', makeStorage('local', P.storage, P.limits && P.limits.storage));
  installGlobal('sessionStorage', makeStorage('session', null, P.limits && P.limits.storage));

  /* A world's own files are another origin than its opaque frame, so new Worker('worker.js') is
     refused: such a worker starts from a tiny data: script that loads the file instead (a blob:
     one is refused there too). */
  (function () {
    var Real = W.Worker;
    if (!Real) { return; }
    function Worker(url, opts) {
      try { return new Real(url, opts); } catch (e) {
        if (!e || e.name !== 'SecurityError') { throw e; }
        var abs = new URL(String(url), D.baseURI).href;
        var src = opts && opts.type === 'module' ? 'import ' + JSON.stringify(abs) + ';' : 'importScripts(' + JSON.stringify(abs) + ');';
        return new Real('data:text/javascript,' + encodeURIComponent(src), opts);
      }
    }
    Worker.prototype = Real.prototype;
    installGlobal('Worker', Worker);
  })();

  /* history.replaceState / pushState with a URL throw in a srcdoc frame (its address can't change):
     keep the state, leave the address. */
  ['replaceState', 'pushState'].forEach(function (name) {
    var real = W.history && W.history[name];
    if (typeof real !== 'function') { return; }
    W.history[name] = function (state, title) {
      try { return real.apply(this, arguments); } catch (e) {
        if (!e || e.name !== 'SecurityError') { throw e; }
        return real.call(this, state, title);
      }
    };
  });

  /* document.cookie throws in an opaque origin; keep a harmless in-memory jar instead. */
  (function () {
    var jar = new Map();
    try {
      Object.defineProperty(D, 'cookie', {
        configurable: true,
        enumerable: true,
        get: function () {
          var out = [];
          jar.forEach(function (v, k) { out.push(k ? k + '=' + v : v); });
          return out.join('; ');
        },
        set: function (s) {
          var parts = String(s).split(';');
          var nv = parts[0], eq = nv.indexOf('=');
          var name = eq < 0 ? '' : nv.slice(0, eq).trim(), val = (eq < 0 ? nv : nv.slice(eq + 1)).trim();
          var expired = false;
          for (var i = 1; i < parts.length; i++) {
            var a = parts[i].trim(), al = a.toLowerCase();
            if (al.indexOf('max-age=') === 0 && Number(a.slice(8)) <= 0) { expired = true; }
            if (al.indexOf('expires=') === 0) { var t = Date.parse(a.slice(8)); if (!isNaN(t) && t <= Date.now()) { expired = true; } }
          }
          if (expired) { jar.delete(name); } else { jar.set(name, val); }
        }
      });
    } catch (e) { /* ignore */ }
  })();

  /* ===== WebGL: keep the drawing buffer so capture() can read the last frame ===== */
  /* Which kind of context each canvas has (probe screenshots skip tainted 2D canvases). */
  var ctxTypes = W.WeakMap ? new WeakMap() : null;
  try {
    var CP = W.HTMLCanvasElement && W.HTMLCanvasElement.prototype;
    var getContext = CP && CP.getContext;
    if (getContext) {
      CP.getContext = function (type) {
        var ctx;
        if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
          var attrs = arguments[1], o = {};
          if (attrs && typeof attrs === 'object') { for (var k in attrs) { o[k] = attrs[k]; } }
          o.preserveDrawingBuffer = true;
          ctx = getContext.call(this, type, o);
        } else {
          ctx = getContext.apply(this, arguments);
        }
        if (ctx && ctxTypes && !ctxTypes.has(this)) { ctxTypes.set(this, String(type)); }
        return ctx;
      };
    }
  } catch (e) { /* ignore */ }

  /* ===== Error reporting ===== */
  var SCRIPT_LINES = P.scripts || {};
  var seen = {}, blamed = {}, sentTotal = 0, burstStart = 0, burstCount = 0, consoleCount = 0;
  var setT = W.setTimeout.bind(W);
  var perf = W.performance && W.performance.now ? W.performance : null;
  var T0 = perf ? perf.now() : Date.now();
  /* ms since the runtime started (≈ since the world started). */
  function since() { return Math.round((perf ? perf.now() : Date.now()) - T0); }
  /* What a probe reports: the latest errors and console output, kept inside the world. */
  var errLog = [], conLog = [], conTimes = [], conDropped = 0;
  function keepError(m) {
    errLog.push({ message: clip(m.message, 500), line: m.line || 0, source: m.source ? clip(m.source, 300) : '', t: since() });
    if (errLog.length > 40) { errLog.shift(); }
  }
  /* A short, cheap description of a logged value (no JSON.stringify: worlds log big objects). */
  function brief(v, depth) {
    if (v === null || v === undefined) { return String(v); }
    var t = typeof v;
    if (t === 'string') { return clip(v, 300); }
    if (t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol') { return String(v); }
    if (t === 'function') { return 'function ' + (v.name || '(anonymous)'); }
    try {
      if (v instanceof Error || (typeof v.message === 'string' && typeof v.name === 'string')) { return v.name + ': ' + v.message; }
      if (depth > 1) { return Array.isArray(v) ? '[…]' : '{…}'; }
      if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        var items = [];
        for (var i = 0; i < v.length && i < 8; i++) { items.push(brief(v[i], depth + 1)); }
        return '[' + items.join(', ') + (v.length > 8 ? ', … ' + v.length + ' items' : '') + ']';
      }
      var name = v.constructor && v.constructor.name && v.constructor.name !== 'Object' ? v.constructor.name + ' ' : '';
      var keys = Object.keys(v), parts = [];
      for (var k = 0; k < keys.length && k < 8; k++) { parts.push(keys[k] + ': ' + brief(v[keys[k]], depth + 1)); }
      return name + '{' + parts.join(', ') + (keys.length > 8 ? ', …' : '') + '}';
    } catch (e) { return '[object]'; }
  }
  function keepConsole(level, args) {
    try {
      var now = since();
      while (conTimes.length && now - conTimes[0] > 1000) { conTimes.shift(); }
      if (conTimes.length >= 20) { conDropped++; return; }
      conTimes.push(now);
      var parts = [];
      for (var i = 0; i < args.length && i < 8; i++) { parts.push(brief(args[i], 0)); }
      conLog.push({ level: level, text: clip(parts.join(' '), 300), t: now });
      if (conLog.length > 60) { conLog.shift(); }
    } catch (e) { /* never break the world's logging */ }
  }
  ['log', 'info', 'warn', 'debug'].forEach(function (level) {
    var orig = console[level];
    if (typeof orig !== 'function') { return; }
    console[level] = function () { keepConsole(level, arguments); return orig.apply(console, arguments); };
  });
  function isWorldDoc(url) { return !url || url === 'about:srcdoc' || url === D.URL; }
  /* First stack frame inside the world document (skipping the runtime's own frames). */
  function worldFrame(stack) {
    var re = /about:srcdoc:(\d+):(\d+)/g, m;
    stack = String(stack || '');
    while ((m = re.exec(stack))) {
      var line = +m[1], col = +m[2];
      if (!(line === RT[0] && col >= RT[1] && col < RT[2])) { return { line: line, col: col }; }
    }
    return null;
  }
  function scriptKey(el) {
    var src = el.getAttribute('src');
    if (src != null) { return 's:' + src; }
    return 't:' + String(el.text || '').replace(/\r\n?/g, '\n').trim().slice(0, 64);
  }
  /* Source line of a needle (e.g. a URL) inside one of the world's inline scripts. */
  function lineOf(needles) {
    var scripts = D.getElementsByTagName('script');
    for (var n = 0; n < needles.length; n++) {
      var needle = needles[n];
      if (!needle) { continue; }
      for (var i = 0; i < scripts.length; i++) {
        var el = scripts[i], base = SCRIPT_LINES[scriptKey(el)];
        if (!base || el.getAttribute('src') != null) { continue; }
        var text = String(el.text || ''), idx = text.indexOf(needle);
        if (idx >= 0) { return base + (text.slice(0, idx).match(/\n/g) || []).length; }
      }
    }
    return 0;
  }
  function urlNeedles(url) {
    var out = [url];
    try {
      var u = new URL(url), segs = u.pathname.split('/').filter(Boolean);
      if (segs.length >= 2) { out.push(segs.slice(-2).join('/')); }
      if (segs.length) { out.push(segs[segs.length - 1]); }
    } catch (e) { /* ignore */ }
    return out;
  }
  function failedResources() {
    var out = [];
    try {
      var entries = performance.getEntriesByType('resource');
      for (var i = 0; i < entries.length; i++) {
        var st = entries[i].responseStatus;
        var kind = entries[i].initiatorType;
        if (typeof st === 'number' && st >= 400 && (kind === 'script' || kind === 'other' || kind === 'link')) { out.push({ url: entries[i].name, status: st }); }
      }
    } catch (e) { /* ignore */ }
    return out;
  }
  function report(e) {
    if (!e || !e.message) { return; }
    var key = e.message + '|' + (e.source || '') + '|' + (e.line || 0) + '|' + (e.col || 0);
    if (seen[key]) { return; }
    var now = Date.now();
    /* Throttle: at most 20 distinct reports per 5 s and 60 per page (console.error has its own cap of 5). */
    if (now - burstStart > 5000) { burstStart = now; burstCount = 0; }
    if (burstCount >= 20 || sentTotal >= 60) { return; }
    seen[key] = 1; burstCount++; sentTotal++;
    var m = { type: 'error', message: clip(String(e.message).replace(/^Uncaught\s+/, ''), 1000) };
    if (e.stack) { m.stack = clip(e.stack, 4000); }
    if (e.line > 0) { m.line = e.line; }
    if (e.col > 0) { m.col = e.col; }
    if (e.source) { m.source = clip(e.source, 500); }
    post(m);
    keepError(m);
  }
  function reportResource(el) {
    var tag = el.tagName, url = el.currentSrc || el.src || el.href || '';
    if (tag === 'LINK' && !/(^|\s)(stylesheet|modulepreload|preload)(\s|$)/i.test(el.rel || '')) { return; }
    if (tag === 'SCRIPT') {
      var base = SCRIPT_LINES[scriptKey(el)] || 0;
      var isModule = String(el.type || '').toLowerCase() === 'module';
      /* Resource timing is filled in asynchronously; look a tick later for the failing URL. */
      setTimeout(function () {
        var failed = failedResources(), culprit = null;
        for (var i = 0; i < failed.length; i++) { if (failed[i].url === url) { culprit = failed[i]; break; } }
        /* A module whose own URL loaded fine failed on an import: blame the latest failure not yet blamed. */
        if (!culprit && isModule) {
          for (var j = failed.length - 1; j >= 0; j--) { if (!blamed[failed[j].url]) { culprit = failed[j]; break; } }
        }
        if (culprit) { blamed[culprit.url] = 1; }
        if (culprit && culprit.url !== url) {
          var line = lineOf(urlNeedles(culprit.url));
          report({ message: 'Failed to load module ' + culprit.url + ' (HTTP ' + culprit.status + ')', line: line || base, source: culprit.url });
        } else if (url) {
          report({ message: 'Failed to load script ' + url + (culprit ? ' (HTTP ' + culprit.status + ')' : ''), line: base, source: url });
        } else {
          report({ message: (isModule ? 'A module script' : 'A script') + ' failed to load: one of its imports could not be fetched', line: base });
        }
      }, 30);
      return;
    }
    var kind = tag === 'LINK' ? 'stylesheet' : tag === 'IMG' ? 'image' : tag.toLowerCase();
    report({ message: 'Failed to load ' + kind + ' ' + url, source: url || undefined });
  }
  W.addEventListener('error', function (ev) {
    var t = ev.target;
    if (t && t !== W && t.nodeType === 1) { reportResource(t); return; }
    var err = ev.error, stack = err && err.stack ? String(err.stack) : '';
    var msg = ev.message || (err ? describe(err) : 'Unknown error');
    var file = ev.filename || '';
    var e = { message: msg, stack: stack || undefined };
    if (isWorldDoc(file)) { e.line = ev.lineno; e.col = ev.colno; }
    else {
      var wf = worldFrame(stack);
      if (wf) { e.line = wf.line; e.col = wf.col; } else { e.line = ev.lineno; e.col = ev.colno; e.source = file; }
    }
    if (msg === 'Script error.' && !file) { e.message = 'Script error in a cross-origin script (add crossorigin="anonymous" to its script tag to see details)'; }
    report(e);
  }, true);
  W.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason, stack = r && r.stack ? String(r.stack) : '';
    var msg = describe(r), loc = worldFrame(stack), e = { message: 'Unhandled promise rejection: ' + msg, stack: stack || undefined };
    if (loc) { e.line = loc.line; e.col = loc.col; }
    else {
      var um = /(https?:[^\s'"]+)/.exec(msg);
      if (um) { e.line = lineOf(urlNeedles(um[1])) || undefined; e.source = um[1]; }
    }
    report(e);
  });
  console.error = function () {
    keepConsole('error', arguments);
    try {
      if (consoleCount < 5) {
        consoleCount++;
        var parts = [], stack = '';
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          if (!stack && a && typeof a === 'object' && a.stack) { stack = String(a.stack); }
          parts.push(describe(a));
        }
        var callSite = '';
        try { callSite = String(new Error().stack || ''); } catch (e) { /* ignore */ }
        var loc = worldFrame(stack) || worldFrame(callSite);
        report({ message: 'console.error: ' + clip(parts.join(' '), 900), stack: stack || undefined, line: loc ? loc.line : 0, col: loc ? loc.col : 0 });
      }
    } catch (e) { /* never break the world's logging */ }
    return nativeConsoleError.apply(console, arguments);
  };

  /* ===== Capture ===== */
  function opaqueColor(el) {
    try {
      var c = getComputedStyle(el).backgroundColor;
      if (c && c !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(c)) { return c; }
    } catch (e) { /* ignore */ }
    return '';
  }
  /* The visible canvas covering most of the screen: the world's picture. */
  function bestCanvas() {
    var canvases = D.getElementsByTagName('canvas'), best = null, bestArea = 0;
    var vw = W.innerWidth || D.documentElement.clientWidth, vh = W.innerHeight || D.documentElement.clientHeight;
    for (var i = 0; i < canvases.length; i++) {
      var c = canvases[i];
      if (!c.width || !c.height) { continue; }
      var r = c.getBoundingClientRect();
      var w = Math.min(r.right, vw) - Math.max(r.left, 0), h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      if (w <= 0 || h <= 0) { continue; }
      var st = getComputedStyle(c);
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) { continue; }
      if (w * h > bestArea) { best = c; bestArea = w * h; }
    }
    return best;
  }
  function grab() {
    var best = bestCanvas();
    if (!best) { return null; }
    var OW = 640, OH = 400, out = D.createElement('canvas');
    out.width = OW; out.height = OH;
    var g = out.getContext('2d');
    if (!g) { return null; }
    var bg = opaqueColor(best) || (D.body && opaqueColor(D.body)) || opaqueColor(D.documentElement);
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, OW, OH); }
    /* Cover-crop the canvas' backing store to 16:10. */
    var sw = best.width, sh = best.height, cw = sw, ch = sh;
    if (sw / sh > OW / OH) { cw = sh * OW / OH; } else { ch = sw * OH / OW; }
    g.imageSmoothingQuality = 'high';
    g.drawImage(best, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, OW, OH);
    var url = out.toDataURL('image/webp', 0.82);
    if (url.indexOf('data:image/webp') !== 0) { url = out.toDataURL('image/jpeg', 0.85); }
    return url.length > 32 ? url : null;
  }
  function safeGrab() { try { return grab(); } catch (e) { return null; } }

  /* ===== Probe: Orb's builder plays the world and looks at it (parent sends 'probe') ===== */
  var probing = false, probeBusy = false, fakeLock = null, lockUsed = false;
  /* Negative: no real pointer gets this id. */
  var PROBE_POINTER = -7331;
  /* The element a probe clicked into: typing goes there without taking focus from Orb's page. */
  var vFocus = null;
  /* What the world said in dialogs during the probe (they'd block it and pop up for the person). */
  var probeDialogs = [];
  function sleep(ms) { return new Promise(function (r) { setT(r, Math.max(0, ms || 0)); }); }
  function nextFrame() { return new Promise(function (r) { var done = false; raf(function () { done = true; r(); }); setT(function () { if (!done) { r(); } }, 120); }); }
  function clampMs(v, def) { var n = Number(v); if (!isFinite(n) || n < 0) { n = def; } return Math.min(10000, n); }
  function vpW() { return W.innerWidth || D.documentElement.clientWidth || 1; }
  function vpH() { return W.innerHeight || D.documentElement.clientHeight || 1; }
  function frac(v, size) { var n = Number(v); if (!isFinite(n)) { n = 0.5; } return Math.max(0, Math.min(size - 1, n * size)); }
  function round3(v) { return Math.round(v * 1000) / 1000; }

  /* Synthetic input can't get pointer lock or fullscreen, and has no pointer to capture: while a
     probe runs, pretend those work, so the world reacts as it would to a person. */
  function lockChanged() { setT(function () { try { D.dispatchEvent(new Event('pointerlockchange')); } catch (e) { /* ignore */ } }, 0); }
  try {
    var EP = W.Element && W.Element.prototype, DP = W.Document && W.Document.prototype;
    if (EP && EP.requestPointerLock) {
      var realLock = EP.requestPointerLock;
      EP.requestPointerLock = function () {
        if (!probing) { return realLock.apply(this, arguments); }
        fakeLock = this; lockUsed = true; lockChanged();
        return Promise.resolve();
      };
    }
    var lockDesc = DP && Object.getOwnPropertyDescriptor(DP, 'pointerLockElement');
    if (lockDesc && lockDesc.get && lockDesc.configurable) {
      Object.defineProperty(DP, 'pointerLockElement', { configurable: true, enumerable: lockDesc.enumerable, get: function () { return fakeLock || lockDesc.get.call(this); } });
    }
    if (DP && DP.exitPointerLock) {
      var realExit = DP.exitPointerLock;
      DP.exitPointerLock = function () {
        if (fakeLock) { fakeLock = null; lockChanged(); return; }
        return realExit.apply(this, arguments);
      };
    }
    if (EP && EP.requestFullscreen) {
      var realFull = EP.requestFullscreen;
      EP.requestFullscreen = function () { return probing ? Promise.resolve() : realFull.apply(this, arguments); };
    }
    ['setPointerCapture', 'releasePointerCapture'].forEach(function (name) {
      var real = EP && EP[name];
      if (!real) { return; }
      EP[name] = function (id) { if (id === PROBE_POINTER) { return; } return real.apply(this, arguments); };
    });
    ['alert', 'confirm', 'prompt'].forEach(function (name) {
      var realDialog = W[name];
      if (typeof realDialog !== 'function') { return; }
      W[name] = function (msg) {
        if (!probing) { return realDialog.apply(W, arguments); }
        if (probeDialogs.length < 5) { probeDialogs.push('The world showed ' + name + '(' + JSON.stringify(clip(msg == null ? '' : String(msg), 120)) + ').'); }
        return name === 'confirm' ? true : name === 'prompt' ? '' : undefined;
      };
    });
    if (EP && EP.hasPointerCapture) {
      var realHas = EP.hasPointerCapture;
      EP.hasPointerCapture = function (id) { return id === PROBE_POINTER ? false : realHas.apply(this, arguments); };
    }
  } catch (e) { /* ignore */ }

  /* -- keyboard -- */
  var KEYCODES = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, Shift: 16, Control: 17, Alt: 18, Meta: 91, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
  var MODS = { Shift: 1, Control: 1, Alt: 1, Meta: 1 };
  var held = {};
  /* Key name as a model writes it ("w", "Space", "up", "Shift") → KeyboardEvent fields. */
  function keyInfo(name, exact) {
    var k = String(name == null ? '' : name), low = k.toLowerCase();
    if (k.length > 1) {
      if (low === 'space' || low === 'spacebar') { k = ' '; }
      else if (low === 'esc' || low === 'escape') { k = 'Escape'; }
      else if (low === 'enter' || low === 'return') { k = 'Enter'; }
      else if (low === 'up' || low === 'down' || low === 'left' || low === 'right') { k = 'Arrow' + low.charAt(0).toUpperCase() + low.slice(1); }
      else if (low.indexOf('arrow') === 0 && low.length > 5) { k = 'Arrow' + low.charAt(5).toUpperCase() + low.slice(6); }
      else if (low === 'ctrl' || low === 'control') { k = 'Control'; }
      else if (low === 'cmd' || low === 'meta') { k = 'Meta'; }
      else if (low === 'shift' || low === 'alt' || low === 'tab' || low === 'backspace' || low === 'delete' || low === 'home' || low === 'end') { k = low.charAt(0).toUpperCase() + low.slice(1); }
      else if (low === 'pageup' || low === 'pagedown') { k = 'Page' + low.charAt(4).toUpperCase() + low.slice(5); }
    }
    var code = k, keyCode = KEYCODES[k] || 0;
    if (k.length === 1) {
      var up = k.toUpperCase();
      if (up >= 'A' && up <= 'Z' && up !== k.toLowerCase()) {
        if (!exact) { k = held.Shift ? up : up.toLowerCase(); }
        code = 'Key' + up; keyCode = up.charCodeAt(0);
      }
      else if (k >= '0' && k <= '9') { code = 'Digit' + k; keyCode = k.charCodeAt(0); }
      else if (k === ' ') { code = 'Space'; keyCode = 32; }
      else { code = ''; keyCode = k.charCodeAt(0); }
    } else if (MODS[k]) { code = k + 'Left'; }
    else if (/^F[0-9]{1,2}$/.test(k)) { keyCode = 111 + Number(k.slice(1)); }
    return { key: k, code: code, keyCode: keyCode };
  }
  function focused() { return vFocus && vFocus.isConnected ? vFocus : D.activeElement; }
  function keyTarget() { var a = focused(); return a && a !== D.body && a !== D.documentElement ? a : (D.body || D.documentElement); }
  function fireKey(type, info) {
    var ev;
    try {
      ev = new KeyboardEvent(type, { key: info.key, code: info.code, bubbles: true, cancelable: true, composed: true, shiftKey: !!held.Shift, ctrlKey: !!held.Control, altKey: !!held.Alt, metaKey: !!held.Meta });
      Object.defineProperty(ev, 'keyCode', { get: function () { return info.keyCode; } });
      Object.defineProperty(ev, 'which', { get: function () { return info.keyCode; } });
      if (type === 'keypress') { Object.defineProperty(ev, 'charCode', { get: function () { return info.key.length === 1 ? info.key.charCodeAt(0) : 0; } }); }
    } catch (e) { return true; }
    return keyTarget().dispatchEvent(ev);
  }
  function insertText(ch) {
    var el = focused();
    if (!el) { return; }
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.readOnly && !el.disabled) {
      var v = String(el.value), s = null, e2 = null;
      try { s = el.selectionStart; e2 = el.selectionEnd; } catch (e) { /* number inputs have no selection */ }
      if (typeof s === 'number' && typeof e2 === 'number') {
        el.value = v.slice(0, s) + ch + v.slice(e2);
        try { el.selectionStart = el.selectionEnd = s + ch.length; } catch (e) { /* ignore */ }
      } else { el.value = v + ch; }
      try { el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' })); } catch (e) { el.dispatchEvent(new Event('input', { bubbles: true })); }
    } else if (el.isContentEditable) {
      try { D.execCommand('insertText', false, ch); } catch (e) { /* ignore */ }
    }
  }
  async function pressKeys(spec, ms, times) {
    var s = String(spec == null ? '' : spec);
    var names = s === '+' ? ['+'] : s.split('+').filter(function (x) { return x !== ''; });
    if (!names.length) { return; }
    for (var n = 0; n < times; n++) {
      var infos = [];
      for (var i = 0; i < names.length; i++) {
        var info = keyInfo(names[i], false);
        if (MODS[info.key]) { held[info.key] = true; }
        infos.push(info);
        var ok = fireKey('keydown', info);
        if (ok && (info.key.length === 1 || info.key === 'Enter') && !held.Control && !held.Meta) {
          fireKey('keypress', info);
          if (info.key.length === 1) { insertText(info.key); }
        }
      }
      await sleep(ms);
      for (var j = infos.length - 1; j >= 0; j--) {
        fireKey('keyup', infos[j]);
        if (MODS[infos[j].key]) { held[infos[j].key] = false; }
      }
      if (n < times - 1) { await sleep(60); }
    }
  }
  async function typeText(text) {
    var s = String(text == null ? '' : text).slice(0, 300);
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '\n') { await pressKeys('Enter', 30, 1); continue; }
      var info = keyInfo(ch, true);
      if (fireKey('keydown', info)) { fireKey('keypress', info); insertText(ch); }
      fireKey('keyup', info);
      await sleep(16);
    }
  }

  /* -- pointer, touch, wheel -- */
  var ptr = { x: -1, y: -1, down: 0 };
  function firePointer(type, x, y, o) {
    var target = fakeLock && (type === 'mousemove' || type === 'pointermove') ? fakeLock : (D.elementFromPoint(x, y) || D.body || D.documentElement);
    var btn = o.button === 2 ? 2 : 0, moving = type === 'pointermove' || type === 'mousemove';
    var init = {
      bubbles: true, cancelable: true, composed: true, view: W,
      clientX: x, clientY: y, screenX: x, screenY: y, movementX: o.dx || 0, movementY: o.dy || 0,
      button: moving ? (type === 'pointermove' ? -1 : 0) : btn, buttons: ptr.down ? (btn === 2 ? 2 : 1) : 0, detail: o.detail || 0,
      pointerId: PROBE_POINTER, pointerType: o.touch ? 'touch' : 'mouse', isPrimary: true, width: 1, height: 1, pressure: ptr.down ? 0.5 : 0
    };
    var ev;
    try { ev = type.indexOf('pointer') === 0 && W.PointerEvent ? new PointerEvent(type, init) : new MouseEvent(type, init); } catch (e) { return target; }
    target.dispatchEvent(ev);
    return target;
  }
  function fireTouch(type, x, y, target) {
    try {
      var t = new Touch({ identifier: PROBE_POINTER, target: target, clientX: x, clientY: y, screenX: x, screenY: y, pageX: x, pageY: y, radiusX: 4, radiusY: 4, force: 0.5 });
      var list = type === 'touchend' ? [] : [t];
      target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: list, targetTouches: list, changedTouches: [t] }));
    } catch (e) { /* no touch events in this browser */ }
  }
  function focusAt(t) {
    try { vFocus = t && t.closest ? t.closest('input,textarea,select,button,a[href],[tabindex],[contenteditable]') : null; } catch (e) { vFocus = null; }
  }
  async function move(a) {
    var ms = clampMs(a.ms, 0), rel = a.dx != null || a.dy != null;
    var steps = Math.max(1, Math.min(60, Math.round(ms / 16)));
    if (ptr.x < 0) { ptr.x = vpW() / 2; ptr.y = vpH() / 2; }
    var x0 = ptr.x, y0 = ptr.y;
    var ddx = rel ? Number(a.dx) || 0 : frac(a.x, vpW()) - x0, ddy = rel ? Number(a.dy) || 0 : frac(a.y, vpH()) - y0;
    for (var i = 1; i <= steps; i++) {
      if (ms) { await sleep(ms / steps); }
      if (!rel) { ptr.x = x0 + ddx * i / steps; ptr.y = y0 + ddy * i / steps; }
      var o = { dx: ddx / steps, dy: ddy / steps, touch: !!a.touch };
      firePointer('pointermove', ptr.x, ptr.y, o);
      firePointer('mousemove', ptr.x, ptr.y, o);
    }
  }
  async function click(a) {
    var x = frac(a.x, vpW()), y = frac(a.y, vpH()), touch = !!a.touch, btn = a.button === 'right' ? 2 : 0;
    var o = { touch: touch, button: btn };
    if (touch) { ptr.x = x; ptr.y = y; } else { await move({ x: a.x, y: a.y }); }
    var n = a.double ? 2 : 1;
    for (var i = 0; i < n; i++) {
      ptr.down = 1;
      var t = firePointer('pointerdown', x, y, o);
      if (touch) { fireTouch('touchstart', x, y, t); } else { firePointer('mousedown', x, y, o); }
      focusAt(t);
      await sleep(touch ? 70 : 50);
      ptr.down = 0;
      firePointer('pointerup', x, y, o);
      if (touch) { fireTouch('touchend', x, y, t); firePointer('mousedown', x, y, o); }
      firePointer('mouseup', x, y, o);
      firePointer(btn === 2 ? 'contextmenu' : 'click', x, y, { touch: touch, button: btn, detail: i + 1 });
      if (i === 1) { firePointer('dblclick', x, y, { touch: touch, detail: 2 }); }
      if (i < n - 1) { await sleep(80); }
    }
  }
  async function drag(a) {
    var x0 = frac(a.x, vpW()), y0 = frac(a.y, vpH()), x1 = frac(a.to_x, vpW()), y1 = frac(a.to_y, vpH());
    var ms = clampMs(a.ms, 400), steps = Math.max(4, Math.min(60, Math.round(ms / 16))), touch = !!a.touch;
    var o = { touch: touch };
    if (touch) { ptr.x = x0; ptr.y = y0; } else { await move({ x: a.x, y: a.y }); }
    ptr.down = 1;
    var t = firePointer('pointerdown', x0, y0, o);
    if (touch) { fireTouch('touchstart', x0, y0, t); } else { firePointer('mousedown', x0, y0, o); }
    for (var i = 1; i <= steps; i++) {
      await sleep(ms / steps);
      var x = x0 + (x1 - x0) * i / steps, y = y0 + (y1 - y0) * i / steps;
      var mo = { touch: touch, dx: x - ptr.x, dy: y - ptr.y };
      ptr.x = x; ptr.y = y;
      firePointer('pointermove', x, y, mo);
      if (touch) { fireTouch('touchmove', x, y, t); } else { firePointer('mousemove', x, y, mo); }
    }
    ptr.down = 0;
    firePointer('pointerup', x1, y1, o);
    if (touch) { fireTouch('touchend', x1, y1, t); } else { firePointer('mouseup', x1, y1, o); }
  }
  function wheel(a) {
    var x = a.x == null ? vpW() / 2 : frac(a.x, vpW()), y = a.y == null ? vpH() / 2 : frac(a.y, vpH());
    var target = D.elementFromPoint(x, y) || D.body || D.documentElement;
    try { target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, view: W, clientX: x, clientY: y, deltaY: Number(a.dy) || 0, deltaMode: 0 })); } catch (e) { /* ignore */ }
  }

  /* -- eval -- */
  function dump(v) {
    if (v === undefined) { return 'undefined'; }
    if (typeof v === 'string') { return JSON.stringify(clip(v, 1500)); }
    if (v === null || typeof v !== 'object') { return brief(v, 0); }
    if (typeof v.toJSON === 'function' || (W.Node && v instanceof W.Node) || v.isObject3D || v instanceof Error) { return brief(v, 0); }
    try {
      var seenObj = [];
      return clip(JSON.stringify(v, function (k, x) {
        if (x && typeof x === 'object') {
          if (seenObj.indexOf(x) >= 0) { return '[circular]'; }
          if (seenObj.length > 300) { return '…'; }
          seenObj.push(x);
        }
        return typeof x === 'function' ? '[function]' : x;
      }), 2000);
    } catch (e) { return brief(v, 0); }
  }
  async function runEval(js) {
    var code = String(js == null ? '' : js).slice(0, 4000), v;
    try {
      try { v = (0, eval)(code); }
      catch (e) {
        if (!(e instanceof SyntaxError) || !/\breturn\b/.test(code)) { throw e; }
        v = (0, eval)('(function () {' + code + '\n})()');
      }
      if (v && typeof v.then === 'function') { v = await Promise.race([v, sleep(3000).then(function () { return '(still pending after 3 s)'; })]); }
      return { js: clip(code, 200), result: dump(v) };
    } catch (e) {
      return { js: clip(code, 200), result: describe(e), error: true };
    }
  }

  /* -- screenshot: the canvases plus an approximation of the page's HTML (boxes and text) -- */
  function cssColor(c) { return c && c !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(c) ? c : ''; }
  function gradColor(bg) { var m = /(rgba?|hsla?)\([^)]*\)/.exec(bg || ''); return m ? cssColor(m[0]) : ''; }
  function fontOf(st) { return st.font || [st.fontStyle, st.fontWeight, st.fontSize, st.fontFamily].join(' '); }
  function boxPath(g, x, y, w, h, rad) {
    g.beginPath();
    if (rad > 0 && g.roundRect) { g.roundRect(x, y, w, h, Math.min(rad, w / 2, h / 2)); } else { g.rect(x, y, w, h); }
  }
  function corsClean(el) {
    var src = String(el.currentSrc || el.src || '');
    return src.indexOf('data:') === 0 || src.indexOf('blob:') === 0 || el.crossOrigin === 'anonymous' || el.crossOrigin === 'use-credentials';
  }
  function tainted(c) {
    if (!ctxTypes || ctxTypes.get(c) !== '2d') { return false; }
    try { c.getContext('2d').getImageData(0, 0, 1, 1); return false; } catch (e) { return true; }
  }
  function drawMedia(g, el, r) {
    var tag = el.tagName;
    var w = tag === 'VIDEO' ? el.videoWidth : tag === 'IMG' ? el.naturalWidth : el.width;
    var h = tag === 'VIDEO' ? el.videoHeight : tag === 'IMG' ? el.naturalHeight : el.height;
    if (!w || !h) { return; }
    if (tag === 'CANVAS' ? tainted(el) : !corsClean(el)) {
      g.fillStyle = 'rgba(128,128,128,.35)';
      g.fillRect(r.left, r.top, r.width, r.height);
      return;
    }
    try { g.drawImage(el, r.left, r.top, r.width, r.height); } catch (e) { /* ignore */ }
  }
  function paintText(g, node, st, op, vh) {
    var raw = node.nodeValue || '';
    if (!/\S/.test(raw)) { return; }
    var color = cssColor(st.color) || gradColor(st.backgroundImage);
    if (!color) { return; }
    var range = D.createRange();
    range.selectNodeContents(node);
    var rects = range.getClientRects();
    if (!rects.length) { return; }
    var text = raw.replace(/\s+/g, ' ').trim();
    if (st.textTransform === 'uppercase') { text = text.toUpperCase(); } else if (st.textTransform === 'lowercase') { text = text.toLowerCase(); }
    g.globalAlpha = op; g.fillStyle = color; g.font = fontOf(st); g.textBaseline = 'middle'; g.textAlign = 'left';
    var words = text.split(' '), wi = 0;
    for (var i = 0; i < rects.length && wi < words.length; i++) {
      var rc = rects[i];
      if (rc.width < 0.5) { continue; }
      var line = words[wi++];
      if (i === rects.length - 1) { while (wi < words.length) { line += ' ' + words[wi++]; } }
      else { while (wi < words.length && g.measureText(line + ' ' + words[wi]).width <= rc.width + 1) { line += ' ' + words[wi++]; } }
      if (rc.bottom < 0 || rc.top > vh) { continue; }
      g.fillText(line, rc.left, rc.top + rc.height / 2, Math.max(1, rc.width + 2));
    }
  }
  var FIELD_SKIP = { checkbox: 1, radio: 1, range: 1, color: 1, hidden: 1, file: 1 };
  function paintTree(g, el, op, vw, vh, budget, depth) {
    if (budget.n++ > 3000 || depth > 80) { return; }
    var tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'NOSCRIPT' || tag === 'HEAD') { return; }
    var st = getComputedStyle(el);
    if (st.display === 'none') { return; }
    var so = parseFloat(st.opacity);
    var o = op * (isNaN(so) ? 1 : so);
    if (o < 0.03) { return; }
    var vis = st.visibility === 'visible';
    var r = el.getBoundingClientRect();
    if (vis && r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh) {
      g.globalAlpha = o;
      if (tag === 'CANVAS' || tag === 'IMG' || tag === 'VIDEO') { drawMedia(g, el, r); return; }
      if (tag === 'IFRAME' || tag === 'svg' || tag === 'OBJECT' || tag === 'EMBED') { return; }
      var rad = parseFloat(st.borderTopLeftRadius) || 0;
      var fill = cssColor(st.backgroundColor) || gradColor(st.backgroundImage);
      if (fill) { g.fillStyle = fill; boxPath(g, r.left, r.top, r.width, r.height, rad); g.fill(); }
      var bw = parseFloat(st.borderTopWidth) || 0, bc = cssColor(st.borderTopColor);
      if (bw > 0 && bc && st.borderTopStyle !== 'none' && st.borderTopStyle !== 'hidden') {
        g.lineWidth = bw; g.strokeStyle = bc;
        boxPath(g, r.left + bw / 2, r.top + bw / 2, Math.max(0, r.width - bw), Math.max(0, r.height - bw), rad);
        g.stroke();
      }
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        var val = '';
        if (tag === 'SELECT') { val = el.selectedIndex >= 0 && el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : ''; }
        else if (!FIELD_SKIP[el.type]) { val = el.type === 'password' && el.value ? '••••••' : (el.value || el.placeholder || ''); }
        if (val) {
          g.globalAlpha = el.value || tag === 'SELECT' ? o : o * 0.55;
          g.fillStyle = cssColor(st.color) || '#000';
          g.font = fontOf(st); g.textBaseline = 'middle'; g.textAlign = 'left';
          var pad = (parseFloat(st.paddingLeft) || 2) + bw;
          g.fillText(clip(val, 200), r.left + pad, r.top + r.height / 2, Math.max(1, r.width - pad * 2));
        }
        return;
      }
    }
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) { paintTree(g, c, o, vw, vh, budget, depth + 1); }
      else if (c.nodeType === 3 && vis) { paintText(g, c, st, o, vh); }
    }
  }
  function flatness(cv) {
    try {
      var t = D.createElement('canvas');
      t.width = 24; t.height = 16;
      var g = t.getContext('2d');
      g.drawImage(cv, 0, 0, 24, 16);
      var px = g.getImageData(0, 0, 24, 16).data, n = 0, sum = 0, sq = 0;
      for (var i = 0; i < px.length; i += 4) { var l = px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11; sum += l; sq += l * l; n++; }
      var mean = sum / n;
      return Math.sqrt(Math.max(0, sq / n - mean * mean)) < 1.5;
    } catch (e) { return false; }
  }
  function zoomOf(z) {
    if (!z || typeof z !== 'object') { return null; }
    var w = Math.min(1, Math.max(0.05, Number(z.w) || 1)), h = Math.min(1, Math.max(0.05, Number(z.h) || 1));
    if (w >= 1 && h >= 1) { return null; }
    return { x: Math.min(1 - w, Math.max(0, Number(z.x) || 0)), y: Math.min(1 - h, Math.max(0, Number(z.y) || 0)), w: w, h: h };
  }
  /* zoom: a part of the screen (fractions), drawn larger — up to 4x, never past maxSide. */
  function snapshot(maxSide, zoom) {
    var vw = vpW(), vh = vpH();
    var zx = zoom ? zoom.x * vw : 0, zy = zoom ? zoom.y * vh : 0, zw = zoom ? zoom.w * vw : vw, zh = zoom ? zoom.h * vh : vh;
    var s = Math.min(zoom ? 4 : 1, maxSide / Math.max(zw, zh));
    var out = D.createElement('canvas');
    out.width = Math.max(1, Math.round(zw * s));
    out.height = Math.max(1, Math.round(zh * s));
    var g = out.getContext('2d');
    if (!g) { return null; }
    g.setTransform(s, 0, 0, s, -zx * s, -zy * s);
    g.fillStyle = opaqueColor(D.documentElement) || (D.body && opaqueColor(D.body)) || '#ffffff';
    g.fillRect(0, 0, vw, vh);
    if (D.body) { paintTree(g, D.body, 1, vw, vh, { n: 0 }, 0); }
    g.globalAlpha = 1;
    var url;
    try {
      url = out.toDataURL('image/webp', 0.8);
      if (url.indexOf('data:image/webp') !== 0) { url = out.toDataURL('image/jpeg', 0.85); }
    } catch (e) { return null; }
    return { url: url, flat: flatness(out) };
  }

  /* -- what's on screen -- */
  function describeEl(el) {
    if (!el || el === D.body || el === D.documentElement) { return 'page'; }
    var s = String(el.tagName || '').toLowerCase();
    if (el.id) { s += '#' + clip(el.id, 30); }
    else if (typeof el.className === 'string' && el.className.trim()) { s += '.' + clip(el.className.trim().split(/\s+/)[0], 30); }
    return s;
  }
  function isShown(el) {
    if (el.checkVisibility) { try { return el.checkVisibility({ opacityProperty: true, visibilityProperty: true }); } catch (e) { /* older browser */ } }
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var st = getComputedStyle(n);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) { return false; }
    }
    return true;
  }
  var UI_SKIP = /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|CANVAS|OPTION|svg)$/;
  var UI_CONTROL = /^(BUTTON|A|INPUT|SELECT|TEXTAREA|SUMMARY|LABEL)$/;
  function visibleUi(limit) {
    var out = [], vw = vpW(), vh = vpH();
    var all = D.body ? D.body.getElementsByTagName('*') : [];
    for (var i = 0; i < all.length && i < 3000 && out.length < limit; i++) {
      var el = all[i], tag = el.tagName;
      if (UI_SKIP.test(tag)) { continue; }
      var control = UI_CONTROL.test(tag) || el.getAttribute('role') === 'button' || el.hasAttribute('onclick');
      if (!control && el.parentElement && el.parentElement.closest && el.parentElement.closest('button,a,label,summary,select,[role="button"]')) { continue; }
      var text = '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') { text = (tag === 'INPUT' ? '[' + (el.type || 'text') + '] ' : '') + (el.type === 'password' ? '' : el.value || el.placeholder || el.getAttribute('aria-label') || ''); }
      else if (tag === 'SELECT') { text = el.selectedIndex >= 0 && el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : ''; }
      else if (control) { text = el.innerText || el.getAttribute('aria-label') || el.title || ''; }
      else { for (var c = el.firstChild; c; c = c.nextSibling) { if (c.nodeType === 3) { text += c.nodeValue; } } }
      text = String(text).replace(/\s+/g, ' ').trim();
      if (!text) { continue; }
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh || !isShown(el)) { continue; }
      out.push({ text: clip(text, 80), x: round3(r.left / vw), y: round3(r.top / vh), w: round3(r.width / vw), h: round3(r.height / vh), tag: tag.toLowerCase(), click: control || getComputedStyle(el).cursor === 'pointer' });
    }
    return out;
  }
  function mainCanvas() {
    var cs = D.getElementsByTagName('canvas'), best = null, area = 0, vw = vpW(), vh = vpH();
    for (var i = 0; i < cs.length; i++) {
      var r = cs[i].getBoundingClientRect();
      var w = Math.min(r.right, vw) - Math.max(r.left, 0), h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      if (w > 0 && h > 0 && w * h > area) { best = cs[i]; area = w * h; }
    }
    if (!best) { return null; }
    return { w: best.width, h: best.height, type: (ctxTypes && ctxTypes.get(best)) || 'none', cover: round3(area / (vw * vh)) };
  }

  /*
   * Whether the world's WebGL is drawn by the CPU (SwiftShader, llvmpipe…): its frame rate then
   * says little about real devices. Browsers that mask RENDERER name it through the debug
   * extension (Firefox warns about that extension, so it is only asked when needed).
   */
  var SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|basic render/i;
  var softGl = null;
  function softwareGl() {
    if (softGl !== null) { return softGl; }
    var cs = D.getElementsByTagName('canvas');
    for (var i = 0; i < cs.length; i++) {
      var type = ctxTypes && ctxTypes.get(cs[i]);
      if (!type || type.indexOf('webgl') === -1) { continue; }
      try {
        var gl = cs[i].getContext(type);
        if (!gl) { continue; }
        var name = String(gl.getParameter(gl.RENDERER) || '');
        if (!name || /^webkit webgl$/i.test(name)) {
          var ext = gl.getExtension('WEBGL_debug_renderer_info');
          if (ext) { name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || ''); }
        }
        softGl = SOFTWARE_GL.test(name);
        return softGl;
      } catch (e) { /* ignore */ }
    }
    return false;
  }

  async function runProbe(d) {
    var o = d.opts && typeof d.opts === 'object' ? d.opts : {};
    var maxSide = Math.max(200, Math.min(1600, Number(o.size) || 1024));
    var maxShots = Math.max(1, Math.min(6, Math.floor(Number(o.shots) || 4)));
    var acts = Array.isArray(d.actions) ? d.actions.slice(0, 40) : [];
    var start = since(), frames = 0, alive = true, shots = [], evals = [], notes = [];
    probing = true; lockUsed = false; vFocus = null; probeDialogs = [];
    function count() { if (alive) { frames++; raf(count); } }
    raf(count);
    function shoot(label, zoom) {
      var snap = null;
      try { snap = snapshot(maxSide, zoom); } catch (e) { snap = null; }
      var shot = { label: clip(label, 60), t: since(), dataUrl: snap ? snap.url : null, flat: snap ? snap.flat : false };
      if (zoom) { shot.zoom = zoom; }
      shots.push(shot);
    }
    try {
      for (var i = 0; i < acts.length; i++) {
        if (since() - start > 45000) { notes.push('Stopped early: the play-test took too long.'); break; }
        var a = acts[i] && typeof acts[i] === 'object' ? acts[i] : {};
        try {
          if (a.type === 'wait') { await sleep(clampMs(a.ms, 500)); }
          else if (a.type === 'key') { await pressKeys(a.key, clampMs(a.ms, 120), Math.max(1, Math.min(30, Math.floor(Number(a.times) || 1)))); }
          else if (a.type === 'type') { await typeText(a.text); }
          else if (a.type === 'click') { await click(a); }
          else if (a.type === 'move') { await move(a); }
          else if (a.type === 'drag') { await drag(a); }
          else if (a.type === 'scroll') { wheel(a); await sleep(50); }
          else if (a.type === 'eval') { evals.push(await runEval(a.js)); }
          else if (a.type === 'screenshot') {
            if (shots.length < maxShots - 1) { await nextFrame(); shoot(a.label || 'shot ' + (shots.length + 1), zoomOf(a.zoom)); }
            else { notes.push('Skipped a screenshot (at most ' + maxShots + ' per look, the last one is taken at the end).'); }
          }
          else { notes.push('Skipped an unknown action "' + clip(a.type, 20) + '".'); }
        } catch (e) { notes.push('Action ' + (i + 1) + ' (' + clip(a.type, 20) + ') failed: ' + describe(e)); }
      }
      var spent = since() - start;
      if (spent < 600) { await sleep(600 - spent); }
      await nextFrame();
      await nextFrame();
      shoot('end');
    } finally {
      probing = false;
      alive = false;
      held = {};
      ptr.down = 0;
      if (fakeLock) { fakeLock = null; lockChanged(); }
    }
    var errs = [];
    for (var j = Math.max(0, errLog.length - 20); j < errLog.length; j++) {
      var er = errLog[j];
      errs.push({ message: er.message, line: er.line || undefined, source: er.source || undefined, t: er.t, during: er.t >= start });
    }
    return {
      size: { w: vpW(), h: vpH(), dpr: W.devicePixelRatio || 1 },
      title: clip(D.title || '', 120),
      uptime: since(),
      fps: Math.round(frames * 1000 / Math.max(1, since() - start)),
      software: softwareGl(),
      errors: errs,
      logs: conLog.slice(-30),
      dropped: conDropped,
      ui: visibleUi(60),
      canvas: mainCanvas(),
      focus: describeEl(focused()),
      locked: lockUsed,
      shots: shots,
      evals: evals,
      notes: probeDialogs.concat(notes)
    };
  }
  function probe(d) {
    if (probeBusy) { post({ type: 'probe-result', reqId: d.reqId, error: 'busy' }); return; }
    probeBusy = true;
    runProbe(d).then(function (result) {
      probeBusy = false;
      post({ type: 'probe-result', reqId: d.reqId, result: result });
    }, function (e) {
      probeBusy = false;
      probing = false;
      post({ type: 'probe-result', reqId: d.reqId, error: describe(e) });
    });
  }

  /* ===== Parent → world messages ===== */
  var pending = {}, reqSeq = 0;
  /* Joined rooms by name ('' is the world's own room). */
  var rooms = Object.create(null);
  W.addEventListener('message', function (ev) {
    if (ev.source !== PARENT || !EMBEDDED) { return; }
    var d = ev.data;
    if (!d || d.__orb !== 1) { return; }
    /* Orb's own messages are not the world's business. */
    ev.stopImmediatePropagation();
    if (d.type === 'store-result' || d.type === 'invite-result' || d.type === 'shop-result') { var cb = pending[d.reqId]; if (cb) { cb(d); } }
    else if (d.type === 'capture-request') { post({ type: 'capture', reqId: d.reqId, dataUrl: safeGrab() }); }
    else if (d.type === 'clip-request') { try { recordClip(d); } catch (err) { clipping = false; post({ type: 'clip-result', reqId: d.reqId, error: 'failed' }); } }
    else if (d.type === 'probe') { probe(d); }
    else if (d.type === 'room-event') { var rm = rooms[typeof d.room === 'string' ? d.room : '']; if (rm) { rm.dispatch(d.event); } }
  }, true);

  /* ===== SDK: store ===== */
  function jsonValue(v, what, max) {
    var s;
    try { s = JSON.stringify(v); } catch (e) { throw new TypeError('orb.' + what + ': value must be JSON-serialisable'); }
    if (s === undefined) { throw new TypeError('orb.' + what + ': value must be JSON-serialisable'); }
    if (s.length > max) { throw new RangeError('orb.' + what + ': value is too large (max ' + Math.round(max / 1024) + ' KB)'); }
    return JSON.parse(s);
  }
  function storeCall(op, key, extra) {
    return new Promise(function (resolve, reject) {
      if (typeof key !== 'string' && typeof key !== 'number') { throw new TypeError('orb.store.' + op + ': key must be a string'); }
      key = String(key);
      /* list takes a prefix, which may be empty (every key). */
      if ((!key && op !== 'list') || key.length > 64) { throw new TypeError('orb.store.' + op + ': key must be 1-64 characters'); }
      var id = 's' + (++reqSeq) + '_' + Date.now().toString(36);
      var msg = { type: 'store', reqId: id, op: op, key: key };
      for (var k in extra) { if (hasOwn.call(extra, k)) { msg[k] = extra[k]; } }
      var timer = setTimeout(function () { delete pending[id]; reject(new Error('orb.store.' + op + ' timed out')); }, 10000);
      pending[id] = function (res) {
        clearTimeout(timer);
        delete pending[id];
        if (res.ok) { resolve(res.value === undefined ? null : res.value); }
        else { reject(new Error(res.error || 'orb.store.' + op + ' failed')); }
      };
      if (!EMBEDDED) { pending[id]({ ok: false, error: 'orb.store is only available inside Orb' }); return; }
      post(msg);
    });
  }
  var LIMIT = (P.limits && P.limits.store) || 8192;
  var store = Object.freeze({
    get: function (key) { return storeCall('get', key, {}); },
    set: function (key, value) {
      try { return storeCall('set', key, { value: jsonValue(value, 'store.set', LIMIT) }); } catch (e) { return Promise.reject(e); }
    },
    incr: function (key, by) {
      var n = by === undefined ? 1 : Number(by);
      if (!isFinite(n)) { return Promise.reject(new TypeError('orb.store.incr: "by" must be a number')); }
      return storeCall('incr', key, { by: n });
    },
    push: function (key, item, max) {
      var m = max === undefined ? 50 : Math.floor(Number(max));
      if (!(m >= 1)) { return Promise.reject(new TypeError('orb.store.push: "max" must be a positive number')); }
      try { return storeCall('push', key, { value: jsonValue(item, 'store.push', LIMIT), max: m }); } catch (e) { return Promise.reject(e); }
    },
    merge: function (key, patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) { return Promise.reject(new TypeError('orb.store.merge: the patch must be an object')); }
      try { return storeCall('merge', key, { value: jsonValue(patch, 'store.merge', LIMIT) }); } catch (e) { return Promise.reject(e); }
    },
    list: function (prefix) {
      return storeCall('list', prefix == null ? '' : prefix, {});
    }
  });

  /* ===== SDK: room ===== */
  function createRoom() {
    var listeners = [], peers = new Map(), state = { self: null, joined: false, live: false };
    function emit(ev) {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](ev); } catch (err) { setTimeout(function () { throw err; }); }
      }
    }
    var r = {
      peers: peers,
      listeners: listeners,
      state: state,
      /* What the world gave room.setState, and this player's pose from orb.visitors (sent together). */
      app: undefined,
      pose: null,
      dispatch: function (ev) {
        if (!ev || typeof ev !== 'object') { return; }
        if (ev.type === 'joined') {
          state.joined = true; state.self = ev.self || null; state.live = ev.live === true; peers.clear();
          (ev.peers || []).forEach(function (p) { peers.set(p.id, p); });
        } else if (ev.type === 'join' || ev.type === 'state') {
          if (ev.peer) { peers.set(ev.peer.id, ev.peer); }
        } else if (ev.type === 'leave') {
          if (ev.peer) { peers.delete(ev.peer.id); }
        }
        emit(ev);
      },
      joinedEvent: function () {
        var list = [];
        peers.forEach(function (p) { list.push(p); });
        return { type: 'joined', self: state.self, peers: list, live: state.live };
      }
    };
    return r;
  }
  var ROOM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
  function roomName(v, what) {
    var n = v == null ? '' : String(v);
    if (n && !ROOM_RE.test(n)) { throw new TypeError('orb.room.' + what + ': a room name is 1-40 letters, digits, - or _'); }
    return n;
  }
  /* The state others see: the world's own, with this player's pose from orb.visitors as _p. */
  var POSE_KEY = '_p';
  function roomState(rm) {
    var app = rm.app, pose = rm.pose, out, k;
    if (pose == null) { return app === undefined ? null : app; }
    if (app == null) { out = {}; out[POSE_KEY] = pose; return out; }
    if (typeof app !== 'object' || Array.isArray(app)) { return app; }
    out = {};
    for (k in app) { if (hasOwn.call(app, k)) { out[k] = app[k]; } }
    out[POSE_KEY] = pose;
    return out;
  }
  function postRoomState(name, rm) {
    var v = roomState(rm);
    if (rm.state.self) { rm.state.self.state = v; }
    post({ type: 'room', op: 'state', room: name, data: v });
  }
  function roomJoin(cb, opts) {
    if (cb != null && typeof cb !== 'function') { throw new TypeError('orb.room.join: callback must be a function'); }
    if (opts != null && typeof opts !== 'object') { throw new TypeError('orb.room.join: options must be an object, like { name: "match-1" }'); }
    var name = roomName(opts ? opts.name : null, 'join');
    var fresh = !rooms[name];
    if (fresh && Object.keys(rooms).length >= 4) { throw new RangeError('orb.room.join: a world can be in at most 4 rooms at once (leave one first)'); }
    if (fresh) { rooms[name] = createRoom(); }
    var current = rooms[name], active = true;
    var listener = cb || function () { /* no-op */ };
    current.listeners.push(listener);
    if (fresh) { post({ type: 'room', op: 'join', room: name }); }
    else if (current.state.joined) {
      setTimeout(function () { if (active) { try { listener(current.joinedEvent()); } catch (err) { setTimeout(function () { throw err; }); } } });
    }
    return Object.freeze({
      name: name,
      peers: current.peers,
      get self() { return current.state.self; },
      send: function (data) {
        if (!active) { return; }
        post({ type: 'room', op: 'send', room: name, data: jsonValue(data, 'room.send', 32768) });
      },
      setState: function (s) {
        if (!active) { return; }
        current.app = jsonValue(s === undefined ? null : s, 'room.setState', 16384);
        postRoomState(name, current);
      },
      leave: function () {
        if (!active) { return; }
        active = false;
        var i = current.listeners.indexOf(listener);
        if (i >= 0) { current.listeners.splice(i, 1); }
        if (!current.listeners.length && rooms[name] === current) { delete rooms[name]; post({ type: 'room', op: 'leave', room: name }); }
      }
    });
  }
  /* An invite link to a room of this world: Orb copies it (or opens the share sheet) and says so. */
  function roomInvite(name) {
    return new Promise(function (resolve) {
      var n = roomName(name, 'invite');
      if (!n) { throw new TypeError('orb.room.invite: give the room a name'); }
      if (!EMBEDDED) { resolve(null); return; }
      var id = 'i' + (++reqSeq) + '_' + Date.now().toString(36);
      var timer = setTimeout(function () { delete pending[id]; resolve(null); }, 60000);
      pending[id] = function (res) { clearTimeout(timer); delete pending[id]; resolve(typeof res.url === 'string' ? res.url : null); };
      post({ type: 'invite', reqId: id, room: n });
    });
  }
  var invited = typeof P.room === 'string' && ROOM_RE.test(P.room) ? P.room : null;

  /* ===== SDK: shop — things players buy with their Orb credits ===== */
  /* What a world sells is listed in its page (a JSON script with id "orb-shop"); buying always goes
     through Orb's own sheet, which asks the player with the price from Orb's copy of that list. */
  var ITEM_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
  function shopCall(op, item) {
    return new Promise(function (resolve, reject) {
      if (!EMBEDDED) { resolve(op === 'buy' ? { ok: false, item: item, reason: 'not_on_orb' } : []); return; }
      var id = 'h' + (++reqSeq) + '_' + Date.now().toString(36);
      var timer = setTimeout(function () { delete pending[id]; reject(new Error('orb.shop.' + op + ' timed out')); }, op === 'buy' ? 900000 : 15000);
      pending[id] = function (res) {
        clearTimeout(timer);
        delete pending[id];
        if (res.ok) { resolve(res.value); } else { reject(new Error(res.error || 'orb.shop.' + op + ' failed')); }
      };
      post({ type: 'shop', reqId: id, op: op, item: item });
    });
  }
  var shop = Object.freeze({
    items: function () { return shopCall('items'); },
    owned: function () { return shopCall('owned'); },
    buy: function (item) {
      if (typeof item !== 'string' || !ITEM_ID_RE.test(item)) { return Promise.reject(new TypeError('orb.shop.buy: give it the id of an item in your orb-shop list')); }
      return shopCall('buy', item);
    }
  });

  /* ===== SDK: visitors — everyone who's here right now, shown in the world ===== */
  /* Each player's pose rides in its room state (roomState above). Positions and turns are smoothed
     and carried on at the sender's speed between updates (a few a second, fewer in a full room);
     anything else in a pose comes through as it was sent. */
  var POSE_EVERY_MS = 100;
  var POSE_AHEAD_S = 1;
  var POSE_FIELDS_MAX = 24;
  var SMOOTH_KEYS = ['x', 'y', 'z', 'ry', 'yaw', 'heading', 'angle'];
  var ANGLES = { ry: 1, yaw: 1, heading: 1, angle: 1 };
  var VELOCITY_OF = { x: 'vx', y: 'vy', z: 'vz' };
  var NOT_POSE = { id: 1, name: 1, color: 1, wears: 1, friend: 1, state: 1 };
  /* What someone's blob wears, as Orb sends it: ids of src/lib/looks.ts. */
  function wearOf(x) {
    var out = [], i;
    if (!Array.isArray(x)) { return out; }
    for (i = 0; i < x.length && out.length < 4; i++) { if (typeof x[i] === 'string' && /^[a-z0-9-]{1,24}$/.test(x[i])) { out.push(x[i]); } }
    return out;
  }
  var crowds = [], crowdAt = 0, crowdRunning = false;
  function nowMs() { return perf ? perf.now() : Date.now(); }
  function wrapAngle(d) { return Math.atan2(Math.sin(d), Math.cos(d)); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function later(err) { setTimeout(function () { throw err; }); }
  function cleanPose(p) {
    if (p == null || p === false) { return null; }
    if (typeof p !== 'object' || Array.isArray(p)) { throw new TypeError('orb.visitors: where you are must be an object, like { x: 1, y: 2 }'); }
    var out = {}, n = 0, k, v;
    for (k in p) {
      if (!hasOwn.call(p, k) || NOT_POSE[k] || n >= POSE_FIELDS_MAX) { continue; }
      v = p[k];
      if (typeof v === 'number') { if (!isFinite(v)) { continue; } out[k] = round2(v); }
      else if (typeof v === 'string') { out[k] = v.length > 64 ? v.slice(0, 64) : v; }
      else if (typeof v === 'boolean') { out[k] = v; }
      else { continue; }
      n++;
    }
    return out;
  }
  function samePose(a, b) {
    var k;
    if (a === b) { return true; }
    if (!a || !b) { return false; }
    for (k in a) { if (hasOwn.call(a, k) && a[k] !== b[k]) { return false; } }
    for (k in b) { if (hasOwn.call(b, k) && !hasOwn.call(a, k)) { return false; } }
    return true;
  }
  function crowdFrame() {
    if (!crowds.length) { crowdRunning = false; return; }
    var now = nowMs(), dt = Math.min(Math.max((now - crowdAt) / 1000, 0), 0.1), list = crowds.slice(), i;
    crowdAt = now;
    for (i = 0; i < list.length; i++) {
      try { list[i].tick(dt, now); } catch (err) { if (!list[i].failed) { list[i].failed = true; later(err); } }
    }
    raf(crowdFrame);
  }
  function makeCrowd(read, opts, what) {
    if (typeof read !== 'function') { throw new TypeError('orb.visitors.' + what + ': give it a function that says where you are, like () => ({ x: hero.x, y: hero.y })'); }
    var name = roomName(opts.room, 'join');
    var smooth = Array.isArray(opts.smooth) ? opts.smooth.map(String) : SMOOTH_KEYS;
    var snapOf = typeof opts.snap === 'function' ? opts.snap : function () { return typeof opts.snap === 'number' && opts.snap > 0 ? opts.snap : Infinity; };
    var byId = new Map(), list = [], on = { join: [], leave: [] }, active = true;
    var sent = null, prev = null, prevAt = 0, readFailed = false, timer;
    var c = { tick: null, onTick: null, failed: false };
    function fire(type, v) {
      var ls = on[type].slice();
      for (var i = 0; i < ls.length; i++) { try { ls[i](v); } catch (err) { later(err); } }
    }
    function relist() {
      var out = [];
      byId.forEach(function (rec) { if (rec.placed) { out.push(rec.v); } });
      list = out;
    }
    function place(rec, pose, now) {
      var last = rec.v.state, dt = (now - rec.at) / 1000, snap = snapOf(), i, k, x, vk;
      rec.v.state = pose;
      for (k in pose) { if (hasOwn.call(pose, k) && !NOT_POSE[k] && smooth.indexOf(k) < 0) { rec.v[k] = pose[k]; } }
      /* A field they stopped sending (fly, once they land) is gone, not stuck at its last value. */
      if (last) { for (k in last) { if (hasOwn.call(last, k) && !hasOwn.call(pose, k) && !NOT_POSE[k] && smooth.indexOf(k) < 0) { delete rec.v[k]; } } }
      for (i = 0; i < smooth.length; i++) {
        k = smooth[i];
        x = pose[k];
        if (typeof x !== 'number') { continue; }
        vk = VELOCITY_OF[k];
        if (ANGLES[k]) { rec.vel[k] = 0; }
        else if (vk && typeof pose[vk] === 'number') { rec.vel[k] = pose[vk]; }
        else if (last && typeof last[k] === 'number' && dt > 0.04 && dt < 2) { rec.vel[k] = (x - last[k]) / dt; }
        else { rec.vel[k] = 0; }
        rec.to[k] = x;
        if (!rec.placed || typeof rec.v[k] !== 'number' || (!ANGLES[k] && Math.abs(x - rec.v[k]) > snap)) { rec.v[k] = x; }
      }
      rec.at = now;
      if (!rec.placed) { rec.placed = true; relist(); fire('join', rec.v); }
    }
    function upsert(peer) {
      if (!peer || typeof peer.id !== 'string') { return; }
      var rec = byId.get(peer.id), st = peer.state, pose = st && typeof st === 'object' && !Array.isArray(st) ? st[POSE_KEY] : null;
      if (!rec) {
        rec = { v: { id: peer.id, name: 'Guest', color: '#8b7bff', wears: [], friend: false, state: null }, vel: {}, to: {}, at: 0, placed: false };
        byId.set(peer.id, rec);
      }
      rec.v.name = String(peer.name || 'Guest');
      rec.v.color = String(peer.color || '#8b7bff');
      var wears = wearOf(peer.wears);
      if (wears.join() !== rec.v.wears.join()) { rec.v.wears = wears; }
      rec.v.friend = peer.friend === true;
      if (pose && typeof pose === 'object' && !Array.isArray(pose)) { place(rec, pose, nowMs()); }
      else if (rec.placed) { rec.placed = false; rec.v.state = null; relist(); fire('leave', rec.v); }
    }
    function remove(id) {
      var rec = byId.get(id);
      if (!rec) { return; }
      byId.delete(id);
      if (rec.placed) { rec.placed = false; relist(); fire('leave', rec.v); }
    }
    var room = roomJoin(function (e) {
      if (!active || !e) { return; }
      if (e.type === 'joined') {
        var seen = {};
        (e.peers || []).forEach(function (p) { if (p && typeof p.id === 'string') { seen[p.id] = 1; upsert(p); } });
        byId.forEach(function (rec, id) { if (!seen[id]) { remove(id); } });
      } else if (e.type === 'join' || e.type === 'state') { upsert(e.peer); }
      else if (e.type === 'leave' && e.peer) { remove(e.peer.id); }
    }, { name: name });
    function sample() {
      if (!active) { return; }
      var now = nowMs(), p, k, dt;
      try { p = cleanPose(read()); readFailed = false; } catch (err) { if (!readFailed) { readFailed = true; later(err); } return; }
      if (p) {
        dt = (now - prevAt) / 1000;
        for (k in VELOCITY_OF) {
          if (!hasOwn.call(VELOCITY_OF, k) || typeof p[k] !== 'number' || hasOwn.call(p, VELOCITY_OF[k])) { continue; }
          p[VELOCITY_OF[k]] = prev && typeof prev[k] === 'number' && dt > 0 && dt < 1 ? round2((p[k] - prev[k]) / dt) : 0;
        }
      }
      prev = p;
      prevAt = now;
      if (samePose(p, sent)) { return; }
      sent = p;
      var rm = rooms[name];
      if (rm) { rm.pose = p; postRoomState(name, rm); }
    }
    c.tick = function (dt, now) {
      var a = 1 - Math.exp(-dt * 10);
      byId.forEach(function (rec) {
        if (!rec.placed) { return; }
        var ahead = Math.min(Math.max((now - rec.at) / 1000, 0), POSE_AHEAD_S), j, k;
        for (j = 0; j < smooth.length; j++) {
          k = smooth[j];
          if (typeof rec.to[k] !== 'number') { continue; }
          if (ANGLES[k]) { rec.v[k] += wrapAngle(rec.to[k] - rec.v[k]) * a; }
          else { rec.v[k] += (rec.to[k] + (rec.vel[k] || 0) * ahead - rec.v[k]) * a; }
        }
      });
      if (c.onTick) { c.onTick(dt, now); }
    };
    function leave() {
      if (!active) { return; }
      active = false;
      clearInterval(timer);
      var rm = rooms[name], i = crowds.indexOf(c);
      if (rm && rm.pose) { rm.pose = null; postRoomState(name, rm); }
      room.leave();
      if (i >= 0) { crowds.splice(i, 1); }
      byId.clear();
      list = [];
    }
    timer = setInterval(sample, POSE_EVERY_MS);
    setTimeout(sample, 0);
    crowds.push(c);
    if (!crowdRunning) { crowdRunning = true; crowdAt = nowMs(); raf(crowdFrame); }
    var handle = Object.freeze({
      get list() { return list; },
      get count() { return byId.size; },
      on: function (type, fn) {
        if (type !== 'join' && type !== 'leave') { throw new TypeError('orb.visitors.on: the event is "join" or "leave"'); }
        if (typeof fn !== 'function') { throw new TypeError('orb.visitors.on: give it a function'); }
        on[type].push(fn);
        return function () { var i = on[type].indexOf(fn); if (i >= 0) { on[type].splice(i, 1); } };
      },
      leave: leave
    });
    return { c: c, handle: handle };
  }
  function visitorsJoin(read, opts) {
    if (opts != null && typeof opts !== 'object') { throw new TypeError('orb.visitors.join: options must be an object, like { room: "match-1" }'); }
    return makeCrowd(read, opts || {}, 'join').handle;
  }

  /* orb.visitors.show: three.js worlds — each visitor as a character the size of yours, with a name tag. */
  var MAX_SHOWN = 40;
  function visitorsShow(o) {
    if (!o || typeof o !== 'object') { throw new TypeError('orb.visitors.show: give it { THREE, scene, camera, player }'); }
    var T = o.THREE, scene = o.scene;
    if (!T || typeof T.Vector3 !== 'function' || typeof T.Mesh !== 'function') { throw new TypeError("orb.visitors.show: pass THREE too (import * as THREE from 'three')"); }
    if (!scene || !scene.isObject3D) { throw new TypeError('orb.visitors.show: pass the scene they should appear in'); }
    if (typeof o.camera !== 'function' && !(o.camera && o.camera.isCamera)) { throw new TypeError('orb.visitors.show: pass the camera (it places the name tags)'); }
    var camOf = typeof o.camera === 'function' ? o.camera : function () { return o.camera; };
    var player = o.player && o.player.isObject3D ? o.player : null, readPose = typeof o.pose === 'function' ? o.pose : null;
    if (!player && !readPose) { throw new TypeError('orb.visitors.show: pass player (your character, or the camera in first person), or pose: () => ({ x, y, z, ry })'); }
    var custom = typeof o.avatar === 'function' ? o.avatar : null, update = typeof o.update === 'function' ? o.update : null, tagsOn = o.tags !== false;
    var height = typeof o.height === 'number' && o.height > 0 ? o.height : 0, feet = 0, eye = 0, measured = false;
    var V = new T.Vector3(), V2 = new T.Vector3(), Q = new T.Quaternion();
    var lastX = null, lastZ = 0, lastT = 0, flip = 0, avatars = new Map(), bits = null, layer = null;
    function measure() {
      if (measured) { return; }
      measured = true;
      if (!player) { height = height || 1.7; return; }
      if (player.isCamera) { height = height || 1.7; eye = typeof o.eye === 'number' ? o.eye : height * 0.92; return; }
      try {
        var b = new T.Box3().setFromObject(player), h = b.max.y - b.min.y;
        player.getWorldPosition(V);
        if (!height) { height = isFinite(h) && h > 0.02 ? h : 1.7; }
        feet = isFinite(b.min.y) ? b.min.y - V.y : 0;
        if (!(Math.abs(feet) < height * 2)) { feet = 0; }
      } catch (err) { height = height || 1.7; }
    }
    function inScene(obj) {
      for (var x = obj; x; x = x.parent) { if (x.visible === false) { return false; } if (x.isScene) { return true; } }
      return false;
    }
    function myPose() {
      measure();
      if (readPose) { return readPose(); }
      if (player.isCamera) {
        player.getWorldPosition(V);
        player.getWorldDirection(V2);
        return { x: V.x, y: V.y - eye, z: V.z, ry: Math.atan2(V2.x, V2.z) };
      }
      if (!inScene(player)) { return null; }
      player.getWorldPosition(V);
      player.getWorldQuaternion(Q);
      V2.set(0, 0, 1).applyQuaternion(Q);
      var ry = Math.atan2(V2.x, V2.z), t = nowMs(), dt, vx, vz, sp, fl;
      /* A model built facing -z walks "backwards": seen from its steps, turn it around for others. */
      if (lastX !== null && t > lastT) {
        dt = (t - lastT) / 1000; vx = (V.x - lastX) / dt; vz = (V.z - lastZ) / dt; sp = Math.sqrt(vx * vx + vz * vz);
        fl = Math.sqrt(V2.x * V2.x + V2.z * V2.z);
        if (dt < 1 && sp > height * 0.6 && fl > 0.3) {
          var dot = (V2.x * vx + V2.z * vz) / (sp * fl);
          flip = Math.max(-2, Math.min(2, flip + (dot < -0.5 ? dt : dot > 0.5 ? -dt : 0)));
        }
      }
      lastX = V.x; lastZ = V.z; lastT = t;
      return { x: V.x, y: V.y + feet, z: V.z, ry: flip > 1 ? wrapAngle(ry + Math.PI) : ry };
    }
    function shared() {
      if (bits) { return bits; }
      var cv = D.createElement('canvas'), g;
      cv.width = cv.height = 64;
      g = cv.getContext('2d');
      if (g) {
        var gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
        gr.addColorStop(0, 'rgba(0,0,0,0.45)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr;
        g.fillRect(0, 0, 64, 64);
      }
      var lv = D.createElement('canvas'), lg;
      lv.width = lv.height = 64;
      lg = lv.getContext('2d');
      if (lg) {
        var lr = lg.createRadialGradient(32, 32, 0, 32, 32, 32);
        lr.addColorStop(0, 'rgba(255,255,255,1)');
        lr.addColorStop(0.3, 'rgba(255,255,255,0.5)');
        lr.addColorStop(1, 'rgba(255,255,255,0)');
        lg.fillStyle = lr;
        lg.fillRect(0, 0, 64, 64);
      }
      bits = {
        ball: new T.SphereGeometry(0.5, 24, 16),
        disc: new T.CircleGeometry(0.5, 24),
        eye: new T.MeshStandardMaterial({ color: 0x1d1b2a, roughness: 0.25 }),
        blob: new T.MeshBasicMaterial({ map: new T.CanvasTexture(cv), transparent: true, depthWrite: false }),
        light: new T.CanvasTexture(lv)
      };
      return bits;
    }
    /* What blobs wear (v.wears: their look on Orb, src/lib/looks.ts): shapes and materials shared by every visitor. */
    function kit() {
      var b = shared();
      if (b.kit) { return b.kit; }
      function std(c, rough, metal) { return new T.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal || 0 }); }
      var gold = std(0xffc53d, 0.3, 0.6);
      gold.emissive = new T.Color(0x4a3000);
      b.kit = {
        ball: b.ball,
        cone: new T.ConeGeometry(0.5, 1, 24),
        cyl: new T.CylinderGeometry(0.5, 0.5, 1, 28),
        band: new T.CylinderGeometry(0.5, 0.5, 1, 28, 1, true),
        ring: new T.TorusGeometry(0.5, 0.07, 10, 36),
        gold: gold,
        bandGold: (function () { var m = gold.clone(); m.side = T.DoubleSide; return m; })(),
        ruby: std(0xff3d6e, 0.2, 0.1),
        sapphire: std(0x45b8ff, 0.2, 0.1),
        white: std(0xfffaf5, 0.6),
        pink: std(0xff78ad, 0.55),
        sun: std(0xffd84d, 0.5),
        night: std(0x2a2633, 0.45),
        red: std(0xe0485f, 0.5),
        leaf: std(0x5fcf6b, 0.5),
        stem: std(0x3f9b4f, 0.6),
        inner: std(0xffb6cf, 0.6),
        frame: std(0x6b4a2b, 0.35, 0.2),
        lens: std(0x15131d, 0.12, 0.35),
        glow: new T.MeshBasicMaterial({ color: 0xffe27a, toneMapped: false }),
        shine: new T.SpriteMaterial({ map: b.light, color: 0xffd76a, transparent: true, opacity: 0.28, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false }),
        gleam: new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 }),
        blush: new T.MeshBasicMaterial({ color: 0xff4f86, transparent: true, opacity: 0.6, depthWrite: false })
      };
      return b.kit;
    }
    /* A piece in units of the character's height h: size, place and turn. */
    function put(g, geo, mat, h, s, p, r) {
      var m = new T.Mesh(geo, mat);
      m.scale.set(s[0] * h, s[1] * h, s[2] * h);
      m.position.set(p[0] * h, p[1] * h, p[2] * h);
      if (r) { m.rotation.set(r[0], r[1], r[2]); }
      m.castShadow = true;
      g.add(m);
      return m;
    }
    /* Head things sit on the top of the head (the group's origin); face things are placed on the blob. */
    var WEAR = {
      sprout: ['head', function (k, g, h) {
        put(g, k.cyl, k.stem, h, [0.022, 0.12, 0.022], [0, 0.04, 0]);
        put(g, k.ball, k.leaf, h, [0.11, 0.026, 0.06], [-0.05, 0.105, 0], [0, 0, -0.5]);
        put(g, k.ball, k.leaf, h, [0.11, 0.026, 0.06], [0.05, 0.105, 0], [0, 0, 0.5]);
      }],
      flower: ['head', function (k, g, h) {
        var f = new T.Group(), i, a;
        for (i = 0; i < 6; i++) { a = i * Math.PI / 3; put(f, k.ball, k.white, h, [0.095, 0.03, 0.055], [Math.cos(a) * 0.065, 0, Math.sin(a) * 0.065], [0, -a, 0]); }
        put(f, k.ball, k.sun, h, [0.07, 0.045, 0.07], [0, 0.012, 0]);
        f.position.set(0.12 * h, -0.045 * h, 0.08 * h);
        f.rotation.set(0.6, 0, -0.7);
        g.add(f);
      }],
      'party-hat': ['head', function (k, g, h) {
        var hat = new T.Group();
        put(hat, k.cone, k.pink, h, [0.24, 0.32, 0.24], [0, 0.16, 0]);
        put(hat, k.ring, k.white, h, [0.18, 0.18, 0.18], [0, 0.08, 0], [Math.PI / 2, 0, 0]);
        put(hat, k.ring, k.white, h, [0.105, 0.105, 0.105], [0, 0.18, 0], [Math.PI / 2, 0, 0]);
        put(hat, k.ball, k.sun, h, [0.075, 0.075, 0.075], [0, 0.325, 0]);
        hat.position.set(0.025 * h, -0.035 * h, 0);
        hat.rotation.z = -0.22;
        g.add(hat);
      }],
      'bunny-ears': ['head', function (k, g, h) {
        for (var s = -1; s <= 1; s += 2) {
          put(g, k.ball, k.white, h, [0.095, 0.32, 0.06], [s * 0.08, 0.12, -0.01], [0, 0, -s * 0.2]);
          put(g, k.ball, k.inner, h, [0.05, 0.23, 0.024], [s * 0.082, 0.12, 0.016], [0, 0, -s * 0.2]);
        }
      }],
      'top-hat': ['head', function (k, g, h) {
        var hat = new T.Group();
        put(hat, k.cyl, k.night, h, [0.36, 0.018, 0.36], [0, 0, 0]);
        put(hat, k.cyl, k.night, h, [0.22, 0.24, 0.22], [0, 0.125, 0]);
        put(hat, k.cyl, k.red, h, [0.228, 0.045, 0.228], [0, 0.035, 0]);
        hat.position.y = -0.02 * h;
        hat.rotation.set(-0.05, 0, 0.12);
        g.add(hat);
      }],
      halo: ['head', function (k, g, h) {
        put(g, k.ring, k.glow, h, [0.28, 0.28, 0.28], [0, 0.13, 0], [Math.PI / 2 - 0.12, 0, 0]).castShadow = false;
        var s = new T.Sprite(k.shine);
        s.scale.setScalar(0.38 * h);
        s.position.y = 0.13 * h;
        g.add(s);
      }],
      crown: ['head', function (k, g, h) {
        var i, a;
        put(g, k.band, k.bandGold, h, [0.3, 0.08, 0.3], [0, -0.02, 0]);
        for (i = 0; i < 5; i++) {
          a = i * Math.PI * 2 / 5;
          put(g, k.cone, k.gold, h, [0.05, 0.075, 0.05], [Math.sin(a) * 0.15, 0.057, Math.cos(a) * 0.15]);
          put(g, k.ball, k.gold, h, [0.026, 0.026, 0.026], [Math.sin(a) * 0.15, 0.098, Math.cos(a) * 0.15]);
        }
        put(g, k.ball, k.ruby, h, [0.042, 0.042, 0.02], [0, -0.02, 0.152]);
        put(g, k.ball, k.sapphire, h, [0.03, 0.03, 0.016], [0.122, -0.02, 0.09], [0, 0.93, 0]);
        put(g, k.ball, k.sapphire, h, [0.03, 0.03, 0.016], [-0.122, -0.02, 0.09], [0, -0.93, 0]);
      }],
      blush: ['face', function (k, g, h) {
        for (var s = -1; s <= 1; s += 2) { put(g, k.ball, k.blush, h, [0.075, 0.045, 0.02], [s * 0.185, 0.5, 0.222], [0, s * 0.62, 0]).castShadow = false; }
      }],
      'round-glasses': ['face', function (k, g, h) {
        for (var s = -1; s <= 1; s += 2) { put(g, k.ring, k.frame, h, [0.15, 0.15, 0.15], [s * 0.12, 0.585, 0.29], [0, s * 0.32, 0]); }
        put(g, k.cyl, k.frame, h, [0.012, 0.075, 0.012], [0, 0.6, 0.302], [0, 0, Math.PI / 2]);
      }],
      shades: ['face', function (k, g, h) {
        for (var s = -1; s <= 1; s += 2) {
          var lens = new T.Group();
          lens.position.set(s * 0.118 * h, 0.585 * h, 0.29 * h);
          lens.rotation.y = s * 0.32;
          put(lens, k.ball, k.lens, h, [0.155, 0.105, 0.03], [0, 0, 0]);
          put(lens, k.ball, k.gleam, h, [0.04, 0.02, 0.01], [-0.03, 0.022, 0.014], [0, 0, 0.3]).castShadow = false;
          g.add(lens);
        }
        put(g, k.cyl, k.lens, h, [0.014, 0.07, 0.014], [0, 0.605, 0.305], [0, 0, Math.PI / 2]);
      }]
    };
    /* Put on what they wear (again when it changes): on the blob, and the head thing on their orb when they fly. */
    function wearOn(a, v) {
      if (a.custom || a.wornRef === v.wears) { return; }
      a.wornRef = v.wears;
      var list = v.wears || [], key = list.join(), h = height, i, w, g;
      if (key === a.wornKey) { return; }
      a.wornKey = key;
      for (i = 0; i < a.worn.length; i++) { if (a.worn[i].parent) { a.worn[i].parent.remove(a.worn[i]); } }
      a.worn = [];
      for (i = 0; i < list.length; i++) {
        w = hasOwn.call(WEAR, list[i]) ? WEAR[list[i]] : null;
        if (!w) { continue; }
        g = new T.Group();
        g.name = 'orb-look:' + list[i];
        w[1](kit(), g, h);
        if (w[0] === 'head') { g.position.y = 0.86 * h; }
        a.rig.add(g);
        a.worn.push(g);
        if (w[0] === 'head' && a.wisp) {
          g = new T.Group();
          w[1](kit(), g, h);
          g.position.y = 0.155 * h;
          g.scale.setScalar(0.6);
          a.wisp.bob.add(g);
          a.worn.push(g);
        }
      }
    }
    /* A soft little bean in the visitor's color, its feet at the origin, facing +z. */
    function bean(v) {
      var b = shared(), h = height, group = new T.Group(), rig = new T.Group(), col = new T.Color(v.color);
      var mat = new T.MeshStandardMaterial({ color: col, roughness: 0.55 });
      var dark = new T.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.72), roughness: 0.6 });
      var body = new T.Mesh(b.ball, mat), feetM = [], s;
      body.scale.set(0.62 * h, 0.8 * h, 0.56 * h);
      body.position.y = 0.46 * h;
      body.castShadow = true;
      rig.add(body);
      for (s = -1; s <= 1; s += 2) {
        var eyeM = new T.Mesh(b.ball, b.eye), foot = new T.Mesh(b.ball, dark);
        eyeM.scale.set(0.075 * h, 0.1 * h, 0.06 * h);
        eyeM.position.set(s * 0.12 * h, 0.58 * h, 0.255 * h);
        foot.scale.set(0.2 * h, 0.11 * h, 0.27 * h);
        foot.position.set(s * 0.15 * h, 0.055 * h, 0.02 * h);
        foot.castShadow = true;
        rig.add(eyeM, foot);
        feetM.push(foot);
      }
      var blob = new T.Mesh(b.disc, b.blob);
      blob.rotation.x = -Math.PI / 2;
      blob.scale.setScalar(0.8 * h);
      blob.position.y = 0.01 * h;
      group.add(rig, blob);
      return { group: group, rig: rig, blob: blob, feet: feetM, mats: [mat, dark], custom: false, phase: Math.random() * 6 };
    }
    /* Someone flying around (fly: true in their pose: a free camera, no body): a glowing orb in their
       color where they are, its eyes looking where they look, and a light that stays a few pixels big
       however far away they fly. */
    function wisp(v) {
      var b = shared(), h = height, col = new T.Color(v.color), group = new T.Group(), bob = new T.Group(), s;
      var add = T.AdditiveBlending;
      var coreMat = new T.MeshBasicMaterial({ color: col, toneMapped: false });
      var haloMat = new T.SpriteMaterial({ map: b.light, color: col, transparent: true, opacity: 0.7, depthWrite: false, blending: add, fog: false, toneMapped: false });
      var farMat = new T.SpriteMaterial({ map: b.light, color: col, transparent: true, depthWrite: false, blending: add, fog: false, toneMapped: false, sizeAttenuation: false });
      var core = new T.Mesh(b.ball, coreMat), halo = new T.Sprite(haloMat), far = new T.Sprite(farMat);
      core.scale.setScalar(0.34 * h);
      bob.add(core);
      for (s = -1; s <= 1; s += 2) {
        var e = new T.Mesh(b.ball, b.eye);
        e.scale.set(0.062 * h, 0.08 * h, 0.05 * h);
        e.position.set(s * 0.066 * h, 0.028 * h, 0.155 * h);
        bob.add(e);
      }
      halo.scale.setScalar(h);
      far.scale.setScalar(0.03);
      bob.add(halo, far);
      group.add(bob);
      group.name = 'orb-flying';
      group.visible = false;
      return { group: group, bob: bob, halo: halo, mats: [coreMat, haloMat, farMat] };
    }
    function tagLayer() {
      if (layer) { return layer; }
      layer = D.createElement('div');
      layer.setAttribute('data-orb-visitors', '');
      layer.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:30;contain:strict';
      (D.body || D.documentElement).appendChild(layer);
      return layer;
    }
    function makeTag() {
      var el = D.createElement('div'), dot = D.createElement('span'), heart = D.createElement('span'), label = D.createElement('span');
      el.style.cssText = 'position:absolute;left:0;top:0;display:none;align-items:center;gap:5px;padding:3px 9px 3px 7px;border-radius:999px;background:rgba(16,16,28,.5);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);color:#fff;font:600 12px/16px ui-rounded,system-ui,-apple-system,sans-serif;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,.18);will-change:transform,opacity';
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;flex:none;box-shadow:0 0 0 1.5px rgba(255,255,255,.8)';
      heart.style.cssText = 'display:none;color:#ff8fc8';
      heart.textContent = '\u2665';
      el.appendChild(dot);
      el.appendChild(heart);
      el.appendChild(label);
      tagLayer().appendChild(el);
      return { el: el, dot: dot, heart: heart, label: label, text: null, color: null, friend: null, shown: false, w: 0 };
    }
    function paintTag(tag, v) {
      if (tag.text !== v.name) { tag.text = v.name; tag.w = 0; tag.label.textContent = v.name.length > 24 ? v.name.slice(0, 23) + '\u2026' : v.name; }
      if (tag.color !== v.color) { tag.color = v.color; tag.dot.style.background = v.color; }
      if (tag.friend !== v.friend) { tag.friend = v.friend; tag.w = 0; tag.heart.style.display = v.friend ? '' : 'none'; }
    }
    /* Tags that would cover each other step up out of the way: friends first, then the nearest. */
    var TAG_H = 22;
    function spreadTags(shown) {
      shown.sort(function (p, q) { return (q.friend ? 1 : 0) - (p.friend ? 1 : 0) || p.d - q.d; });
      var placed = [], forClip = [], i, j, s, tries, hit;
      for (i = 0; i < shown.length; i++) {
        s = shown[i];
        if (!s.tag.w) { s.tag.w = s.tag.el.offsetWidth || 80; }
        for (tries = 0; tries < 6; tries++) {
          hit = false;
          for (j = 0; j < placed.length; j++) {
            if (Math.abs(placed[j].x - s.x) < (placed[j].w + s.tag.w) / 2 + 4 && Math.abs(placed[j].y - s.y) < TAG_H + 3) { hit = true; break; }
          }
          if (!hit) { break; }
          s.y -= TAG_H + 4;
        }
        placed.push({ x: s.x, y: s.y, w: s.tag.w });
        s.tag.el.style.transform = 'translate(' + s.x + 'px,' + s.y + 'px) translate(-50%,-100%)';
        forClip.push({ x: s.x, y: s.y, w: s.tag.w, text: s.tag.label.textContent, color: s.tag.color, friend: s.tag.friend, op: Number(s.tag.el.style.opacity) || 1 });
      }
      clipTags = forClip;
    }
    function hideTag(tag) { if (tag && tag.shown) { tag.shown = false; tag.el.style.display = 'none'; } }
    function avatarFor(v) {
      measure();
      var a = null, obj = null;
      if (custom) {
        try { obj = custom(v); } catch (err) { later(err); }
        if (obj && obj.isObject3D) { a = { group: new T.Group(), object: obj, mats: [], custom: true, phase: 0 }; a.group.add(obj); }
      }
      if (!a) { a = bean(v); }
      scene.add(a.group);
      a.tag = tagsOn ? makeTag() : null;
      a.wisp = null;
      a.flying = false;
      a.worn = [];
      a.wornRef = null;
      a.wornKey = '';
      return a;
    }
    /* In and out of flight: the orb shows instead of the character, and back. */
    function setFlying(a, v, on) {
      a.flying = on;
      if (on && !a.wisp) {
        a.wisp = wisp(v);
        a.group.add(a.wisp.group);
        a.mats.push.apply(a.mats, a.wisp.mats);
        if (!a.phase) { a.phase = Math.random() * 6; }
        a.wornRef = a.wornKey = null;
      }
      if (a.wisp) { a.wisp.group.visible = on; }
      if (a.custom) { a.object.visible = !on; }
      else { a.rig.visible = !on; a.blob.visible = !on; }
    }
    function drop(id, a) {
      avatars.delete(id);
      if (a.group.parent) { a.group.parent.remove(a.group); }
      for (var i = 0; i < a.mats.length; i++) { a.mats[i].dispose(); }
      if (a.tag && a.tag.el.parentNode) { a.tag.el.parentNode.removeChild(a.tag.el); }
    }
    var made = makeCrowd(myPose, { room: o.room, snap: function () { return (height || 1.7) * 12; } }, 'show');
    made.c.onTick = function (dt, now) {
      var cam = camOf(), list = made.handle.list, seen = {}, near = null, tagged = [], i, v, a, x, y, z, flying;
      if (cam && cam.isCamera) { V2.setFromMatrixPosition(cam.matrixWorld); } else { cam = null; }
      if (list.length > MAX_SHOWN && cam) {
        near = {};
        list.map(function (w) { var dx = (w.x || 0) - V2.x, dz = (w.z || 0) - V2.z; return { id: w.id, d: dx * dx + dz * dz }; })
          .sort(function (p, q) { return p.d - q.d; })
          .slice(0, MAX_SHOWN)
          .forEach(function (e) { near[e.id] = 1; });
      }
      for (i = 0; i < list.length; i++) {
        v = list[i];
        seen[v.id] = 1;
        a = avatars.get(v.id);
        if (!a) { a = avatarFor(v); avatars.set(v.id, a); }
        x = typeof v.x === 'number' ? v.x : 0; y = typeof v.y === 'number' ? v.y : 0; z = typeof v.z === 'number' ? v.z : 0;
        a.group.visible = !near || !!near[v.id];
        flying = v.fly === true;
        if (flying !== a.flying) { setFlying(a, v, flying); }
        wearOn(a, v);
        a.group.position.set(x, y - (a.custom && !flying ? feet : 0), z);
        a.group.rotation.y = typeof v.ry === 'number' ? v.ry : 0;
        if (flying) {
          a.wisp.bob.position.y = Math.sin(now / 1000 * 1.7 + a.phase) * 0.05 * height;
          a.wisp.halo.scale.setScalar(height * (1 + Math.sin(now / 1000 * 2.3 + a.phase) * 0.08));
        } else if (a.custom) {
          if (update) { try { update(v, a.object, dt); } catch (err) { if (!a.failed) { a.failed = true; later(err); } } }
        } else {
          var sp = Math.sqrt((v.vx || 0) * (v.vx || 0) + (v.vz || 0) * (v.vz || 0)), move = Math.min(1, sp / (height * 1.5)), h = height;
          a.phase += dt * (3 + (sp / h) * 2.4);
          a.rig.position.y = Math.abs(Math.sin(a.phase)) * 0.06 * h * move;
          a.rig.rotation.x = 0.12 * move;
          a.rig.scale.y = 1 + Math.sin(now / 1000 * 2.6 + a.phase * 0.1) * 0.015 * (1 - move);
          a.feet[0].position.z = 0.02 * h + Math.sin(a.phase) * 0.1 * h * move;
          a.feet[1].position.z = 0.02 * h - Math.sin(a.phase) * 0.1 * h * move;
        }
        if (!a.tag) { continue; }
        if (!cam || !a.group.visible) { hideTag(a.tag); continue; }
        /* A light in the sky is seen from farther away than someone standing in the snow. */
        V.set(x, y + height * (flying ? 0.4 : 1.1), z);
        var reach = height * (flying ? 90 : 18), dist = V.distanceTo(V2), fade = Math.min(1, Math.max(0, 1 - (dist - reach) / reach));
        V.project(cam);
        if (V.z < -1 || V.z > 1 || Math.abs(V.x) > 1.15 || Math.abs(V.y) > 1.15 || fade < 0.04) { hideTag(a.tag); continue; }
        paintTag(a.tag, v);
        if (!a.tag.shown) { a.tag.shown = true; a.tag.el.style.display = 'flex'; }
        a.tag.el.style.opacity = String(Math.round(fade * 100) / 100);
        tagged.push({ tag: a.tag, friend: v.friend, d: dist, x: Math.round((V.x + 1) * 0.5 * W.innerWidth), y: Math.round((1 - V.y) * 0.5 * W.innerHeight) });
      }
      spreadTags(tagged);
      avatars.forEach(function (av, id) { if (!seen[id]) { drop(id, av); } });
    };
    return Object.freeze({
      get list() { return made.handle.list; },
      get count() { return made.handle.count; },
      on: made.handle.on,
      leave: function () {
        made.handle.leave();
        avatars.forEach(function (av, id) { drop(id, av); });
        if (layer && layer.parentNode) { layer.parentNode.removeChild(layer); }
        layer = null;
        clipTags = [];
      }
    });
  }

  /* ===== Clips: a few seconds of the world as a video to share (parent sends 'clip-request') ===== */
  /* The main canvas, redrawn every frame onto a canvas of at most 1280 px with the visitors' name
     tags and a small label (the world's address); recorded with MediaRecorder, mp4 where the
     browser can, else webm. The world's own HTML on top of its canvas isn't in it. */
  var clipTags = [], clipping = false;
  var CLIP_TYPES = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  function clipType() {
    var MR = W.MediaRecorder;
    if (typeof MR !== 'function') { return null; }
    if (typeof MR.isTypeSupported !== 'function') { return ''; }
    for (var i = 0; i < CLIP_TYPES.length; i++) { if (MR.isTypeSupported(CLIP_TYPES[i])) { return CLIP_TYPES[i]; } }
    return '';
  }
  function pill(g, x, y, w, h) {
    var r = h / 2;
    g.beginPath();
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2); g.lineTo(x + r, y + h); g.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5);
    g.closePath();
  }
  function drawClipTag(g, t, x, y, k) {
    var h = 22 * k, w = (t.w || 80) * k, left = x - w / 2, top = y - h;
    g.globalAlpha = t.op;
    g.fillStyle = 'rgba(16,16,28,.55)';
    pill(g, left, top, w, h);
    g.fill();
    g.fillStyle = t.color || '#8b7bff';
    g.beginPath(); g.arc(left + 11 * k, top + h / 2, 4 * k, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff';
    g.font = '600 ' + Math.round(12 * k) + 'px ui-rounded, system-ui, -apple-system, sans-serif';
    g.textBaseline = 'middle';
    g.fillText((t.friend ? '\u2665 ' : '') + t.text, left + 20 * k, top + h / 2 + 0.5 * k);
    g.globalAlpha = 1;
  }
  function drawClipLabel(g, text, cw, ch) {
    var k = Math.max(0.8, Math.min(cw, ch) / 640), pad = 14 * k, h = 30 * k;
    g.font = '600 ' + Math.round(13 * k) + 'px ui-rounded, system-ui, -apple-system, sans-serif';
    var w = g.measureText(text).width + 44 * k, x = pad, y = ch - pad - h;
    g.fillStyle = 'rgba(16,16,28,.55)';
    pill(g, x, y, w, h);
    g.fill();
    var orbX = x + 15 * k, orbY = y + h / 2, grad = g.createLinearGradient(orbX - 7 * k, orbY - 7 * k, orbX + 7 * k, orbY + 7 * k);
    grad.addColorStop(0, '#8b7bff'); grad.addColorStop(0.4, '#5ec8ff'); grad.addColorStop(0.7, '#ffb38a'); grad.addColorStop(1, '#ff8fc8');
    g.fillStyle = grad;
    g.beginPath(); g.arc(orbX, orbY, 7 * k, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff';
    g.textBaseline = 'middle';
    g.fillText(text, x + 30 * k, orbY + 0.5 * k);
  }
  function postTransfer(msg, transfer) {
    if (!EMBEDDED) { return; }
    msg.__orb = 1;
    try { PARENT.postMessage(msg, '*', transfer); } catch (e) { post(msg); }
  }
  function recordClip(d) {
    var reqId = d.reqId;
    function fail(why) { clipping = false; post({ type: 'clip-result', reqId: reqId, error: why }); }
    if (clipping) { post({ type: 'clip-result', reqId: reqId, error: 'busy' }); return; }
    var src = bestCanvas(), type = clipType();
    if (!src) { fail('no_canvas'); return; }
    if (type === null || typeof HTMLCanvasElement.prototype.captureStream !== 'function') { fail('unsupported'); return; }
    var ms = Math.max(1000, Math.min(15000, Number(d.ms) || 8000));
    var r = src.getBoundingClientRect(), k = Math.min(1, 1280 / (Math.max(r.width, r.height) || 1));
    var cw = Math.max(2, Math.round((r.width * k) / 2) * 2), ch = Math.max(2, Math.round((r.height * k) / 2) * 2);
    var out = D.createElement('canvas'), g, stream, rec, chunks = [], stopped = false, t0;
    out.width = cw; out.height = ch;
    g = out.getContext('2d');
    if (!g) { fail('unsupported'); return; }
    try {
      stream = out.captureStream(30);
      rec = type ? new W.MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 4000000 }) : new W.MediaRecorder(stream);
    } catch (e) { fail('unsupported'); return; }
    var label = typeof d.label === 'string' ? clip(d.label, 80) : '';
    var sx = cw / (r.width || cw), sy = ch / (r.height || ch);
    clipping = true;
    function draw() {
      try { g.drawImage(src, 0, 0, src.width, src.height, 0, 0, cw, ch); } catch (e) { /* a lost context: keep the last picture */ }
      for (var i = 0; i < clipTags.length; i++) { drawClipTag(g, clipTags[i], (clipTags[i].x - r.left) * sx, (clipTags[i].y - r.top) * sy, sx); }
      if (label) { drawClipLabel(g, label, cw, ch); }
    }
    function frame() {
      if (stopped) { return; }
      draw();
      if (nowMs() - t0 >= ms) { stopped = true; try { rec.stop(); } catch (e) { fail('recorder'); } return; }
      raf(frame);
    }
    rec.ondataavailable = function (e) { if (e.data && e.data.size) { chunks.push(e.data); } };
    rec.onerror = function () { if (!stopped) { stopped = true; fail('recorder'); } };
    rec.onstop = function () {
      try { stream.getTracks().forEach(function (tr) { tr.stop(); }); } catch (e) { /* ignore */ }
      var blob = new Blob(chunks, { type: String(rec.mimeType || type || 'video/webm').split(';')[0] });
      if (!blob.size) { fail('empty'); return; }
      blob.arrayBuffer().then(function (buf) {
        clipping = false;
        postTransfer({ type: 'clip-result', reqId: reqId, mime: blob.type, data: buf }, [buf]);
      }, function () { fail('read'); });
    };
    draw();
    t0 = nowMs();
    rec.start(250);
    raf(frame);
  }

  /* ===== SDK: capture / toast / title ===== */
  var lastCapture = 0;
  function capture() {
    var now = Date.now();
    if (now - lastCapture < 3000) { return; }
    lastCapture = now;
    /* Wait two frames so whatever the world just set up has been drawn. */
    raf(function () { raf(function () { var url = safeGrab(); if (url) { post({ type: 'capture', dataUrl: url }); } }); });
  }
  function toast(text) {
    var t = clip(describe(text), 140).trim();
    if (t) { post({ type: 'toast', text: t }); }
  }
  var lastTitle = null, titleTimer = 0;
  function postTitle() {
    clearTimeout(titleTimer);
    titleTimer = setTimeout(function () {
      var t = clip(String(D.title || '').trim(), 120);
      if (t && t !== lastTitle) { lastTitle = t; post({ type: 'title', text: t }); }
    }, 250);
  }

  var me = P.me || {}, world = P.world || {};
  var orb = {
    world: Object.freeze({ id: String(world.id || ''), name: String(world.name || '') }),
    me: Object.freeze({ id: String(me.id || ''), name: String(me.name || 'Guest'), color: String(me.color || '#8b7bff'), wears: Object.freeze(wearOf(me.wears)) }),
    store: store,
    room: Object.freeze({ join: roomJoin, invite: roomInvite, invited: invited }),
    visitors: Object.freeze({ join: visitorsJoin, show: visitorsShow }),
    shop: shop,
    capture: capture,
    toast: toast
  };
  try { Object.defineProperty(W, 'orb', { value: Object.freeze(orb), writable: false, enumerable: false, configurable: false }); } catch (e) { /* ignore */ }

  /* ===== Ready ===== */
  function onLoad() {
    raf(function () { raf(function () { post({ type: 'ready' }); postTitle(); }); });
    try {
      if (W.MutationObserver && D.head) { new MutationObserver(postTitle).observe(D.head, { childList: true, subtree: true, characterData: true }); }
    } catch (e) { /* ignore */ }
  }
  if (D.readyState === 'complete') { onLoad(); } else { W.addEventListener('load', onLoad); }
})
`;

/** The runtime collapsed to one line (block comments stripped, line breaks + indentation → one space). */
export const RUNTIME_SCRIPT: string = RUNTIME_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/[ \t]*\n\s*/g, ' ')
  .trim();

// ---------------------------------------------------------------------------------------------
// Injection

/** JSON that is safe inside an inline <script>: no `<` (so no `</script` / `<!--`), no U+2028/9. */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Offsets where each line starts; `lineAt` binary-searches them. CRLF / CR count as one break. */
function lineStarts(src: string): number[] {
  const starts = [0];
  const re = /\r\n|\r|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) starts.push(m.index + m[0].length);
  return starts;
}
function lineAt(starts: number[], index: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: index - starts[lo] + 1 };
}

// Attribute-aware tag patterns (a `>` inside a quoted attribute value does not end the tag).
const ATTRS = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const PROLOG_ITEM = /\s+|<!--[\s\S]*?-->|<!doctype[^>]*>|<\?[^>]*>/iy;
const HTML_OPEN = new RegExp(`<html(?=[\\s>/])${ATTRS}>`, 'iy');
const HEAD_OPEN = new RegExp(`<head(?=[\\s>/])${ATTRS}>`, 'iy');
const SCRIPT_OPEN = new RegExp(`<script(?=[\\s>/])(${ATTRS})>`, 'gi');
const SCRIPT_CLOSE = /<\/script\s*>/gi;
const SRC_ATTR = /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/** Skip whitespace, comments, doctype and XML processing instructions starting at `pos`. */
function skipProlog(src: string, pos: number): number {
  for (;;) {
    PROLOG_ITEM.lastIndex = pos;
    const m = PROLOG_ITEM.exec(src);
    if (!m || m[0].length === 0) return pos;
    pos += m[0].length;
  }
}
function matchAt(re: RegExp, src: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(src);
}

/**
 * Where the runtime goes: right after `<head …>` when the document has one at the top, else right
 * after `<html …>`, else after the doctype/leading comments. A bare <script> there makes the
 * HTML parser create the <head> implicitly, so the runtime is always head's first child.
 */
function insertionPoint(src: string): number {
  let pos = skipProlog(src, 0);
  const html = matchAt(HTML_OPEN, src, pos);
  if (html) {
    const afterHtml = pos + html[0].length;
    const p = skipProlog(src, afterHtml);
    const head = matchAt(HEAD_OPEN, src, p);
    return head ? p + head[0].length : afterHtml;
  }
  const head = matchAt(HEAD_OPEN, src, pos);
  if (head) pos += head[0].length;
  return pos;
}

/** Map every <script> of the document to the line where its content starts (see RuntimePayload). */
function scanScripts(src: string, starts: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  let count = 0;
  SCRIPT_OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCRIPT_OPEN.exec(src)) && count < 300) {
    const contentStart = m.index + m[0].length;
    SCRIPT_CLOSE.lastIndex = contentStart;
    const close = SCRIPT_CLOSE.exec(src);
    const contentEnd = close ? close.index : src.length;
    const srcAttr = SRC_ATTR.exec(m[1]);
    const key = srcAttr
      ? `s:${srcAttr[1] ?? srcAttr[2] ?? srcAttr[3] ?? ''}`
      : `t:${src.slice(contentStart, contentEnd).replace(/\r\n?/g, '\n').trim().slice(0, 64)}`;
    if (!(key in out)) {
      out[key] = lineAt(starts, contentStart).line;
      count++;
    }
    SCRIPT_OPEN.lastIndex = close ? close.index + close[0].length : src.length;
  }
  return out;
}

/** Insert the runtime <script> as the first child of <head> (creating head/html if needed). */
export function injectRuntime(html: string, ctx: RuntimeContext): string {
  // A BOM before the doctype would push the document into quirks mode; it carries no content.
  const src = html.charCodeAt(0) === 0xfeff ? html.slice(1) : html;
  const starts = lineStarts(src);
  const at = insertionPoint(src);
  const where = lineAt(starts, at);
  const payload: RuntimePayload = {
    world: { id: String(ctx.worldId ?? ''), name: String(ctx.worldName ?? '') },
    me: { id: String(ctx.me?.id ?? ''), name: String(ctx.me?.name ?? ''), color: String(ctx.me?.color ?? ''), wears: (ctx.me?.wears ?? []).filter((x) => typeof x === 'string').slice(0, 4) },
    storage: Object.entries(ctx.storage ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'),
    scripts: scanScripts(src, starts),
    rt: [where.line, where.col, 0],
    limits: { storage: WORLD_STORAGE_LIMIT, store: STORE_VALUE_LIMIT },
    room: typeof ctx.room === 'string' && ROOM_NAME_RE.test(ctx.room) ? ctx.room : null,
  };
  // No line breaks anywhere in the tag, so the world's own line numbers stay exactly the same.
  // The tag's end column is part of its own payload: iterate until the length is stable.
  let tag = '';
  for (let i = 0; i < 4; i++) {
    tag = `<script ${RUNTIME_ATTR}>${RUNTIME_SCRIPT}(${scriptSafeJson(payload)});</script>`;
    const end = where.col + tag.length;
    if (end === payload.rt[2]) break;
    payload.rt[2] = end;
  }
  return src.slice(0, at) + tag + src.slice(at);
}
