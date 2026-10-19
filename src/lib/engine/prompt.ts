// A build request: its limits, its validation, and the conversation it carries, made safe for
// every provider (used by /api/agent/jobs; the agents' system prompts are in
// src/server/agent/prompt.ts). Pure module: only type imports, no runtime dependencies.
import type { ModelMessage, FilePart } from 'ai';
import type { BuildRequest, ModelMessage as ChatModelMessage } from '../types';

// ---------------------------------------------------------------------------------------------
// Request limits (validated by /api/agent/jobs; the client clamps to them before sending).

export const BUILD_LIMITS = {
  messages: 30,
  messageChars: 12_000,
  image: 450_000,
  errors: 12,
  errorChars: 4_000,
  worldName: 120,
  worldId: 64,
} as const;

const IMAGE_RE = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/;

/** Validate and normalize an untrusted BuildRequest body. */
export function validateBuildRequest(body: unknown): { ok: true; req: BuildRequest } | { ok: false; message: string } {
  if (!body || typeof body !== 'object') return { ok: false, message: 'Expected a JSON object.' };
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.messages) || b.messages.length === 0) return { ok: false, message: '`messages` must be a non-empty array.' };
  if (b.messages.length > BUILD_LIMITS.messages) return { ok: false, message: `Too many messages (max ${BUILD_LIMITS.messages}).` };
  const messages: ChatModelMessage[] = [];
  for (const m of b.messages as unknown[]) {
    const mm = m as Record<string, unknown> | null;
    if (!mm || (mm.role !== 'user' && mm.role !== 'assistant') || typeof mm.content !== 'string')
      return { ok: false, message: 'Each message needs a role (user|assistant) and string content.' };
    if (mm.content.length > BUILD_LIMITS.messageChars) return { ok: false, message: `A message is too long (max ${BUILD_LIMITS.messageChars.toLocaleString('en')} characters).` };
    messages.push({ role: mm.role, content: mm.content });
  }
  if (messages[messages.length - 1].role !== 'user' || !messages[messages.length - 1].content.trim())
    return { ok: false, message: 'The last message must be a non-empty user message.' };
  let image: string | null = null;
  if (b.image != null) {
    if (typeof b.image !== 'string' || b.image.length > BUILD_LIMITS.image || !IMAGE_RE.test(b.image))
      return { ok: false, message: `\`image\` must be a jpeg/png/webp data URL under ${Math.round(BUILD_LIMITS.image / 1000)} KB.` };
    image = b.image;
  }
  let errors: string[] | undefined;
  if (b.errors != null) {
    if (!Array.isArray(b.errors) || b.errors.some((e) => typeof e !== 'string')) return { ok: false, message: '`errors` must be an array of strings.' };
    errors = (b.errors as string[]).slice(0, BUILD_LIMITS.errors).map((e) => e.slice(0, BUILD_LIMITS.errorChars));
  }
  const mode = b.mode === 'ask' ? 'ask' : b.mode === undefined || b.mode === 'build' ? 'build' : null;
  if (!mode) return { ok: false, message: '`mode` must be "build" or "ask".' };
  if (b.worldName != null && typeof b.worldName !== 'string') return { ok: false, message: '`worldName` must be a string.' };
  if (b.worldId != null && typeof b.worldId !== 'string') return { ok: false, message: '`worldId` must be a string.' };
  return {
    ok: true,
    req: {
      worldId: typeof b.worldId === 'string' ? b.worldId.slice(0, BUILD_LIMITS.worldId) : null,
      messages,
      image,
      errors,
      mode,
      worldName: typeof b.worldName === 'string' ? b.worldName.slice(0, BUILD_LIMITS.worldName) : undefined,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Messages

/** Parse a data URL into the AI SDK file-part shape (base64 payload + media type). */
export function imagePart(dataUrl: string): FilePart | null {
  const m = IMAGE_RE.exec(dataUrl);
  if (!m) return null;
  return { type: 'file', mediaType: m[1], data: m[2].replace(/\s+/g, '') };
}

/**
 * Prior turns as given, made safe for every provider: no leading assistant turn, strictly
 * alternating roles (an unanswered user turn gets a short placeholder reply), no empty content.
 */
export function normalizeHistory(history: ChatModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of history) {
    const content = m.content.trim();
    if (!content) continue;
    const prev = out[out.length - 1];
    if (!prev && m.role === 'assistant') continue;
    if (prev && prev.role === m.role) {
      if (m.role === 'user') out.push({ role: 'assistant', content: '(no reply — that build did not finish)' });
      else {
        prev.content = `${prev.content as string}\n\n${content}`;
        continue;
      }
    }
    out.push({ role: m.role, content });
  }
  // The final request is a user turn, so the history must end with an assistant turn.
  if (out.length && out[out.length - 1].role === 'user') out.push({ role: 'assistant', content: '(no reply — that build did not finish)' });
  return out;
}
