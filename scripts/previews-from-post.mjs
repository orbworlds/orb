#!/usr/bin/env node
// A world's looping preview cut from its maker's own video (the one in the post they shared it with),
// for worlds whose makers filmed them better than scripts/previews.mjs can play them here. Same
// format as that recorder: 5 seconds, 640×400, 30 fps, the last moment dissolving into the first;
// written to public/previews/<id>.webm and .mp4 and listed in src/data/previews.json.
//
//   node scripts/previews-from-post.mjs <id> <video url or file> [start seconds]
//   SHEET=1 node scripts/previews-from-post.mjs <id> <video> — a contact sheet (a still every few
//   seconds, with its time) to pick where the clip starts.
//
// A post on X: its video's address is in https://api.fxtwitter.com/<user>/status/<id> (media.videos).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const W = 640, H = 400, FPS = 30, SECONDS = 5, FADE = 0.6;
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [id, src, startArg] = process.argv.slice(2);
if (!id || !src) {
  console.error('usage: node scripts/previews-from-post.mjs <id> <video url or file> [start seconds]');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-post-`));
let file = src;
if (/^https?:/.test(src)) {
  file = path.join(tmp, 'source.mp4');
  const res = await fetch(src);
  if (!res.ok) throw new Error(`${res.status} fetching the video`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}
const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());

if (process.env.SHEET) {
  const every = Math.max(1, Math.floor(duration / 24));
  const sheet = path.join(os.tmpdir(), `${id}-post-sheet.jpg`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', `fps=1/${every},scale=320:-2,drawtext=text='%{pts\\:hms}':x=8:y=8:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.5,tile=6x4`, '-frames:v', '1', sheet]);
  console.log(`${sheet}  (${duration.toFixed(1)} s, a still every ${every} s)`);
  process.exit(0);
}

// Where the clip starts: as asked, or a third of the way in (past the title cards).
const start = startArg !== undefined ? Number(startArg) : Math.max(0, Math.min(duration / 3, duration - SECONDS - FADE));
const fade =
  `[0:v]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,split[a][b];` +
  `[a]trim=start=${FADE},setpts=PTS-STARTPTS[main];[b]trim=0:${FADE},setpts=PTS-STARTPTS[head];` +
  `[main][head]xfade=transition=fade:duration=${FADE}:offset=${SECONDS - FADE},format=yuv420p[v]`;
const input = ['-y', '-loglevel', 'error', '-ss', String(start), '-t', String(SECONDS + FADE), '-i', file, '-filter_complex', fade, '-map', '[v]', '-an'];
const base = path.join(root, 'public/previews', id);
execFileSync('ffmpeg', [...input, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '40', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', `${base}.webm`]);
execFileSync('ffmpeg', [...input, '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-movflags', '+faststart', `${base}.mp4`]);
fs.rmSync(tmp, { recursive: true });

const hash = createHash('sha256');
for (const ext of ['webm', 'mp4']) hash.update(fs.readFileSync(`${base}.${ext}`));
const listFile = path.join(root, 'src/data/previews.json');
const list = { ...JSON.parse(fs.readFileSync(listFile, 'utf8')), [id]: hash.digest('hex').slice(0, 8) };
fs.writeFileSync(listFile, `${JSON.stringify(Object.fromEntries(Object.entries(list).sort()), null, 2)}\n`);
console.log(`✓ ${id}  from ${start.toFixed(1)} s  ${['webm', 'mp4'].map((ext) => `${(fs.statSync(`${base}.${ext}`).size / 1024).toFixed(0)} KB ${ext}`).join(', ')}`);
