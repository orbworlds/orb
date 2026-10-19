// Import a public GitHub repository as a multi-file world: download its tarball, keep the files
// (skipping .git, node_modules and oversized files), find the page to run (index.html) and store
// everything as a file tree (see ./files.ts). Plain HTML/JS projects run as-is; projects that need
// a build step (Vite, TypeScript…) are imported but flagged, since worlds have no build step yet.

import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import type { Db } from './db';
import { cleanPath, ENTRY, FILE_LIMITS, FileError, putBlob, putTree, type Tree } from './files';
import { SITE } from '../lib/site';

const MAX_DOWNLOAD = 120_000_000; // compressed bytes
// orb-kit: the Orb kit that open-source worlds' repositories carry to run on localhost
export const SKIP_DIR = /(^|\/)(\.git|node_modules|\.github|\.vscode|\.idea|__pycache__|orb-kit)(\/|$)/;
const ENTRY_DIRS = ['', 'public', 'docs', 'dist', 'build', 'www', 'web', 'site', 'app'];

export interface RepoRef {
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

/** Minimal tar reader (ustar + GNU long names + pax paths) over a byte stream. */
export async function* untar(stream: AsyncIterable<Buffer>): AsyncGenerator<{ path: string; type: string; data: Buffer }> {
  let buf: Buffer = Buffer.alloc(0);
  let longName: string | null = null;
  const take = async function* (): AsyncGenerator<Buffer> {
    for await (const chunk of stream) yield chunk;
  };
  const it = take();
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
    yield { path: name, type, data: Buffer.from(data) };
  }
}

async function download(url: string, headers: Record<string, string> = {}): Promise<AsyncIterable<Buffer>> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000), headers: { 'user-agent': `OrbImport/1.0 (+${SITE})`, ...headers } });
  if (res.status === 404) throw new FileError("Couldn't find that repository — is it public?");
  if (!res.ok || !res.body) throw new FileError(`GitHub didn't send the files (HTTP ${res.status}). Try again in a moment.`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD) throw new FileError('That repository is too big to import.');
  let total = 0;
  const limited = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>).on('data', (c: Buffer) => {
    total += c.length;
    if (total > MAX_DOWNLOAD) limited.destroy(new FileError('That repository is too big to import.'));
  });
  return limited.pipe(createGunzip());
}

