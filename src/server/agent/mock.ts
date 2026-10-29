// Scripted agent for local testing (ORB_MOCK_AI=1): a LanguageModel that "builds" a small
// multi-file world with real tool calls, so the whole runner (tools, trees, versions, ticks,
// reconnects) is exercised without an AI provider. Stateless: each call looks at the
// conversation so far to decide its next step.
//
// Words in the request: "mockslow" (slower steps, to interrupt), "mockcrash" (main.js throws at
// load), "mockerror" (the provider fails), "mocklong" (many steps, to span several ticks),
// "mockchain" (even more of them, each tick ending early, to exercise the hand-over), "mockcutoff"
// (a reply cut off at the output limit), "mocklook" (plays the world with the look tool and says
// what it saw), "mockfirstlook" (a big new world's first look, ending with a question). A visitor's
// request (guide mode) gets an answer, and with "mockchange" the offer of their own copy.

import type { LanguageModel } from 'ai';

type Part = Record<string, unknown>;
type PromptMessage = { role: string; content: string | Array<Record<string, unknown>> };

const usage = (i: number, o: number) => ({
  inputTokens: { total: i, noCache: i, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: o, text: o, reasoning: undefined },
});

const INDEX = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Mock Garden</title>
<link rel="stylesheet" href="./style.css">
</head>
<body>
<canvas id="c"></canvas>
<div id="hint">Tap to plant a glow</div>
<script type="module" src="./src/main.js"></script>
</body>
</html>
`;

const STYLE = `html, body { margin: 0; height: 100%; overflow: hidden; background: #1d1b33; }
canvas { display: block; width: 100%; height: 100%; }
#hint { position: fixed; left: 16px; bottom: 16px; padding: 8px 14px; border-radius: 999px; font: 500 13px system-ui, sans-serif; color: #2a2440; background: rgba(255,255,255,.75); }
`;

const main = (crash: boolean) => `// === CONFIG ===
import { CONFIG } from './config.js';

// === SCENE ===
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const dots = [];
function resize() { canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio; }
addEventListener('resize', resize);
resize();
${crash ? "throw new Error('orb-mock-crash');\n" : ''}
// === WORLD ===
for (let i = 0; i < CONFIG.count; i++) dots.push({ x: Math.random(), y: Math.random(), r: 4 + Math.random() * 10, p: Math.random() * 6 });
canvas.addEventListener('pointerdown', (e) => dots.push({ x: e.clientX / innerWidth, y: e.clientY / innerHeight, r: 12, p: 0 }));

// === LOOP ===
function frame(t) {
  ctx.fillStyle = 'hsl(' + CONFIG.hue + ' 40% 14%)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const d of dots) {
    ctx.fillStyle = 'hsla(' + (CONFIG.hue + 60) + ' 90% 70% / ' + (0.5 + 0.5 * Math.sin(t / 600 + d.p)) + ')';
    ctx.beginPath();
    ctx.arc(d.x * canvas.width, d.y * canvas.height, d.r * devicePixelRatio, 0, Math.PI * 2);
    ctx.fill();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setTimeout(() => window.orb?.capture?.(), 1500);
`;

const CONFIG_JS = (hue: number) => `export const CONFIG = { hue: ${hue}, count: 40 };\n`;

function textOf(m: PromptMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content.map((p) => (p.type === 'text' ? String(p.text ?? '') : p.type === 'tool-result' ? JSON.stringify(p.output ?? '') : '')).join('\n');
}

let ids = 0;

/** Decide the next step from the conversation so far. */
function plan(prompt: PromptMessage[]): { text?: string; calls: Array<{ name: string; input: Record<string, unknown> }>; fail?: boolean; cut?: boolean } {
  let lastUser = -1;
  for (let i = prompt.length - 1; i >= 0; i--) {
    const t = prompt[i].role === 'user' ? textOf(prompt[i]) : '';
    if (prompt[i].role === 'user' && !t.startsWith('(Your previous reply was cut off') && !t.startsWith('(Screenshots from your look')) {
      lastUser = i;
      break;
    }
  }
  const request = lastUser >= 0 ? textOf(prompt[lastUser]).toLowerCase() : '';
  // The pictures it was shown with the request (the world's screenshot, the person's photos).
  const asked = lastUser >= 0 ? prompt[lastUser].content : '';
  const pictures = Array.isArray(asked) ? asked.filter((p) => p.type === 'file').length : 0;
  const sawPictures = pictures ? ` I can see ${pictures === 1 ? 'one picture' : `${pictures} pictures`}.` : '';
  // "mockphoto": the world uses the person's first photo (by its path, as the request names it).
  const photo = request.includes('mockphoto') ? /photos\/[\w-]+\.(?:jpg|png|webp|gif)/.exec(request)?.[0] : undefined;
  const step = prompt.slice(lastUser + 1).filter((m) => m.role === 'assistant').length;
  const results = prompt.slice(lastUser + 1).filter((m) => m.role === 'tool').map(textOf).join('\n');
  if (request.includes('mockerror')) return { calls: [], fail: true };
  // A visitor in someone else's world (guide mode): an answer in place; a change request ("mockchange")
  // gets the offer of their own copy.
  if (prompt.some((m) => m.role === 'system' && textOf(m).includes('# Mode: guide'))) {
    return request.includes('mockchange')
      ? { text: "This world is someone else's — remix it and I'll change it in your copy!", calls: [{ name: 'offer_remix', input: {} }, { name: 'suggest_next', input: { ideas: ['How does it work?', 'What can I do here?', 'Is there a secret?'] } }] }
      : { text: `Walk around with the arrow keys and tap things to see what they do!${sawPictures}`, calls: [{ name: 'suggest_next', input: { ideas: ['What can I do here?', 'Is there a secret?', 'How do I win?'] } }] };
  }
  if (request.includes('mockfirstlook')) return { calls: [{ name: 'suggest_next', input: { ideas: ['Keep going like this', 'Softer painted look', 'Golden sunset'], question: 'Is this the feel you want?' } }] };
  // A first reply cut off at the output limit after a whole tool call ("mockcutoff").
  if (request.includes('mockcutoff') && step === 0) return { cut: true, text: 'Building it now.', calls: [{ name: 'list_files', input: {} }] };
  const repair = request.includes('<errors>');
  const long = request.includes('mocklong') || request.includes('mockchain');

  if (step === 0) return { text: repair ? 'Oops — smoothing out a tiny hiccup.' : 'Ooh, a glowing garden — building it now!', calls: [{ name: 'list_files', input: {} }] };
  const hasWorld = /src\/main\.js/.test(results);
  if (step === 1) {
    if (repair) return { calls: [{ name: 'write_file', input: { label: 'Fixing the glow', path: 'src/main.js', content: main(false) } }] };
    if (!hasWorld)
      return {
        calls: [
          { name: 'name_world', input: { name: 'Mock Garden', kind: 'toy' } },
          { name: 'write_file', input: { label: 'Laying out the garden', path: 'index.html', content: INDEX } },
          { name: 'write_file', input: { label: 'Painting the sky', path: 'style.css', content: STYLE } },
          { name: 'write_file', input: { label: 'Tuning the colors', path: 'src/config.js', content: CONFIG_JS(250) } },
          { name: 'write_file', input: { label: 'Planting the glows', path: 'src/main.js', content: main(request.includes('mockcrash')) } },
          ...(photo ? [{ name: 'write_file', input: { label: 'Hanging your photo', path: 'src/poster.js', content: `export const POSTER = '${photo}';\n` } }] : []),
        ],
      };
    return { calls: [{ name: 'read_file', input: { path: 'src/config.js' } }] };
  }
  if (request.includes('mocklook') && step === 2) {
    return {
      text: 'Let me try it out.',
      calls: [{ name: 'look', input: { actions: [{ type: 'click', x: 0.5, y: 0.5 }, { type: 'key', key: 'w', ms: 150 }, { type: 'eval', js: 'document.title' }] } }],
    };
  }
  if (request.includes('mocklook') && step === 3) {
    const tools = prompt.slice(lastUser + 1).filter((m) => m.role === 'tool');
    const seen = tools.length ? textOf(tools[tools.length - 1]) : '';
    const fps = /Frame rate: (\d+) fps/.exec(seen);
    const title = /eval \\?"document\.title\\?" → \\?"([^"\\]*)\\?"/.exec(seen);
    const said = fps
      ? `I played it: ${fps[1]} fps, ${/Errors: none/.test(seen) ? 'no errors' : 'some errors'}, title ${title ? title[1] : 'unknown'}${/"type":"file"/.test(seen) ? ', screenshot seen' : ''}.`
      : /Nobody has the world open/.test(seen)
        ? "Nobody's watching, so I checked the code instead."
        : `I couldn't look: ${seen.replace(/^\{"type":"text","value":"|"\}$/g, '').slice(0, 160)}`;
    return { text: said, calls: [{ name: 'suggest_next', input: { ideas: ['Make it sunset', 'Add fireflies', 'Add soft music'] } }] };
  }
  const hue = /hue: (\d+)/.exec(results);
  if (step === 2 && hasWorld && hue && !repair) {
    const next = (Number(hue[1]) + 40) % 360;
    return { text: 'Shifting the colors a little.', calls: [{ name: 'edit_file', input: { label: 'Shifting the colors', path: 'src/config.js', old_string: `hue: ${hue[1]}`, new_string: `hue: ${next}` } }] };
  }
  if (long && step < (request.includes('mockchain') ? 26 : 9)) return { text: `Step ${step}.`, calls: [{ name: 'write_file', input: { label: `Adding note ${step}`, path: `.orb/note-${step}.md`, content: `step ${step}\n` } }] };
  return { text: repair ? 'All better now!' : `Your garden is ready — tap to plant more glows!${sawPictures}`, calls: [{ name: 'suggest_next', input: { ideas: ['Make it sunset', 'Add fireflies', 'Add soft music'] } }] };
}

