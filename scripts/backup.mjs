#!/usr/bin/env node
// Backup of what Orb records about its builds and visitors, as plain files, fetched from the lab's
// key-guarded pages: every trace with its whole timeline and screenshots (/lab/<key>/traces/export
// and /traces/blob), each UTC day's analytics events, and daily snapshots of Pulse's numbers and of
// the recorded problems (/lab/<key>/backup). Run every night by .github/workflows/backup.yml, which
// commits the files to the private repository orbworlds/orb-backups (never to a public one).
//
// Incremental and append-only: a finished trace or day is written once and recent ones are
// refreshed; nothing is ever deleted, so the backup keeps what the database lets go of (analytics
// after 180 days, problems after 30).
//   node scripts/backup.mjs <dir> <lab URL: https://<site>/lab/<key>>

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';

const [dirArg, labArg] = process.argv.slice(2);
const out = path.resolve(dirArg || 'backup');
const lab = (labArg || process.env.ORB_LAB_URL || '').replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+\/lab\/[^/]+$/.test(lab)) throw new Error('Pass the lab URL, like https://orbworld.vercel.app/lab/<key>.');

const DAY = 86_400_000;
/** Traces this recent are fetched again every run (an agent job can run for up to 14 days). */
const REFRESH_TRACES_DAYS = 15;
/** Analytics days fetched again every run (events of a day can still arrive after it). */
const REFRESH_EVENT_DAYS = 2;
/** The traces export's page size (its maximum). */
const PAGE = 2000;
const EXT = { 'image/webp': '.webp', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/avif': '.avif', 'text/plain': '.txt' };

const day = (d) => new Date(d).toISOString().slice(0, 10);
const file = (rel) => path.join(out, rel);
const write = (rel, data) => {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), data);
};
const writeJson = (rel, v) => write(rel, `${JSON.stringify(v, null, 1)}\n`);

async function get(p) {
  const res = await fetch(lab + p, { headers: { 'user-agent': 'orb-backup' } });
  if (!res.ok) throw new Error(`GET ${p.split('?')[0]} answered ${res.status}${res.status === 404 ? ' (is the lab key right?)' : ''}`);
  return res;
}

async function* jsonLines(res) {
  for await (const line of readline.createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity })) if (line.trim()) yield JSON.parse(line);
}

const count = { traces: 0, blobs: 0, events: 0, days: 0 };

// ---- traces and the screenshots they refer to -------------------------------------------------------
const RUNNING = 'traces/running.json';
const wasRunning = fs.existsSync(file(RUNNING)) ? JSON.parse(fs.readFileSync(file(RUNNING), 'utf8')) : [];
const running = new Set();
const seen = new Set();
const wanted = new Set();
const keep = (t) => {
  if (!/^[\w-]{6,120}$/.test(t.id) || seen.has(t.id)) return;
  seen.add(t.id);
  const text = `${JSON.stringify(t, null, 1)}\n`;
  write(`traces/${day(t.startedAt).slice(0, 7)}/${t.id}.json`, text);
  // Screenshots are "orb-blob:<sha>"; a world's files are `files: { <path>: <sha> }`.
  for (const m of text.matchAll(/orb-blob:([0-9a-f]{64})/g)) wanted.add(m[1]);
  JSON.parse(text, (k, v) => {
    if (k === 'files' && v && typeof v === 'object' && !Array.isArray(v)) for (const sha of Object.values(v)) if (typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha)) wanted.add(sha);
    return v;
  });
  if (t.status === 'running') running.add(t.id);
  count.traces++;
};
let since = fs.existsSync(file('traces')) ? new Date(Date.now() - REFRESH_TRACES_DAYS * DAY).toISOString() : '2000-01-01T00:00:00Z';
for (;;) {
  let n = 0;
  let last = since;
  for await (const t of jsonLines(await get(`/traces/export?since=${encodeURIComponent(since)}&limit=${PAGE}`))) {
    keep(t);
    n++;
    last = t.startedAt;
  }
  if (n < PAGE || last === since) break;
  since = last;
}
// Ones still running at the last backup that started before the refresh window.
for (const id of wasRunning) {
  if (seen.has(id)) continue;
  for await (const t of jsonLines(await get(`/traces/export?id=${encodeURIComponent(id)}`))) keep(t);
}
writeJson(RUNNING, [...running].sort());
const stored = (sha) => fs.existsSync(file(`blobs/${sha.slice(0, 2)}`)) && fs.readdirSync(file(`blobs/${sha.slice(0, 2)}`)).some((f) => f.startsWith(sha));
for (const sha of wanted) {
  if (stored(sha)) continue;
  const res = await fetch(`${lab}/traces/blob/${sha}`, { headers: { 'user-agent': 'orb-backup' } });
  if (!res.ok) continue; // pruned since: the trace keeps its reference
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  write(`blobs/${sha.slice(0, 2)}/${sha}${EXT[type] ?? ''}`, Buffer.from(await res.arrayBuffer()));
  count.blobs++;
}

// ---- analytics, Pulse and problems --------------------------------------------------------------------
const days = fs.existsSync(file('analytics')) ? fs.readdirSync(file('analytics')).map((f) => /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1]).filter(Boolean).sort() : [];
const eventsSince = days.length ? day(Date.parse(`${days[days.length - 1]}T00:00:00Z`) - REFRESH_EVENT_DAYS * DAY) : null;
const today = day(Date.now());
for await (const line of jsonLines(await get(`/backup${eventsSince ? `?since=${eventsSince}` : ''}`))) {
  if (line.type === 'pulse') writeJson(`pulse/${today}.json`, line);
  else if (line.type === 'problems') writeJson(`problems/${today}.json`, line.rows);
  else if (line.type === 'events') {
    write(`analytics/${line.day}.jsonl`, `${line.rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    count.days++;
    count.events += line.rows.length;
  }
}

if (!fs.existsSync(file('README.md'))) {
  write(
    'README.md',
    `# Orb backups

Written every night by \`.github/workflows/backup.yml\` (\`scripts/backup.mjs\` on the main branch).

- \`traces/<month>/<id>.json\`: a build's trace with its whole timeline, as \`/lab/<key>/traces/export\`
  gives it. A screenshot (\`orb-blob:<sha>\`) or one of the world's files (\`files: { <path>: <sha> }\`)
  is the file \`blobs/<sha[0:2]>/<sha>.<ext>\`.
- \`analytics/<day>.jsonl\`: that UTC day's analytics events, one per line.
- \`pulse/<day>.json\`: Pulse as of that day (the last 7 days, all-time totals, the free builder).
- \`problems/<day>.json\`: the problems recorded as of that day.

Nothing here is ever deleted, so it keeps what the database lets go of.
`,
  );
}

console.log(`Backed up ${count.traces} traces (${count.blobs} new screenshots and files), ${count.events} events over ${count.days} days, Pulse and problems for ${today}.`);
