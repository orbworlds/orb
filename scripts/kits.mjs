#!/usr/bin/env node
// Copies Orb's kits for worlds (public/kit/*.js) into src/data/kits.json, which the server bundles to
// give every build the kits at orb/<file> (src/server/agent/kit.ts). Run after changing a kit:
//   node scripts/kits.mjs
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = path.join(root, 'public/kit');
const kits = Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((f) => [`orb/${f}`, fs.readFileSync(path.join(dir, f), 'utf8')]));
fs.writeFileSync(path.join(root, 'src/data/kits.json'), JSON.stringify(kits) + '\n');
console.log(`src/data/kits.json: ${Object.entries(kits).map(([p, s]) => `${p} (${s.split('\n').length} lines)`).join(', ')}`);
