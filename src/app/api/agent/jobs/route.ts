// POST /api/agent/jobs — start a build: every build is a server-side agent job (see
// src/server/agent/runner.ts). Streams its output (Orb protocol text + control frames; the first
// frame is the job handle). The build goes on without the page; GET /api/agent/jobs/:id follows it.
//
// Body: BuildRequest ({ worldId, messages, errors?, image?, mode, worldName }; the agent reads the
// world's files itself). Own keys: x-orb-agent-provider (anthropic | openai |
// openrouter), x-orb-agent-key, x-orb-agent-model, x-orb-agent-effort (Anthropic and OpenAI:
// low | medium | high | xhigh, high by default). The key is kept encrypted with the job only
// while it runs. Free builds run as Cursor agents on Orb's own key when that is how the free
// builder is set up (src/server/ai.ts), with fewer of them a day.

import { after } from 'next/server';
import type { ModelMessage, TextPart, FilePart } from 'ai';
import { BUILD_LIMITS, imagePart, normalizeHistory, validateBuildRequest } from '@/lib/engine/prompt';
import type { BuildRequest } from '@/lib/types';
import { aiConfigured, freeOnCursor, mockAi, serverCursorKey } from '@/server/ai';
import { canEdit, getViewer, isAdmin } from '@/server/auth';
import { botCheck } from '@/server/botid';
import { buildCost, checkByoLimits, checkCredits, checkRateLimits, refundQuota, type Billing } from '@/server/buildlimits';
import { DEFAULT_CURSOR_MODEL, serverCursorParams } from '@/server/cursor';
import { recordServerError } from '@/server/errors';
import { freeTierConfig, type LimitCheck } from '@/server/freetier';
import type { Db } from '@/server/db';
import { getText, isText, getBlob, type Tree } from '@/server/files';
import { error, readJson } from '@/server/http';
import { requestOrigin } from '@/server/origins';
import { ready } from '@/server/schema';
import { traceGroup } from '@/server/traces';
import { worldTree } from '@/server/worlds';
import { followJob } from '@/server/agent/follow';
import { cursorOrbPrompt } from '@/server/agent/prompt';
import { AGENT_EFFORTS, AGENT_PROVIDERS, type AgentEffort, type AgentProvider } from '@/server/agent/models';
import { createAgentJob, MAX_RUNNING, runningJobs, runTick, kick } from '@/server/agent/runner';

export const maxDuration = 300;

const MAX_BODY = BUILD_LIMITS.image + BUILD_LIMITS.messages * BUILD_LIMITS.messageChars + 100_000;
/** Inline all files in the first message when they are this small together (saves read steps). */
const INLINE_ALL = 60_000;
const INLINE_ENTRY = 24_000;
const LIST_MAX = 300;

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, ' ');

