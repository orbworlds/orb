#!/usr/bin/env node
// Writes small card thumbnails (public/templates/cards/<id>.webp, 400 px wide) from the full-size
// template thumbnails, for the template cards on the start screen. Run after changing a
// template thumbnail: node scripts/gen-template-cards.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'public/templates');
const out = path.join(dir, 'cards');
fs.mkdirSync(out, { recursive: true });

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.webp'))) {
  const target = path.join(out, file);
  await sharp(path.join(dir, file)).resize({ width: 400, withoutEnlargement: true }).webp({ quality: 78 }).toFile(target);
  const before = fs.statSync(path.join(dir, file)).size;
  console.log(`${file}: ${Math.round(before / 1024)} KB → ${Math.round(fs.statSync(target).size / 1024)} KB`);
}
