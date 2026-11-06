#!/usr/bin/env node
// Compares two bench runs (scripts/bench/run.mjs) the way people would: for each request both ran, a
// blind judge (Claude Opus 5.5) sees the request and the two worlds, as they first appeared and as
// Orb handed them back, and says which would delight the person more — each pair twice, in both
// orders, so the side it's shown on doesn't count. Prints the second label's wins, ties and losses
// beside both runs' speed and cost, and writes .data/bench/<a>-vs-<b>.png: every pair, side by side.
//   ANTHROPIC_API_KEY=… node scripts/bench/judge.mjs <baseline label> <candidate label>
import fs from 'node:fs';
import path from 'node:path';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import { launch } from '../../kit/lib/browser.mjs';
import { root } from '../harness.mjs';

const [a, b] = process.argv.slice(2);
if (!a || !b || !process.env.ANTHROPIC_API_KEY) {
  console.error('usage: ANTHROPIC_API_KEY=… node scripts/bench/judge.mjs <baseline label> <candidate label>');
  process.exit(1);
}
const dir = (label) => path.join(root, '.data/bench', label);
const read = (label) => JSON.parse(fs.readFileSync(path.join(dir(label), 'summary.json'), 'utf8'));
const A = read(a);
const B = read(b);
const SHOTS = { first: 'as it first appeared on their screen', back: 'when Orb finished its first turn and handed back' };

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-5-5');
async function ask(request, when, one, two) {
  const image = (file) => ({ type: 'file', data: fs.readFileSync(file), mediaType: 'image/png' });
  const { text } = await generateText({
    model,
    maxOutputTokens: 2000,
    messages: [{ role: 'user', content: [
      { type: 'text', text: `Someone asked Orb, an AI that makes 3D web worlds and games, for: "${request}". Here are two worlds Orb made for it, each ${when}. World 1:` },
      image(one),
      { type: 'text', text: 'World 2:' },
      image(two),
      { type: 'text', text: 'Which would the person be happier to see? Weigh how beautiful it looks and how clearly it is what they asked for; a blank or broken screen loses. Reply with only JSON: {"better": "1" | "2" | "same", "why": "one short sentence"}' },
    ] }],
  });
  try {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return {}; // no verdict: counts as even
  }
}

const pairs = [];
for (const rb of B.results) {
  const ra = A.results.find((r) => r.name === rb.name);
  if (!ra) continue;
  for (const shot of Object.keys(SHOTS)) {
    const fa = path.join(dir(a), ra.name, `${shot}.png`);
    const fb = path.join(dir(b), rb.name, `${shot}.png`);
    const [ha, hb] = [fs.existsSync(fa), fs.existsSync(fb)];
    if (!ha && !hb) continue;
    // only one showed anything: that one is better, nothing to ask
    if (ha !== hb) pairs.push({ name: rb.name, prompt: rb.prompt, shot, result: hb ? 'win' : 'loss', why: `only ${hb ? b : a} showed a world` });
    else pairs.push({ name: rb.name, prompt: rb.prompt, shot, fa, fb });
  }
}
const asks = pairs.filter((p) => !p.result);
await Promise.all(Array.from({ length: 4 }, async () => { // four pairs at a time
  for (let p = asks.shift(); p; p = asks.shift()) {
    const [ab, ba] = await Promise.all([ask(p.prompt, SHOTS[p.shot], p.fa, p.fb), ask(p.prompt, SHOTS[p.shot], p.fb, p.fa)]);
    const forB = (ab.better === '2' ? 1 : ab.better === '1' ? -1 : 0) + (ba.better === '1' ? 1 : ba.better === '2' ? -1 : 0);
    p.result = forB > 0 ? 'win' : forB < 0 ? 'loss' : 'tie';
    p.why = [ab.why, ba.why].filter(Boolean).join(' / ');
  }
}));