export interface Imported {
  tree: string;
  name: string;
  description: string;
  sourceUrl: string;
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
    return String(raw).match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function threeVersion(pkgJson: string | null | undefined): string {
  return depVersion(pkgJson, 'three') ?? THREE_DEFAULT;
}

/**
 * An import map for packages imported by name: three from jsdelivr (as Orb's own worlds load it),
 * the rest from esm.sh, sharing that three (`external`) so there's one copy of it.
 */
function importMapFor(names: readonly string[], pkgJson: string | null | undefined): Record<string, string> {
  const cdn = threeCdn(threeVersion(pkgJson));
  const imports: Record<string, string> = {};
  for (const name of names) {
    if (name === 'three') Object.assign(imports, { three: cdn.three, 'three/addons/': cdn.addons, 'three/examples/jsm/': cdn.addons });
    else {
      const at = `https://esm.sh/${name}${depVersion(pkgJson, name) ? `@${depVersion(pkgJson, name)}` : ''}`;
      imports[name] = `${at}?external=three`;
      imports[`${name}/`] = `${at}/`;
    }
  }
  return imports;
}

/**
 * Make a module written for a bundler (Vite) run as it is: a stylesheet it imports becomes a
 * `<link>` it adds, and `import.meta.env` reads as a production build's.
 */
export function rewriteModuleForOrb(js: string): string {
  return js
    .replace(/\bimport\s*(["'])([^"'\n]+\.css)\1\s*;?/g, (_all, _q: string, href: string) =>
      `(() => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = new URL(${JSON.stringify(href)}, import.meta.url).href; document.head.appendChild(l); })();`,
    )
    .replace(/\bimport\.meta\.env\b/g, `({ MODE: 'production', PROD: true, DEV: false, SSR: false, BASE_URL: './' })`);
}

function threeCdn(ver: string): { three: string; addons: string } {
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
  const cdn = threeCdn(threeVersion(pkgJson));
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
        if (typeof value !== 'string' || !/node_modules\/three\//i.test(value)) continue;
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
  return out;
}

/**
 * Read a repository tarball (GitHub's "<repo>-<sha>/" top folder is dropped) into path → bytes,
 * skipping .git, node_modules and files that are too big or oddly named.
 */
export async function readTarball(url: string, opts: { headers?: Record<string, string>; dir?: string } = {}): Promise<{ files: Map<string, Buffer>; skipped: number }> {
  const raw = new Map<string, Buffer>();
  let total = 0;
  let skipped = 0;
  for await (const entry of untar(await download(url, opts.headers))) {
    if (entry.type !== '0' && entry.type !== '\0' && entry.type !== '7') continue; // files only
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

/** A repository's files as a world. With a token (a private repository, or one of the person's own), through GitHub's API. */
export async function importRepo(db: Db, ref: RepoRef, opts: { token?: string | null } = {}): Promise<Imported> {
  const at = ref.ref ? encodeURIComponent(ref.ref) : 'HEAD';
  const url = opts.token ? `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/tarball/${at}` : `${CODELOAD}/${ref.owner}/${ref.repo}/tar.gz/${at}`;
  const headers: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}`, accept: 'application/vnd.github+json' } : {};
  const { files: raw, skipped } = await readTarball(url, { dir: ref.dir, headers });
  if (!raw.size) throw new FileError('That repository looks empty.');

  // The page to run: index.html at the top, else in a usual web folder (which becomes the root).
  const root = ENTRY_DIRS.find((d) => raw.has(d ? `${d}/${ENTRY}` : ENTRY));
  if (root === undefined) throw new FileError("That repository has no index.html, so there's no page to run.");
  // A Vite project run from its source serves public/ at the top: so does its world.
  if (root === '' && [...raw.keys()].some((k) => /^vite\.config\.[cm]?[jt]s$/.test(k))) {
    for (const [p, data] of [...raw]) if (p.startsWith('public/') && !raw.has(p.slice(7))) raw.set(p.slice(7), data);
  }
  const tree: Tree = {};
  const names = new Set<string>();
  for (const p of raw.keys()) {
    if (root && !p.startsWith(`${root}/`)) continue;
    names.add(root ? p.slice(root.length + 1) : p);
  }
  const pkgJson = (root ? raw.get(`${root}/package.json`) : null)?.toString('utf8') ?? raw.get('package.json')?.toString('utf8') ?? null;
  const bare = [...new Set([...raw].flatMap(([p, data]) => ((!root || p.startsWith(`${root}/`)) && /\.(m?js|html?)$/i.test(p) ? bareImports(data.toString('utf8')) : [])))];
  for (const [p, data] of raw) {
    if (root && !p.startsWith(`${root}/`)) continue;
    const rel = root ? p.slice(root.length + 1) : p;
    const bytes = /\.html?$/i.test(rel)
      ? Buffer.from(rewritePageForOrb(stripTrackers(data.toString('utf8')), names, pkgJson, { bare }))
      : /\.m?js$/i.test(rel)
        ? Buffer.from(rewriteModuleForOrb(data.toString('utf8')))
        : data;
    tree[rel] = (await putBlob(db, bytes)).sha;
  }
  // The license travels with the files (also when the page lives in a subfolder).
  const licenseFile = [...raw.keys()].find((k) => /^(license|licence|copying)(\.\w+)?$/i.test(k));
  if (licenseFile && root && !tree[licenseFile]) tree[licenseFile] = (await putBlob(db, raw.get(licenseFile)!)).sha;
  const license = licenseFile ? detectLicense(raw.get(licenseFile)!.toString('utf8')) : null;
  const sha = await putTree(db, tree);

  const html = raw.get(root ? `${root}/${ENTRY}` : ENTRY)!.toString('utf8');
  const title = /<title>([^<]{1,80})<\/title>/i.exec(html)?.[1]?.trim();
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
    sourceUrl: `https://github.com/${ref.owner}/${ref.repo}${ref.ref ? `/tree/${ref.ref}${ref.dir ? `/${ref.dir}` : ''}` : ''}`,
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
