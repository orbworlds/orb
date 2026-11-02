#!/usr/bin/env node
// Copies Orb's paint kit (public/kit/paint.js) into src/data/paint-kit.json, which the server bundles
// to give every build the kit (src/server/agent/kit.ts). Run after changing the kit:
//   node scripts/paint-kit.mjs
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const source = fs.readFileSync(path.join(root, 'public/kit/paint.js'), 'utf8');
fs.writeFileSync(path.join(root, 'src/data/paint-kit.json'), JSON.stringify({ source }) + '\n');
console.log(`src/data/paint-kit.json: ${source.split('\n').length} lines`);