const tally = (shot) => {
  const ps = pairs.filter((p) => p.shot === shot);
  const n = (k) => ps.filter((p) => p.result === k).length;
  return { win: n('win'), tie: n('tie'), loss: n('loss'), score: ps.length ? (n('win') + n('tie') / 2) / ps.length : null };
};
const line = (s) => `first seen ${Math.round(s.seenFirstMedian ?? NaN)} s (never: ${s.neverChanged}) · hands back ${Math.round(s.backMedian ?? NaN)} s (${Math.round(s.backWithoutLooksMedian ?? NaN)} s without looks) · $${s.usdMean?.toFixed(2)} a turn · not back in time ${s.capped ?? 0} · failed ${s.failed}`;
console.log(`${a}: ${line(A.summary)}`);
console.log(`${b}: ${line(B.summary)}`);
for (const shot of Object.keys(SHOTS)) {
  const t = tally(shot);
  console.log(`${b} vs ${a}, ${shot === 'first' ? 'first version' : 'handed back'}: ${t.win} better, ${t.tie} even, ${t.loss} worse (score ${t.score === null ? '—' : t.score.toFixed(2)}; 0.5 = as good)`);
}
for (const p of pairs.sort((x, y) => x.name.localeCompare(y.name) || x.shot.localeCompare(y.shot))) console.log(`  ${p.name} ${p.shot}: ${p.result} — ${p.why}`);

// A sheet to look at: each request's two worlds (first version, handed back), side by side.
const cell = (file) => (fs.existsSync(file) ? `<img src="data:image/png;base64,${fs.readFileSync(file).toString('base64')}">` : '<div class="none">nothing yet</div>');
const runOf = (S, name) => S.results.find((r) => r.name === name) ?? {};
const rows = B.results.filter((r) => A.results.some((x) => x.name === r.name)).map((r) => {
  const ra = runOf(A, r.name);
  const verdict = (shot) => pairs.find((p) => p.name === r.name && p.shot === shot)?.result ?? '';
  return `<tr><th>${r.name}<small>${r.prompt.replace(/</g, '&lt;')}</small></th>
    <td>${cell(path.join(dir(a), r.name, 'first.png'))}<p>${a}: ${ra.seenFirst ?? '—'} s</p></td><td>${cell(path.join(dir(b), r.name, 'first.png'))}<p>${b}: ${r.seenFirst ?? '—'} s · ${verdict('first')}</p></td>
    <td>${cell(path.join(dir(a), r.name, 'back.png'))}<p>${a}: ${ra.back ?? '—'} s · $${ra.usd ?? '—'}</p></td><td>${cell(path.join(dir(b), r.name, 'back.png'))}<p>${b}: ${r.back ?? '—'} s · $${r.usd ?? '—'} · ${verdict('back')}</p></td></tr>`;
});
const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#111;color:#ddd;font:13px system-ui}table{border-collapse:collapse}th{width:120px;text-align:left;vertical-align:top;padding:8px}th small{display:block;font-weight:400;color:#999;margin-top:4px}td{padding:6px;vertical-align:top}img,.none{width:300px;height:220px;object-fit:cover;display:block;border-radius:6px;background:#222}.none{display:grid;place-items:center;color:#666}p{margin:4px 0 0}thead td{font-weight:600}</style>
<table><thead><tr><th></th><td>${a} · first version</td><td>${b} · first version</td><td>${a} · handed back</td><td>${b} · handed back</td></tr></thead>${rows.join('')}</table>`;
const sheet = path.join(root, '.data/bench', `${a}-vs-${b}`);
fs.writeFileSync(`${sheet}.html`, html);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
await page.setContent(html);
await page.screenshot({ path: `${sheet}.png`, fullPage: true });
await browser.close();
fs.writeFileSync(`${sheet}.json`, JSON.stringify({ a: A.summary, b: B.summary, first: tally('first'), back: tally('back'), pairs: pairs.map((p) => ({ name: p.name, shot: p.shot, result: p.result, why: p.why })) }, null, 2));
console.log(`\nSheet: ${sheet}.png`);
