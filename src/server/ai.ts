// The AI behind builds on Orb's AI (agent jobs, /api/agent/jobs): one model for everyone, Free
// and Pro alike (Pro has more credits, not another model).
// - ANTHROPIC_API_KEY set → Orb's own agent on Anthropic directly (ORB_ANTHROPIC_MODEL, default
//   claude-opus-5-5).
// - else ORB_CURSOR_KEY set → Cursor Cloud Agents on that key (ORB_CURSOR_MODEL at
//   ORB_CURSOR_EFFORT, see ./agent/cursor.ts and ./agent/sync.ts).
// - otherwise → Orb's own agent on the Vercel AI Gateway (ORB_MODEL, default
//   anthropic/claude-opus-5.5). On Vercel the gateway authenticates with the deployment's OIDC
//   token (VERCEL_OIDC_TOKEN) automatically; AI_GATEWAY_API_KEY works too (e.g. locally).
// - ORB_MOCK_AI=1 → the agent follows a script instead (see ./agent/mock.ts).

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGateway } from '@ai-sdk/gateway';
import type { LanguageModel } from 'ai';
import { DEFAULT_CURSOR_MODEL } from './cursor';

const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const DEFAULT_GATEWAY_MODEL = 'anthropic/claude-opus-5.5';

const env = (k: string): string => (process.env[k] ?? '').trim();

/** Canned responses instead of real AI calls (local testing). */
export function mockAi(): boolean {
  return env('ORB_MOCK_AI') === '1' || env('ORB_MOCK_AI') === 'true';
}

function anthropicDirect(): boolean {
  return !!env('ANTHROPIC_API_KEY');
}

/** Orb's own Cursor API key, for the free tier's agent builds (null when there is none). */
export function serverCursorKey(): string | null {
  return env('ORB_CURSOR_KEY') || null;
}

/** Whether the free tier's agent builds run as Cursor agents on Orb's key. */
export function freeOnCursor(): boolean {
  return !mockAi() && !anthropicDirect() && !!serverCursorKey();
}

/**
 * True when server-side AI is configured (a key, the gateway via OIDC on Vercel, or the mock).
 * It may still fail at runtime (e.g. the gateway requires account verification): the build then
 * ends with the free builder resting (and Orb's errors page hears of it).
 */
export function aiConfigured(): boolean {
  return (
    mockAi() ||
    anthropicDirect() ||
    !!serverCursorKey() ||
    !!env('AI_GATEWAY_API_KEY') ||
    !!env('VERCEL_OIDC_TOKEN') ||
    !!env('VERCEL')
  );
}

/** Human-readable id of the model the free tier uses (shown in settings / config). */
export function modelLabel(): string {
  if (mockAi()) return 'mock';
  if (anthropicDirect()) return env('ORB_ANTHROPIC_MODEL') || DEFAULT_ANTHROPIC_MODEL;
  if (freeOnCursor()) return DEFAULT_CURSOR_MODEL;
  return env('ORB_MODEL') || DEFAULT_GATEWAY_MODEL;
}

/** Which backend the free tier talks to. */
export function aiBackend(): 'mock' | 'anthropic' | 'gateway' {
  if (mockAi()) return 'mock';
  return anthropicDirect() ? 'anthropic' : 'gateway';
}

let anthropicProvider: ReturnType<typeof createAnthropic> | null = null;
let gatewayProvider: ReturnType<typeof createGateway> | null = null;

/** The language model of Orb's AI (`modelId`: another one). Providers are created lazily and reused. */
export function getServerModel(modelId?: string | null): LanguageModel {
  if (anthropicDirect()) {
    anthropicProvider ??= createAnthropic({ apiKey: env('ANTHROPIC_API_KEY') });
    return anthropicProvider(modelId || env('ORB_ANTHROPIC_MODEL') || DEFAULT_ANTHROPIC_MODEL);
  }
  // No apiKey given: the gateway reads AI_GATEWAY_API_KEY, or the Vercel OIDC token at request time.
  gatewayProvider ??= createGateway();
  return gatewayProvider(modelId || env('ORB_MODEL') || DEFAULT_GATEWAY_MODEL);
}
