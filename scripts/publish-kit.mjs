#!/usr/bin/env node
// The Orb kit (kit/) on npm as @orbworlds/kit, the only way it's handed out: every world's
// repository depends on it (`"@orbworlds/kit": "^0.3.0"`), and `npx @orbworlds/kit dev` plays any
// folder. Its runtime (lib/runtime.js) is built here from Orb's own (src/lib/runtime/sdk.ts), so
// the kit runs worlds exactly as Orb does.
//
// A new version goes out when what's in the package changed since the latest one (the hash of its
// files rides along in package.json as `orbSource`): the next patch of the version kit/package.json
// says (bump its minor there for a change worlds should opt into, its major for a breaking one).
// .github/workflows/kit.yml runs this when the kit or Orb's runtime changes, with NPM_TOKEN.
//
//   node scripts/publish-kit.mjs [--dry: pack it into .data/kit/ instead] [--runtime: only build lib/runtime.js]
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kit = path.join(root, 'kit');
const dry = process.argv.includes('--dry');

const sdk = fs.readFileSync(path.join(root, 'src/lib/runtime/sdk.ts'), 'utf8');
const runtime = ts.transpileModule(sdk, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, removeComments: false } }).outputText;
fs.writeFileSync(path.join(kit, 'lib/runtime.js'), `// GENERATED from Orb's src/lib/runtime/sdk.ts by scripts/publish-kit.mjs: Orb's world runtime, as Orb injects it into every world.\n${runtime}`);
if (process.argv.includes('--runtime')) process.exit(0);

// what the package holds, hashed
const pkg = JSON.parse(fs.readFileSync(path.join(kit, 'package.json'), 'utf8'));
const files = [];
(function walk(rel) {
  const p = path.join(kit, rel);
  if (fs.statSync(p).isDirectory()) for (const e of fs.readdirSync(p).sort()) walk(path.join(rel, e));
  else files.push(rel);
})('.');
const inPackage = files.filter((f) => f === 'package.json' || pkg.files.some((x) => f === x || f.startsWith(`${x}/`)));
const hash = crypto.createHash('sha256');
for (const f of inPackage) hash.update(`${f}\0`).update(f === 'package.json' ? JSON.stringify({ ...pkg, version: undefined }) : fs.readFileSync(path.join(kit, f)));
const source = hash.digest('hex').slice(0, 16);

// the latest published of this major.minor, and whether it already is this
const res = await fetch(`https://registry.npmjs.org/${pkg.name.replace('/', '%2f')}`);
const published = res.ok ? await res.json() : { versions: {} };
const [major, minor] = pkg.version.split('.').map(Number);
const line = Object.keys(published.versions ?? {}).map((v) => v.split('.').map(Number)).filter(([a, b]) => a === major && b === minor).sort((a, b) => a[2] - b[2]);
const latest = line.at(-1);
if (latest && published.versions[latest.join('.')]?.orbSource === source) {
  console.log(`${pkg.name}@${latest.join('.')} is the kit as it is: nothing to publish`);
  process.exit(0);
}
const version = latest ? `${major}.${minor}.${latest[2] + 1}` : pkg.version;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-kit-'));
for (const f of inPackage) {
  fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
  fs.copyFileSync(path.join(kit, f), path.join(tmp, f));
}
fs.writeFileSync(path.join(tmp, 'package.json'), `${JSON.stringify({ ...pkg, version, orbSource: source }, null, 2)}\n`);
if (dry) {
  const out = path.join(root, '.data/kit');
  fs.mkdirSync(out, { recursive: true });
  const name = execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: tmp, encoding: 'utf8' }).trim().split('\n').pop();
  console.log(path.join(out, name));
} else {
  if (!process.env.NPM_TOKEN) throw new Error('NPM_TOKEN is needed to publish (or --dry)');
  const rc = path.join(tmp, '.npmrc-publish');
  fs.writeFileSync(rc, '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n');
  execFileSync('npm', ['publish', '--access', 'public'], { cwd: tmp, stdio: 'inherit', env: { ...process.env, NPM_CONFIG_USERCONFIG: rc } });
  console.log(`published ${pkg.name}@${version}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