export function mockAgentModel(): LanguageModel {
  return {
    specificationVersion: 'v4',
    provider: 'orb-mock',
    modelId: 'mock-agent',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('mock agent only streams');
    },
    async doStream(options: { prompt: PromptMessage[]; abortSignal?: AbortSignal }) {
      // Like Anthropic's API: a tool call without its result in the conversation is refused.
      const answered = new Set(options.prompt.flatMap((m) => (m.role === 'tool' && Array.isArray(m.content) ? m.content.map((c) => String(c.toolCallId ?? '')) : [])));
      const unanswered = options.prompt.flatMap((m) => (m.role === 'assistant' && Array.isArray(m.content) ? m.content.filter((c) => c.type === 'tool-call' && !answered.has(String(c.toolCallId))) : []));
      if (unanswered.length) throw Object.assign(new Error(`Tool results are missing for tool calls ${unanswered.map((c) => c.toolCallId).join(', ')}.`), { statusCode: 400 });
      const p = plan(options.prompt);
      const slow = options.prompt.some((m) => m.role === 'user' && textOf(m).toLowerCase().includes('mockslow'));
      const delay = slow ? 400 : 40;
      const parts: Part[] = [];
      if (p.text) {
        parts.push({ type: 'text-start', id: 't' });
        for (const w of p.text.split(/(?<= )/)) parts.push({ type: 'text-delta', id: 't', delta: w });
        parts.push({ type: 'text-end', id: 't' });
      }
      for (const c of p.calls) {
        const id = `mock-${++ids}`;
        const input = JSON.stringify(c.input);
        parts.push({ type: 'tool-input-start', id, toolName: c.name });
        for (let i = 0; i < input.length; i += 400) parts.push({ type: 'tool-input-delta', id, delta: input.slice(i, i + 400) });
        parts.push({ type: 'tool-input-end', id });
        parts.push({ type: 'tool-call', toolCallId: id, toolName: c.name, input });
      }
      parts.push({ type: 'finish', finishReason: { unified: p.cut ? 'length' : p.calls.length ? 'tool-calls' : 'stop', raw: undefined }, usage: usage(1000, 200) });
      const signal = options.abortSignal;
      const stream = new ReadableStream<Part>({
        async start(controller) {
          for (const part of parts) {
            if (signal?.aborted) {
              controller.error(signal.reason ?? new Error('aborted'));
              return;
            }
            await new Promise((r) => setTimeout(r, delay));
            if (p.fail) {
              controller.error(Object.assign(new Error('The mock AI is overloaded (mockerror).'), { statusCode: 529 }));
              return;
            }
            controller.enqueue(part);
          }
          controller.close();
        },
      });
      return { stream };
    },
  } as unknown as LanguageModel;
}