/** The first user message: the world's files (inlined when small), errors, screenshot, request. */
async function firstMessage(db: Db, files: Tree, name: string, req: BuildRequest): Promise<ModelMessage> {
  const paths = Object.keys(files).sort();
  const texts = new Map<string, string>();
  let total = 0;
  for (const p of paths) {
    const bytes = await getBlob(db, files[p]);
    if (!bytes) continue;
    total += bytes.length;
    if (total > INLINE_ALL) break;
    if (isText(p, bytes)) texts.set(p, new TextDecoder().decode(bytes));
  }
  const inlineAll = total <= INLINE_ALL;
  const parts: Array<TextPart | FilePart> = [];
  const entry = files['index.html'] ? ((inlineAll ? texts.get('index.html') : await getText(db, files['index.html'])) ?? '') : '';
  const empty = !entry.trim() && paths.length <= 1;
  let world = `<world name="${escapeAttr(name || 'Untitled world')}" files="${paths.length}">\n`;
  if (empty) world += 'There is no world yet — create it (index.html first).\n';
  else {
    world += `Files:\n${paths.slice(0, LIST_MAX).join('\n')}${paths.length > LIST_MAX ? `\n… and ${paths.length - LIST_MAX} more (use list_files)` : ''}\n`;
    const shown = inlineAll ? [...texts.keys()] : entry.length <= INLINE_ENTRY ? ['index.html'] : [];
    for (const p of shown) world += `\n<file path="${escapeAttr(p)}">\n${p === 'index.html' ? entry : texts.get(p)}\n</file>\n`;
    if (!inlineAll) world += '\n(Bigger world: read the files you need with read_file / search.)\n';
  }
  parts.push({ type: 'text', text: `${world}</world>` });
  const errors = (req.errors ?? []).map((e) => e.trim()).filter(Boolean);
  if (errors.length) {
    parts.push({ type: 'text', text: `<errors>\n${errors.map((e, i) => `${i + 1}. ${e}`).join('\n\n')}\n</errors>\nAutomatic repair: fix exactly these problems with small edits (runtime line numbers refer to the file named in each error). Add nothing new.` });
  }
  const img = req.image ? imagePart(req.image) : null;
  if (img) {
    parts.push({ type: 'text', text: 'Screenshot of the world as it looks right now:' });
    parts.push(img);
  }
  const last = req.messages[req.messages.length - 1];
  parts.push({ type: 'text', text: `<request>\n${last.content.trim()}\n</request>` });
  return { role: 'user', content: parts };
}

/** Cursor agents take one prompt (+ images): the whole instruction for working on the world's files through Orb's link. */
function cursorMessage(build: BuildRequest, worldName: string, mode: 'build' | 'ask'): ModelMessage {
  const history = build.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
  const opts = { worldName: build.worldName || worldName, history, request: build.messages[build.messages.length - 1].content, errors: build.errors };
  const text = cursorOrbPrompt({ ...opts, mode });
  const img = build.image ? imagePart(build.image) : null;
  return { role: 'user', content: img ? [{ type: 'text', text }, img] : [{ type: 'text', text }] };
}

