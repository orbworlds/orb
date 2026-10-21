// Import a public GitHub repository as a multi-file world: download its tarball, keep the files
// (skipping .git, node_modules and oversized files), find the page to run (index.html) and store
// everything as a file tree (see ./files.ts). Plain HTML/JS projects run as-is; projects that need
// a build step (Vite, TypeScript…) are imported but flagged, since worlds have no build step yet.

import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import type { Db } from './db';
import { cleanPath, ENTRY, FILE_LIMITS, FileError, putBlob, putTree, type Tree } from './files';
import { SITE } from '../lib/site';

const MAX_DOWNLOAD = 300_000_000; // compressed bytes
// orb-kit: the Orb kit that open-source worlds' repositories carry to run on localhost
export const SKIP_DIR = /(^|\/)(\.git|node_modules|\.github|\.vscode|\.idea|__pycache__|orb-kit)(\/|$)/;
const ENTRY_DIRS = ['', 'public', 'docs', 'dist', 'build', 'www', 'web', 'site', 'app'];

interface RepoRef {
  owner: string;
  repo: string;
  ref: string | null;
  dir: string;
}

/** github.com/<owner>/<repo>[/tree/<ref>/<dir>] → parts (null if it isn't a GitHub repo URL). */
export function parseRepoUrl(raw: string): RepoRef | null {
  let u: URL;
  try {
    u = new URL(raw.trim().replace(/^(?!https?:\/\/)/, 'https://'));
  } catch {
    return null;
  }
  if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repoRaw, kind, ref, ...rest] = parts;
  const repo = repoRaw.replace(/\.git$/, '');
  if (!/^[\w.-]{1,100}$/.test(owner) || !/^[\w.-]{1,100}$/.test(repo)) return null;
  if (kind === 'tree' && ref) return { owner, repo, ref, dir: rest.join('/') };
  return { owner, repo, ref: null, dir: '' };
}

/** Minimal tar reader (ustar + GNU long names + pax paths) over a byte stream: its regular files. */
export async function* untar(stream: AsyncIterable<Buffer>): AsyncGenerator<{ path: string; data: Buffer }> {
  let buf: Buffer = Buffer.alloc(0);
  let longName: string | null = null;
  const it = stream[Symbol.asyncIterator]();
  const need = async (n: number): Promise<boolean> => {
    while (buf.length < n) {
      const { value, done } = await it.next();
      if (done) return false;
      buf = buf.length ? Buffer.concat([buf, value]) : Buffer.from(value);
    }
    return true;
  };
  for (;;) {
    if (!(await need(512))) return;
    const header = buf.subarray(0, 512);
    if (header.every((b) => b === 0)) return;
    const str = (a: number, b: number) => header.subarray(a, b).toString('utf8').replace(/\0[\s\S]*$/, '');
    const size = parseInt(str(124, 136).trim() || '0', 8) || 0;
    const type = str(156, 157) || '0';
    const prefix = str(345, 500);
    let name = str(0, 100);
    if (prefix) name = `${prefix}/${name}`;
    const padded = Math.ceil(size / 512) * 512;
    if (!(await need(512 + padded))) return;
    const data = buf.subarray(512, 512 + size);
    buf = buf.subarray(512 + padded);
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0[\s\S]*$/, '');
      continue;
    }
    if (type === 'x' || type === 'g') {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      if (m && type === 'x') longName = m[1];
      continue;
    }
    if (longName) {
      name = longName;
      longName = null;
    }
    if (type === '0' || type === '7') yield { path: name, data: Buffer.from(data) };
  }
}

async function download(url: string, headers: Record<string, string> = {}): Promise<AsyncIterable<Buffer>> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000), headers: { 'user-agent': `OrbImport/1.0 (+${SITE})`, ...headers } });
  if (res.status === 404) throw new FileError("Couldn't find that repository — is it public?");
  if (!res.ok || !res.body) throw new FileError(`GitHub didn't send the files (HTTP ${res.status}). Try again in a moment.`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD) throw new FileError('That repository is too big to import.');
  let total = 0;
  const limited = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>).on('data', (c: Buffer) => {
    total += c.length;
    if (total > MAX_DOWNLOAD) limited.destroy(new FileError('That repository is too big to import.'));
  });
  const gunzip = createGunzip();
  limited.on('error', (e) => gunzip.destroy(e)); // a pipe doesn't pass errors on: unhandled, they'd end the process
  return limited.pipe(gunzip);
}

