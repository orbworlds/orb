// Problems a code editor would underline, found right after the agent changes a file: syntax
// errors (JavaScript modules, inline scripts, JSON, the import map), imports of files that aren't
// there or of names a module doesn't export, and pages that load files that don't exist. The
// agent reads them in its write/edit results — like an editor's problems panel — so it fixes them
// even when no page is watching to run the world.

import { createHash } from 'node:crypto';
import { parse, type Node, type Pattern } from 'acorn';

/** What the checks need from the agent's workspace (./workspace.ts). */
export interface CheckFiles {
  files: Record<string, string>;
  read(path: string): Promise<string | null>;
}

interface Import {
  spec: string;
  /** Imported names ('default' for a default import); empty for side-effect / namespace imports. */
  names: string[];
  line: number;
}

interface ModuleInfo {
  imports: Import[];
  exports: Set<string>;
  /** Has `export * from` — its exports aren't fully known. */
  star: boolean;
  error: { message: string; line: number; col: number } | null;
}

const MAX_PROBLEMS = 8;
const JS = /\.m?js$/i;
const PAGE = /\.html?$/i;
const cache = new Map<string, ModuleInfo>();

type AnyNode = Node & Record<string, unknown>;

function names(p: Pattern | null | undefined, out: string[]): void {
  if (!p) return;
  const n = p as unknown as AnyNode;
  switch (n.type) {
    case 'Identifier':
      out.push(n.name as string);
      break;
    case 'ObjectPattern':
      for (const prop of n.properties as AnyNode[]) names((prop.type === 'RestElement' ? prop.argument : prop.value) as Pattern, out);
      break;
    case 'ArrayPattern':
      for (const el of n.elements as Pattern[]) names(el, out);
      break;
    case 'RestElement':
      names(n.argument as Pattern, out);
      break;
    case 'AssignmentPattern':
      names(n.left as Pattern, out);
      break;
  }
}

const nameOf = (n: AnyNode): string => (n.type === 'Identifier' ? (n.name as string) : String(n.value));

function syntaxError(e: unknown, lineOffset = 0): ModuleInfo['error'] {
  const err = e as { message?: string; loc?: { line: number; column: number } };
  return { message: String(err.message ?? e).replace(/\s*\(\d+:\d+\)$/, ''), line: (err.loc?.line ?? 1) + lineOffset, col: (err.loc?.column ?? 0) + 1 };
}