/** `{"effort":"high","fast":"true"}` → Cursor's [{id, value}] (bounded, strings only). */
function parseCursorParams(raw: string | null): Array<{ id: string; value: string }> | undefined {
  if (!raw || raw.length > 1000) return undefined;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out = Object.entries(o)
      .filter(([k, v]) => typeof v === 'string' && /^[\w.-]{1,40}$/.test(k) && /^[\w.-]{1,40}$/.test(v))
      .slice(0, 8)
      .map(([id, value]) => ({ id, value: value as string }));
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await readJson<Record<string, unknown>>(req, MAX_BODY);
    if (body === null) return error(400, 'bad_request', 'Expected a JSON body (or it was too large).');
    const valid = validateBuildRequest(body);
    if (!valid.ok) return error(400, 'bad_request', valid.message);
    const build = valid.req;
    if (!build.worldId) return error(400, 'bad_request', 'A build needs a world.');

    const provider = ((req.headers.get('x-orb-agent-provider') ?? 'free').trim() || 'free') as AgentProvider;
    const mock = provider === 'mock' && isAdmin(req); // admins can check production with the scripted model
    if (!AGENT_PROVIDERS.includes(provider) && !mock) return error(400, 'bad_request', 'Unknown AI provider.');
    const apiKey = provider === 'free' || mock ? null : (req.headers.get('x-orb-agent-key') ?? '').trim();
    if (provider !== 'free' && !mock && (!apiKey || apiKey.length > 400 || /\s/.test(apiKey))) return error(400, 'bad_key', "That doesn't look like an API key — check it in You → Model.");
    const model = (req.headers.get('x-orb-agent-model') ?? '').trim().slice(0, 120) || null;
    const effort = (req.headers.get('x-orb-agent-effort') ?? '').trim() as AgentEffort;
    if (provider === 'free' && !aiConfigured()) return error(503, 'ai_unavailable', "The free builder isn't set up here yet. Add your own AI key in You → Model to keep building.");
    const viaCursor = provider === 'free' && !mock && freeOnCursor();
    if (provider === 'free' && !mock && !isAdmin(req)) {
      const bot = await botCheck();
      if (bot) return bot;
    }

    const db = await ready();
    const viewer = getViewer(req);
    if (!viewer.deviceHash && !viewer.userId) return error(400, 'device_required', 'Missing device key.');
    const rows = await db.query<{ id: string; kind: string; visibility: string; owner_device: string | null; owner_user: string | null }>(
      `select id, kind, visibility, owner_device, owner_user from orb_worlds where id = $1`,
      [build.worldId],
    );
    const w = rows[0];
    const owner = w ? await canEdit(db, viewer, w) : false;
    if (!w || w.kind !== 'native' || (w.visibility === 'private' && !owner)) return error(404, 'not_found', 'This world does not exist.');
    const mode = build.mode === 'ask' || !owner ? 'ask' : 'build';

    let charged: LimitCheck[] = [];
    let billing: Billing | null = null;
    if (provider === 'free' && !mock) {
      const credits = await checkCredits(req);
      if ('response' in credits) return credits.response;
      billing = credits.billing;
      const quota = await checkRateLimits(req, buildCost(build), freeTierConfig(process.env, mockAi(), viaCursor), billing?.paid);
      if ('response' in quota) return quota.response;
      charged = quota.charged;
    } else if (!mock) {
      const limited = await checkByoLimits(req);
      if (limited) return limited;
    }
    if ((await runningJobs(db, viewer)) >= MAX_RUNNING) {
      await refundQuota(charged);
      return error(429, 'rate_limited', `You already have ${MAX_RUNNING} builds running — wait for one to finish, then try again.`, { retryAfter: 30 });
    }

    const world = await worldTree(db, build.worldId);
    if (!world) return error(404, 'not_found', 'This world does not exist.');
    const messages: ModelMessage[] =
      provider === 'cursor' || viaCursor
        ? [cursorMessage(build, world.name, mode)]
        : [...normalizeHistory(build.messages.slice(0, -1)), await firstMessage(db, world.files, build.worldName ?? world.name, build)];
    const { origin } = requestOrigin(req);
    // Orb's AI builds with one model for everyone; Pro only has more credits.
    const freeModel = viaCursor ? DEFAULT_CURSOR_MODEL : null;
    const ext: Record<string, unknown> = viaCursor
      ? { backend: 'cursor', params: await serverCursorParams(serverCursorKey()!, freeModel!, req.signal) }
      : provider === 'cursor'
        ? { params: parseCursorParams(req.headers.get('x-orb-cursor-params')) }
        : AGENT_EFFORTS.includes(effort) && provider !== 'free'
          ? { effort }
          : {};
    if (billing) ext.billing = billing;
    const id = await createAgentJob(db, {
      owner: viewer,
      worldId: build.worldId,
      mode,
      provider,
      model: provider === 'free' ? freeModel : model,
      apiKey,
      origin,
      messages,
      prompt: build.messages[build.messages.length - 1].content,
      ext: Object.keys(ext).length ? ext : undefined,
      trace: { group: traceGroup(req), meta: build.errors?.length ? { repair: build.errors.length } : undefined },
    });
    // The first tick runs right here; later ones chain through /api/agent/tick.
    const first = runTick(db, id)
      .then((r) => (r === 'continue' ? kick(origin, id, db) : undefined))
      .catch((e) => console.error('[orb] agent first tick failed', e));
    after(() => first);
    return followJob(req, db, id, 0, { announce: true });
  } catch (e) {
    console.error('[orb] /api/agent/jobs failed', e);
    after(() => recordServerError(e, '/api/agent/jobs'));
    return error(500, 'server_error', 'Something went wrong. Please try again.');
  }
}