interface Imported {
  tree: string;
  name: string;
  description: string;
  files: number;
  /** The repository's license (SPDX-ish id), or null when it has none (all rights reserved). */
  license: string | null;
  /** Set when the project probably needs a build step to run. */
  warning?: string;
  /** The Orb world this code is, or was forked from (`world` of its orb.json). */
  remixOf?: string;
  /** Where the world's files are in the repository ('' for its top; `dir` and the web folder the page is in). */
  root: string;
}

/** A license file's name (at a folder's top). */
export const LICENSE_FILE = /^(license|licence|copying)(\.\w+)?$/i;

/** A page's own title ('' without one). */
export const titleOf = (html: string): string => /<title>([^<]{1,80})<\/title>/i.exec(html)?.[1]?.trim() ?? '';

/** The license of a LICENSE file's text, as an SPDX-ish id (null if unknown). */
export function detectLicense(text: string): string | null {
  if (/MIT License|Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/Apache License/i.test(text)) return 'Apache-2.0';
  if (/GNU AFFERO/i.test(text)) return 'AGPL-3.0';
  if (/GNU LESSER/i.test(text)) return 'LGPL';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(text)) return 'GPL';
  if (/Mozilla Public License/i.test(text)) return 'MPL-2.0';
  if (/Redistribution and use in source and binary forms/i.test(text)) return 'BSD';
  if (/Permission to use, copy, modify, and\/or distribute/i.test(text)) return 'ISC';
  if (/This is free and unencumbered software released into the public domain/i.test(text)) return 'Unlicense';
  if (/CC0|Creative Commons Zero/i.test(text)) return 'CC0-1.0';
  if (/Creative Commons/i.test(text) && !/NonCommercial|NoDerivatives/i.test(text)) return 'CC-BY';
  return null;
}