/** Imports, exports and syntax of one module (cached by its text). */
export function moduleInfo(code: string, sourceType: 'module' | 'script' = 'module', lineOffset = 0): ModuleInfo {
  const key = `${sourceType}:${lineOffset}:${createHash('sha1').update(code).digest('base64')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const info: ModuleInfo = { imports: [], exports: new Set(), star: false, error: null };
  try {
    const ast = parse(code, { ecmaVersion: 'latest', sourceType, locations: true, allowHashBang: true });
    for (const node of ast.body as unknown as AnyNode[]) {
      const line = ((node.loc as { start: { line: number } } | undefined)?.start.line ?? 1) + lineOffset;
      const source = node.source as AnyNode | null | undefined;
      switch (node.type) {
        case 'ImportDeclaration': {
          const imported: string[] = [];
          for (const s of node.specifiers as AnyNode[]) {
            if (s.type === 'ImportDefaultSpecifier') imported.push('default');
            else if (s.type === 'ImportSpecifier') imported.push(nameOf(s.imported as AnyNode));
          }
          info.imports.push({ spec: String(source?.value), names: imported, line });
          break;
        }
        case 'ExportNamedDeclaration': {
          const decl = node.declaration as AnyNode | null;
          if (decl?.type === 'VariableDeclaration') {
            const out: string[] = [];
            for (const d of decl.declarations as AnyNode[]) names(d.id as Pattern, out);
            for (const n of out) info.exports.add(n);
          } else if (decl && (decl.id as AnyNode | null)) info.exports.add(nameOf(decl.id as AnyNode));
          const reexported: string[] = [];
          for (const s of (node.specifiers as AnyNode[]) ?? []) {
            info.exports.add(nameOf(s.exported as AnyNode));
            reexported.push(nameOf(s.local as AnyNode));
          }
          if (source) info.imports.push({ spec: String(source.value), names: reexported, line });
          break;
        }
        case 'ExportDefaultDeclaration':
          info.exports.add('default');
          break;
        case 'ExportAllDeclaration':
          if (node.exported) info.exports.add(nameOf(node.exported as AnyNode));
          else info.star = true;
          info.imports.push({ spec: String(source?.value), names: [], line });
          break;
      }
    }
  } catch (e) {
    // A .js file may be a classic script (loaded without type="module"): only its own rules apply.
    if (sourceType === 'module' && isScript(code)) return remember(key, info);
    info.error = syntaxError(e, lineOffset);
  }
  return remember(key, info);
}

function isScript(code: string): boolean {
  try {
    parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
    return true;
  } catch {
    return false;
  }
}

function remember(key: string, info: ModuleInfo): ModuleInfo {
  if (cache.size > 400) cache.delete(cache.keys().next().value!);
  cache.set(key, info);
  return info;
}

// -- pages ----------------------------------------------------------------------------------------

interface PageScript {
  /** 'module', 'classic', 'importmap' or another (non-JavaScript) type. */
  kind: string;
  src: string | null;
  code: string;
  /** Line of the page where the script's text starts (0-based offset for its own line 1). */
  lineOffset: number;
  line: number;
}

const attr = (attrs: string, name: string): string | null => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};
const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;

function pageParts(html: string): { scripts: PageScript[]; refs: Array<{ url: string; line: number; what: string }> } {
  const scripts: PageScript[] = [];
  const refs: Array<{ url: string; line: number; what: string }> = [];
  const noComments = html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  // Tags written inside scripts, styles and templates aren't the page's own.
  const markup = noComments.replace(/(<(script|style|template)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi, (_m, open: string, _t, body: string, close: string) => open + body.replace(/[^\n]/g, ' ') + close);
  for (const m of noComments.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const type = (attr(m[1], 'type') ?? '').trim().toLowerCase();
    const kind = type === 'module' ? 'module' : type === 'importmap' ? 'importmap' : !type || /^(text|application)\/(javascript|ecmascript)$/.test(type) ? 'classic' : type;
    const src = attr(m[1], 'src');
    const start = (m.index ?? 0) + m[0].indexOf('>') + 1;
    const line = lineAt(html, m.index ?? 0);
    scripts.push({ kind, src, code: m[2], lineOffset: lineAt(html, start) - 1, line });
    if (src !== null && (kind === 'module' || kind === 'classic')) refs.push({ url: src, line, what: 'script' });
  }
  for (const m of markup.matchAll(/<link\b([^>]*)>/gi)) {
    const rel = (attr(m[1], 'rel') ?? '').toLowerCase();
    const href = attr(m[1], 'href');
    if (href !== null && /\b(stylesheet|modulepreload|icon|manifest)\b/.test(rel)) refs.push({ url: href, line: lineAt(html, m.index ?? 0), what: rel.includes('stylesheet') ? 'stylesheet' : 'file' });
  }
  for (const m of markup.matchAll(/<(img|audio|video|source)\b([^>]*)>/gi)) {
    const src = attr(m[2], 'src');
    if (src) refs.push({ url: src, line: lineAt(html, m.index ?? 0), what: m[1].toLowerCase() });
  }
  return { scripts, refs };
}

// -- resolving --------------------------------------------------------------------------------------

type Spec = { kind: 'file'; path: string } | { kind: 'root' } | { kind: 'other' };

/** A URL as written in `from` → the world file it points to. */
function resolveSpec(from: string, spec: string): Spec {
  const s = spec.trim();
  if (!s || s.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(s) || s.startsWith('//')) return { kind: 'other' };
  if (s.startsWith('/')) return { kind: 'root' };
  try {
    const u = new URL(s.split(/[?#]/)[0], `https://world.invalid/${from}`);
    if (u.host !== 'world.invalid') return { kind: 'other' };
    return { kind: 'file', path: decodeURIComponent(u.pathname.slice(1)) };
  } catch {
    return { kind: 'other' };
  }
}

const isBare = (spec: string) => !/^(\.{0,2}\/|[a-z][a-z\d+.-]*:)/i.test(spec.trim());

/** The names index.html's import map defines; null when there's no page to tell. */
async function importMapKeys(w: CheckFiles): Promise<string[] | null> {
  const html = await w.read('index.html').catch(() => null);
  if (html === null) return null;
  const keys: string[] = [];
  for (const s of pageParts(html).scripts) {
    if (s.kind !== 'importmap') continue;
    try {
      const imports = (JSON.parse(s.code) as { imports?: Record<string, unknown> }).imports;
      if (imports && typeof imports === 'object') keys.push(...Object.keys(imports));
    } catch {
      /* reported as a problem of index.html */
    }
  }
  return keys;
}

const mapped = (spec: string, keys: string[]) => keys.some((k) => k === spec || (k.endsWith('/') && spec.startsWith(k)));

// -- the checks -------------------------------------------------------------------------------------

/** The modules of a file: a JS file is one; a page has its inline scripts. */
async function modulesOf(w: CheckFiles, path: string): Promise<ModuleInfo[]> {
  const text = await w.read(path).catch(() => null);
  if (text === null) return [];
  if (JS.test(path)) return [moduleInfo(text)];
  if (!PAGE.test(path)) return [];
  return pageParts(text)
    .scripts.filter((s) => (s.kind === 'module' || s.kind === 'classic') && s.src === null && s.code.trim())
    .map((s) => moduleInfo(s.code, s.kind === 'module' ? 'module' : 'script', s.lineOffset));
}

