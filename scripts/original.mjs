// An Orb Original's page for tools that play it (the thumbnails): `--game <file>` (a checkout of its
// repository), or else the Original as Orb serves it now, which is its repository's (src/data/originals.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function originalFile(id, args = process.argv.slice(2)) {
  const i = args.indexOf('--game');
  if (i >= 0) return path.resolve(args[i + 1]);
  const site = process.env.ORB_SITE || 'https://orbworlds.com';
  const res = await fetch(`${site}/api/worlds/${id}`);
  const code = res.ok ? (await res.json()).world?.code : null;
  if (!code) throw new Error(`${site} didn't send ${id} (${res.status}); pass --game <its index.html>`);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`)), 'index.html');
  fs.writeFileSync(file, code);
  return file;
}