const TRACKER_HOSTS = /google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|facebook\.net\/[^"']*fbevents|connect\.facebook\.net|hotjar\.com|clarity\.ms|plausible\.io|segment\.(com|io)|mixpanel\.com|amplitude\.com|statcounter\.com|quantserve\.com|scorecardresearch\.com/i;
const TRACKER_INLINE = /google-analytics\.com|googletagmanager\.com|\bgtag\(|_gaq\.push|\bga\(\s*['"]create|fbq\(\s*['"]init|hotjar|clarity\.ms/i;

/** Stands in for removed trackers: the page's own calls to them (ga('send', …)) keep working. */
const TRACKER_STUB =
  '<script>/* Orb: analytics removed — worlds on Orb don\'t track people */window.ga=window.gtag=window.fbq=function(){};window._gaq=window._gaq||[];window.dataLayer=window.dataLayer||[];</script>';

/**
 * Worlds on Orb don't track people: remove analytics and ad scripts from a page (both <script src>
 * of known trackers and inline snippets that load them), leaving no-op stand-ins so the page's own
 * calls to them don't break it. Returns the page unchanged if it has none.
 */
export function stripTrackers(html: string): string {
  let stubbed = false;
  const stub = () => {
    if (stubbed) return '';
    stubbed = true;
    return TRACKER_STUB;
  };
  return html
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (all, attrs: string, body: string) => {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? '';
      if (src && TRACKER_HOSTS.test(src)) return stub();
      if (!src && TRACKER_INLINE.test(body)) return stub();
      return all;
    })
    .replace(/<noscript>\s*<iframe[^>]+googletagmanager[\s\S]*?<\/noscript>/gi, '');
}

const THREE_DEFAULT = '0.186.1';
/** `import … from 'pkg'` (or '@scope/pkg/sub'): a package by name, as only a bundler or an import map resolves. */
const BARE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']((?:@[\w.-]+\/)?[a-zA-Z0-9_][\w.-]*)(?:\/[^"']*)?["']/g;

/** The packages this code imports by name. */
export function bareImports(code: string): string[] {
  return [...new Set([...code.matchAll(BARE_IMPORT)].map((m) => m[1]).filter((n) => !n.startsWith('node:')))];
}

/** The version package.json pins for a dependency ("^0.170.0" → "0.170.0"), or null. */
function depVersion(pkgJson: string | null | undefined, name: string): string | null {
  if (!pkgJson) return null;
  try {
    const pkg = JSON.parse(pkgJson) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const raw = pkg.dependencies?.[name] || pkg.devDependencies?.[name] || '';
    // A range stays a range: "^1.9.9" may name a version that was never published (esm.sh takes ranges).
    const m = String(raw).match(/([\^~]?)(\d+\.\d+\.\d+)/);
    return m ? m[1] + m[2] : null;
  } catch {
    return null;
  }
}

/**
 * An import map for packages imported by name: three from jsdelivr (as Orb's own worlds load it),
 * the rest from esm.sh, sharing that three (`external`) so there's one copy of it.
 */
function importMapFor(names: readonly string[], pkgJson: string | null | undefined): Record<string, string> {
  const cdn = threeCdn(pkgJson);
  const imports: Record<string, string> = {};
  for (const name of names) {
    if (name === 'three') {
      const build = cdn.three.replace(/three\.module\.js$/, '');
      Object.assign(imports, { three: cdn.three, 'three/webgpu': `${build}three.webgpu.js`, 'three/tsl': `${build}three.tsl.js`, 'three/addons/': cdn.addons, 'three/examples/jsm/': cdn.addons });
    }
    else {
      const v = depVersion(pkgJson, name);
      const at = `https://esm.sh/${name}${v ? `@${v}` : ''}`;
      imports[name] = `${at}?external=three`;
      imports[`${name}/`] = `${at}/`;
    }
  }
  return imports;
}

const join = (dir: string, rel: string) => {
  const out: string[] = [];
  for (const s of `${dir}${rel}`.split('/')) {
    if (s === '..') out.pop();
    else if (s !== '.' && s !== '') out.push(s);
  }
  return out.join('/');
};
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const RELATIVE_IMPORTS = /(?:\bimport|\bexport)\s*(?:[\w$\s{},*]+?\s*from\s*)?(["'])(\.{1,2}\/[^"'\n]+)\1|\bimport\(\s*(["'])(\.{1,2}\/[^"'\n]+)\3\s*\)/g;

/** The modules that run in workers (`new Worker(new URL('./w.js', import.meta.url))`) and everything they import. */
function workerModules(raw: ReadonlyMap<string, Buffer>, root: string): Set<string> {
  const todo: string[] = [];
  for (const [p, data] of raw) {
    if ((root && !p.startsWith(`${root}/`)) || !/\.m?js$/i.test(p)) continue;
    for (const m of data.toString('utf8').matchAll(/new\s+(?:Shared)?Worker\(\s*new\s+URL\(\s*(["'])(\.{1,2}\/[^"'\n]+)\1\s*,\s*import\.meta\.url|\bimport\s+[\w$]+\s+from\s*(["'])(\.{1,2}\/[^"'?\n]+)\?worker/g)) {
      const w = join(dirOf(p), m[2] ?? m[4]);
      todo.push(raw.has(w) ? w : w.replace(/ts$/, 'js')); // a .ts worker is served as .js
    }
  }
  const seen = new Set<string>();
  while (todo.length) {
    const p = todo.pop()!;
    if (seen.has(p) || !raw.has(p)) continue;
    seen.add(p);
    for (const m of raw.get(p)!.toString('utf8').matchAll(RELATIVE_IMPORTS)) todo.push(join(dirOf(p), m[2] ?? m[4]));
  }
  return seen;
}

/** The import map of a page (already rewritten for Orb). */
function pageImports(html: string): Record<string, string> {
  const body = /<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  try {
    return (body ? (JSON.parse(body) as { imports?: Record<string, string> }).imports : null) ?? {};
  } catch {
    return {};
  }
}

/** `from 'three'` → `from 'https://cdn…/three.module.js'`, as the import map would resolve it. */
function byAddress(js: string, imports: Record<string, string>): string {
  const resolve = (spec: string) => {
    if (imports[spec]) return imports[spec];
    const prefix = Object.keys(imports)
      .filter((k) => k.endsWith('/') && spec.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    return prefix ? imports[prefix] + spec.slice(prefix.length) : null;
  };
  return js.replace(/(\bimport\s*(?:[\w$\s{},*]+?\s*from\s*)?|\bexport\s*[\w$\s{},*]+?\s*from\s*|\bimport\(\s*)(["'])([^"'.\/][^"'\n]*)\2/g, (all, head: string, q: string, spec: string) => {
    const at = resolve(spec);
    return at ? `${head}${q}${at}${q}` : all;
  });
}

/** url(/fonts/a.woff2) in a stylesheet meant the site's top: a file of the world's becomes relative to the sheet. */
export function rewriteCssForOrb(css: string, path: string, files: ReadonlySet<string>): string {
  const up = '../'.repeat(path.split('/').length - 1);
  return css.replace(/url\(\s*(["']?)\/(?!\/)([^"')?#\s]+)([^"')]*)\1\s*\)/g, (all, q: string, p: string, rest: string) =>
    files.has(p) ? `url(${q}${up}${p}${rest}${q})` : all,
  );
}

/** Vite's `import.meta.glob('../world/*.js')` from the module at `path`: the matching files, as written. */
function globFiles(patterns: string[], path: string, files: ReadonlySet<string>): string[] {
  const entries = new Map<string, string>();
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    const star = pattern.indexOf('*');
    const cut = pattern.lastIndexOf('/', star < 0 ? pattern.length : star) + 1;
    const written = pattern.slice(0, cut); // "../world/"
    const fixed = join(pattern.startsWith('/') ? '' : dirOf(path), written);
    const rest = pattern.slice(cut).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*');
    const re = new RegExp(`^${fixed ? `${fixed.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}/` : ''}${rest}$`);
    for (const f of files) if (re.test(f)) entries.set(written + f.slice(fixed ? fixed.length + 1 : 0), '');
  }
  return [...entries.keys()].sort();
}

/**
 * Make a module written for a bundler (Vite) run as it is: a stylesheet it imports becomes a
 * `<link>` it adds, JSON it imports is imported as JSON, `import.meta.glob` lists the matching
 * files (given the module's path and the tree's files), and `import.meta.env` reads as a
 * production build's.
 */
export function rewriteModuleForOrb(js: string, at?: { path: string; files: ReadonlySet<string> }): string {
  if (at) {
    const here = dirOf(at.path);
    // Vite's `import W from './w.js?worker'`: W makes a worker of that module.
    js = js.replace(/\bimport\s+([\w$]+)\s+from\s*(["'])(\.{1,2}\/[^"'?\n]+)\?worker(?:&inline)?\2\s*;?/g, (_all, name: string, _q: string, file: string) =>
      `const ${name} = function (o) { return new Worker(new URL(${JSON.stringify(file)}, import.meta.url), { type: 'module', ...o }); };`,
    );
    // Bundlers find `./config` as config.js (or config/index.js, or a .ts served as .js): browsers need the file's name.
    js = js.replace(RELATIVE_IMPORTS, (all, q1: string | undefined, s1: string | undefined, q2: string | undefined, s2: string | undefined) => {
      const spec = (s1 ?? s2)!;
      const file = join(here, spec);
      if (at.files.has(file)) return all;
      const ext = ['.js', '.mjs', '/index.js'].find((e) => at.files.has(file.replace(/\/$/, '') + e)) ?? (/\.m?ts$/.test(spec) && at.files.has(file.replace(/ts$/, 'js')) ? 'ts' : null);
      if (!ext) return all;
      const fixed = ext === 'ts' ? spec.replace(/ts$/, 'js') : spec.replace(/\/$/, '') + ext;
      return all.replace(`${q1 ?? q2}${spec}${q1 ?? q2}`, `${q1 ?? q2}${fixed}${q1 ?? q2}`);
    });
    // './worker.ts' (new URL(…, import.meta.url)) is served as .js.
    js = js.replace(/(["'])(\.{1,2}\/[^"'\s]+)\.(m?)ts\1/g, (all, q: string, p: string, m: string) =>
      at.files.has(join(here, `${p}.${m}js`)) && !at.files.has(join(here, `${p}.${m}ts`)) ? `${q}${p}.${m}js${q}` : all,
    );
    // '/textures/bark.jpg' (or '/assets/' + name) meant the site's top, which a world's files are
    // not at: a file or a top folder of the world's becomes relative.
    const tops = new Set([...at.files].filter((f) => f.includes('/')).map((f) => f.slice(0, f.indexOf('/') + 1)));
    js = js.replace(/(["'`])\/([\w@~-][^"'`\s?#$]*)/g, (all, q: string, p: string) =>
      at.files.has(p) || [...tops].some((t) => p.startsWith(t)) ? `${q}${p}` : all,
    );
    // import.meta.glob(patterns) → { file: () => import(file) }; with { eager: true }, the modules
    // themselves (imported at the top), or one export of each ({ import: 'default' }).
    const hoisted: string[] = [];
    js = js.replace(/\bimport\.meta\.glob\(\s*(\[[^\]]*\]|(["'])[^"'\n]*\2)\s*(?:,\s*(\{[^}]*\})\s*)?\)/g, (_all, arg: string, _q: string, opts: string | undefined) => {
      const list = globFiles([...arg.matchAll(/(["'])([^"'\n]+)\1/g)].map((m) => m[2]), at.path, at.files);
      const eager = !!opts && /\beager\s*:\s*true\b/.test(opts);
      const pick = opts ? /\bimport\s*:\s*(["'])([\w$]+)\1/.exec(opts)?.[2] : undefined;
      const value = (k: string) => {
        if (!eager) return pick ? `() => import(${JSON.stringify(k)}).then((m) => m[${JSON.stringify(pick)}])` : `() => import(${JSON.stringify(k)})`;
        const name = `__orbGlob${hoisted.length}`;
        hoisted.push(`import * as ${name} from ${JSON.stringify(k)};`);
        return pick ? `${name}[${JSON.stringify(pick)}]` : name;
      };
      return `({ ${list.map((k) => `${JSON.stringify(k)}: ${value(k)}`).join(', ')} })`;
    });
    if (hoisted.length) js = `${hoisted.join(' ')}\n${js}`;
  }
  return js
    .replace(/(\bimport\s+[\w$\s{},*]+?\s+from\s*(["'])[^"'\n]+\.json\2)(?!\s*(?:with|assert)\b)/g, `$1 with { type: 'json' }`)
    .replace(/\bimport\s*(["'])([^"'\n]+\.css)\1\s*;?/g, (_all, _q: string, href: string) =>
      `(() => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = new URL(${JSON.stringify(href)}, import.meta.url).href; document.head.appendChild(l); })();`,
    )
    .replace(/\bimport\.meta\.env\b/g, `({ MODE: 'production', PROD: true, DEV: false, SSR: false, BASE_URL: './' })`);
}

/** Where three.js and its addons load from: jsdelivr, in the version package.json names. */
function threeCdn(pkgJson: string | null | undefined): { three: string; addons: string } {
  const ver = depVersion(pkgJson, 'three')?.replace(/^[\^~]/, '') ?? THREE_DEFAULT;
  return {
    three: `https://cdn.jsdelivr.net/npm/three@${ver}/build/three.module.js`,
    addons: `https://cdn.jsdelivr.net/npm/three@${ver}/examples/jsm/`,
  };
}

/**
 * Make a local-dev page runnable as an Orb world: import maps that load three.js from
 * `node_modules` become jsdelivr (Orb's tree never includes node_modules), and root-absolute
 * `src`/`href` of files in the tree become relative so they follow the tree `<base>`.
 */
export function rewritePageForOrb(html: string, files: ReadonlySet<string>, pkgJson?: string | null, opts: { bare?: readonly string[] } = {}): string {
  const cdn = threeCdn(pkgJson);
  // Code that imports packages by name, as a bundler would resolve them, gets an import map for them.
  if (opts.bare?.length && !/<script\b[^>]*\btype\s*=\s*["']importmap["']/i.test(html)) {
    const map = `<script type="importmap">${JSON.stringify({ imports: importMapFor(opts.bare, pkgJson) })}</script>`;
    html = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (head) => `${head}${map}`) : `${map}${html}`;
  }
  let out = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (all, attrs: string, body: string) => {
    if (!/\btype\s*=\s*["']importmap["']/i.test(attrs)) return all;
    try {
      const map = JSON.parse(body) as { imports?: Record<string, string> };
      const imports = { ...(map.imports ?? {}) };
      let changed = false;
      for (const [key, value] of Object.entries(imports)) {
        if (typeof value !== 'string') continue;
        // '/vendor/three.module.js' meant the site's top: relative, it follows the tree <base>.
        const rel = value.replace(/^\/(?!\/)/, '');
        if (rel !== value && (files.has(rel) || (rel.endsWith('/') && [...files].some((f) => f.startsWith(rel))))) {
          imports[key] = `./${rel}`; // an import map's addresses start with / ./ ../ or a scheme
          changed = true;
          continue;
        }
        if (!/node_modules\/three\//i.test(value)) continue;
        if (key === 'three' || key.endsWith('/three')) imports[key] = cdn.three;
        else if (key.includes('addons')) imports[key] = cdn.addons;
        else continue;
        changed = true;
      }
      if (!changed) return all;
      return `<script type="importmap">${JSON.stringify({ ...map, imports })}</script>`;
    } catch {
      return all;
    }
  });
  out = out.replace(/\b(src|href)=["']\/(?!\/)([^"']+)["']/gi, (all, attr: string, path: string) => {
    const rel = path.replace(/^\.\//, '');
    return files.has(rel) ? `${attr}="${rel}"` : all;
  });
  // A TypeScript entry (<script type="module" src="/src/main.ts">) is served as .js.
  out = out.replace(/\bsrc=["'](?:\.?\/)?([^"':]+?)\.(m?)ts["']/gi, (all, path: string, m: string) => (files.has(`${path}.${m}js`) ? `src="${path}.${m}js"` : all));
  return out;
}

/**
 * Read a repository tarball (GitHub's "<repo>-<sha>/" top folder is dropped) into path → bytes,
 * skipping .git, node_modules and files that are too big or oddly named.
 */
async function readTarball(url: string, opts: { headers?: Record<string, string>; dir?: string } = {}): Promise<{ files: Map<string, Buffer>; skipped: number }> {
  const raw = new Map<string, Buffer>();
  let total = 0;
  let skipped = 0;
  for await (const entry of untar(await download(url, opts.headers))) {
    let p = entry.path.split('/').slice(1).join('/');
    if (opts.dir) {
      if (!p.startsWith(`${opts.dir}/`)) continue;
      p = p.slice(opts.dir.length + 1);
    }
    if (!p || SKIP_DIR.test(p)) continue;
    const clean = cleanPath(p);
    if (!clean || entry.data.length > FILE_LIMITS.file) {
      skipped++;
      continue;
    }
    total += entry.data.length;
    if (total > FILE_LIMITS.total || raw.size >= FILE_LIMITS.files) throw new FileError('That repository has too many files (or they are too big).');
    raw.set(clean, entry.data);
  }
  return { files: raw, skipped };
}

const CODELOAD = process.env.ORB_GITHUB_CODELOAD || 'https://codeload.github.com'; // overridable for tests

const GITHUB_API = process.env.ORB_GITHUB_API || 'https://api.github.com';

/**
 * TypeScript modules as a browser runs them: Node strips the types (keeping every line where it
 * was) and `x.ts` is served as `x.js` (imports of it follow, see rewriteModuleForOrb).
 */
async function fromTypeScript(raw: Map<string, Buffer>): Promise<void> {
  const ts = [...raw.keys()].filter((p) => /\.m?ts$/i.test(p) && !/\.d\.m?ts$/i.test(p) && !raw.has(p.replace(/ts$/i, 'js')));
  if (!ts.length) return;
  const { stripTypeScriptTypes: strip } = (await import('node:module')) as unknown as { stripTypeScriptTypes?: (code: string, o?: { mode?: 'strip' | 'transform' }) => string };
  if (!strip) return;
  for (const p of ts) {
    const src = raw.get(p)!.toString('utf8');
    let js: string;
    try {
      js = strip(src);
    } catch {
      try {
        js = strip(src, { mode: 'transform' }); // enums, namespaces…
      } catch {
        continue;
      }
    }
    raw.delete(p);
    raw.set(p.replace(/ts$/i, 'js'), Buffer.from(js));
  }
}

/**
 * A repository's files as a world. With a token (a private repository, or one of the person's
 * own), through GitHub's API. `page`: an index.html to run the repository's code with (a curated
 * world whose repository has none, src/data/seed-pages.ts).
 */
export async function importRepo(db: Db, ref: RepoRef, opts: { token?: string | null; page?: string } = {}): Promise<Imported> {
  const at = ref.ref ? encodeURIComponent(ref.ref) : 'HEAD';
  const url = opts.token ? `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/tarball/${at}` : `${CODELOAD}/${ref.owner}/${ref.repo}/tar.gz/${at}`;
  const headers: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}`, accept: 'application/vnd.github+json' } : {};
  const { files: raw, skipped } = await readTarball(url, { dir: ref.dir, headers });
  if (!raw.size) throw new FileError('That repository looks empty.');
  if (opts.page) raw.set(ENTRY, Buffer.from(opts.page));
  await fromTypeScript(raw);

  // The page to run: index.html at the top, else in a usual web folder (which becomes the root).
  const root = ENTRY_DIRS.find((d) => raw.has(d ? `${d}/${ENTRY}` : ENTRY));
  if (root === undefined) throw new FileError("That repository has no index.html, so there's no page to run.");
  // A Vite project run from its source serves public/ at the top: so does its world.
  if (root === '' && [...raw.keys()].some((k) => /^vite\.config\.[cm]?[jt]s$/.test(k))) {
    for (const [p, data] of [...raw]) if (p.startsWith('public/') && !raw.has(p.slice(7))) raw.set(p.slice(7), data);
  }
  const tree: Tree = {};
  const rootPath = (f: string) => (root ? `${root}/${f}` : f);
  const relOf = (p: string) => (root ? p.slice(root.length + 1) : p);
  const inRoot = [...raw].filter(([p]) => !root || p.startsWith(`${root}/`));
  const names = new Set(inRoot.map(([p]) => relOf(p)));
  const pkgJson = (raw.get(rootPath('package.json')) ?? raw.get('package.json'))?.toString('utf8') ?? null;
  const bare = [...new Set(inRoot.flatMap(([p, data]) => (/\.(m?js|html?)$/i.test(p) ? bareImports(data.toString('utf8')) : [])))];
  const pages = new Map<string, string>();
  for (const [p, data] of inRoot) {
    if (/\.html?$/i.test(p)) pages.set(p, rewritePageForOrb(stripTrackers(data.toString('utf8')), names, pkgJson, { bare }));
  }
  // Workers don't see the page's import map: the modules they load import packages by address.
  const entryPage = pages.get(rootPath(ENTRY)) ?? '';
  const inWorkers = workerModules(raw, root);
  const imports = inWorkers.size ? pageImports(entryPage) : {};
  for (const [p, data] of inRoot) {
    const rel = relOf(p);
    let bytes: Buffer = data;
    if (pages.has(p)) bytes = Buffer.from(pages.get(p)!);
    else if (/\.css$/i.test(rel)) bytes = Buffer.from(rewriteCssForOrb(data.toString('utf8'), rel, names));
    else if (/\.m?js$/i.test(rel)) {
      const js = rewriteModuleForOrb(data.toString('utf8'), { path: rel, files: names });
      bytes = Buffer.from(inWorkers.has(p) ? byAddress(js, imports) : js);
    }
    tree[rel] = (await putBlob(db, bytes)).sha;
  }
  // The license travels with the files (also when the page lives in a subfolder).
  const licenseFile = [...raw.keys()].find((k) => LICENSE_FILE.test(k));
  if (licenseFile && root && !tree[licenseFile]) tree[licenseFile] = (await putBlob(db, raw.get(licenseFile)!)).sha;
  const license = licenseFile ? detectLicense(raw.get(licenseFile)!.toString('utf8')) : null;
  const sha = await putTree(db, tree);

  const html = raw.get(rootPath(ENTRY))!.toString('utf8');
  const title = titleOf(html);
  const readme = [...raw.keys()].find((k) => /^readme(\.md)?$/i.test(k));
  const description = readme ? firstParagraph(raw.get(readme)!.toString('utf8')) : '';
  let warning: string | undefined;
  if (/<script[^>]+src=["'][^"']+\.(tsx?|jsx)["']/i.test(html) || (raw.has('package.json') && /"(vite|webpack|parcel|next)"/.test(raw.get('package.json')!.toString('utf8')) && !root)) {
    warning = 'This project looks like it needs a build step (Vite, TypeScript…), which worlds don’t have yet — it may not run as-is. Orb can help convert it.';
  }
  if (skipped) warning = `${warning ? `${warning} ` : ''}${skipped} file${skipped === 1 ? ' was' : 's were'} skipped (too big or unusual names).`;
  let remixOf: string | undefined;
  try {
    const meta = raw.has('orb.json') ? (JSON.parse(raw.get('orb.json')!.toString('utf8')) as { world?: unknown }) : null;
    if (typeof meta?.world === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(meta.world)) remixOf = meta.world;
  } catch {
    /* not JSON: no remix */
  }
  return {
    tree: sha,
    name: title || ref.repo.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    description,
    files: Object.keys(tree).length,
    license,
    warning,
    remixOf,
    root: [ref.dir, root].filter(Boolean).join('/'),
  };
}

function firstParagraph(md: string): string {
  for (const block of md.split(/\n\s*\n/)) {
    const t = block
      .replace(/<[^>]+>/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[#>*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (t.length > 20 && !/^(badge|build status)/i.test(t)) return t.slice(0, 280);
  }
  return '';
}