/** Problems with one import of `from`. */
async function importProblems(w: CheckFiles, from: string, imp: Import): Promise<string[]> {
  if (isBare(imp.spec)) {
    const keys = await importMapKeys(w);
    if (!keys || mapped(imp.spec, keys)) return [];
    return [`${from}:${imp.line} imports "${imp.spec}", which is neither a relative path ("./…") nor in index.html's import map${keys.length ? ` (it maps: ${keys.slice(0, 8).join(', ')})` : ''}, so the browser can't load it.`];
  }
  const r = resolveSpec(from, imp.spec);
  if (r.kind === 'root') return [`${from}:${imp.line} imports "${imp.spec}" — a path from the site's root doesn't reach the world's files. Use a relative path ("./${imp.spec.replace(/^\/+/, '')}").`];
  if (r.kind !== 'file') return [];
  if (!w.files[r.path]) {
    if (w.files[`${r.path}.js`]) return [`${from}:${imp.line} imports "${imp.spec}" — browsers don't add file extensions: write "${imp.spec}.js".`];
    return [`${from}:${imp.line} imports "${imp.spec}", but there's no file ${r.path} (yet).`];
  }
  if (!JS.test(r.path) || !imp.names.length) return [];
  const target = (await modulesOf(w, r.path))[0];
  if (!target || target.error || target.star) return [];
  const missing = imp.names.filter((n) => !target.exports.has(n));
  if (!missing.length) return [];
  const has = [...target.exports];
  const list = has.length ? ` (it exports: ${has.slice(0, 12).join(', ')}${has.length > 12 ? ', …' : ''})` : ' (it exports nothing)';
  const what = missing.map((n) => (n === 'default' ? 'a default export' : n)).join(', ');
  return [`${from}:${imp.line} imports ${what} from "${imp.spec}", but ${r.path} doesn't export ${missing.length > 1 ? 'them' : 'it'}${list}.`];
}

/** Problems inside one file and with the files it uses. */
async function fileProblems(w: CheckFiles, path: string): Promise<string[]> {
  const text = await w.read(path).catch(() => null);
  if (text === null) return [];
  const out: string[] = [];
  if (/\.json$/i.test(path)) {
    try {
      JSON.parse(text);
    } catch (e) {
      out.push(`${path}: not valid JSON (${(e as Error).message}).`);
    }
    return out;
  }
  const isPage = PAGE.test(path);
  if (!JS.test(path) && !isPage) return out;
  if (isPage) {
    const { scripts, refs } = pageParts(text);
    for (const s of scripts) {
      if (s.kind !== 'importmap') continue;
      try {
        const map = JSON.parse(s.code) as { imports?: unknown };
        if (!map || typeof map !== 'object' || (map.imports !== undefined && (typeof map.imports !== 'object' || map.imports === null))) out.push(`${path}:${s.line} the import map needs the form {"imports": {"name": "url"}}.`);
      } catch (e) {
        out.push(`${path}:${s.line} the import map is not valid JSON (${(e as Error).message}).`);
      }
    }
    for (const ref of refs) {
      if (/[{}'"+\s]/.test(ref.url)) continue; // built at runtime
      const r = resolveSpec(path, ref.url);
      if (r.kind === 'root') out.push(`${path}:${ref.line} loads "${ref.url}" — a path from the site's root doesn't reach the world's files. Use a relative path ("./${ref.url.replace(/^\/+/, '')}").`);
      else if (r.kind === 'file' && !w.files[r.path]) out.push(`${path}:${ref.line} loads ${ref.what} "${ref.url}", but there's no file ${r.path} (yet).`);
    }
  }
  for (const info of await modulesOf(w, path)) {
    if (info.error) {
      out.push(`${path}:${info.error.line}:${info.error.col} SyntaxError: ${info.error.message}`);
      continue;
    }
    for (const imp of info.imports) out.push(...(await importProblems(w, path, imp)));
  }
  return out;
}

/** Problems in files that import `path` (after it changed, moved or was deleted). */
async function importerProblems(w: CheckFiles, path: string): Promise<string[]> {
  const out: string[] = [];
  for (const from of Object.keys(w.files).sort()) {
    if (from === path || !(JS.test(from) || PAGE.test(from))) continue;
    for (const info of await modulesOf(w, from)) {
      for (const imp of info.imports) {
        const r = isBare(imp.spec) ? null : resolveSpec(from, imp.spec);
        if (r?.kind === 'file' && r.path === path) out.push(...(await importProblems(w, from, imp)));
      }
    }
    if (out.length >= MAX_PROBLEMS) break;
  }
  return out;
}

function report(list: string[]): string {
  const unique = [...new Set(list)];
  if (!unique.length) return '';
  const shown = unique.slice(0, MAX_PROBLEMS);
  return `\nProblems (fix them before moving on):\n${shown.map((p) => `- ${p}`).join('\n')}${unique.length > shown.length ? `\n- … and ${unique.length - shown.length} more` : ''}`;
}

/** After files were written, edited, moved or deleted: what's wrong with them and with the files that use them. */
export async function problemsAfterChange(w: CheckFiles, paths: string[]): Promise<string> {
  try {
    const found: string[] = [];
    for (const path of paths) {
      if (w.files[path]) found.push(...(await fileProblems(w, path)));
      if (JS.test(path)) found.push(...(await importerProblems(w, path)));
    }
    return report(found);
  } catch (e) {
    console.error('[orb] agent check failed', e);
    return '';
  }
}
