// Language models for agent jobs: the free tier (see ../ai.ts), people's own keys, or the mock.

import type { LanguageModel } from 'ai';
import { SITE } from '@/lib/site';
import { getServerModel, mockAi } from '../ai';
import { mockAgentModel } from './mock';

/** 'mock' is the scripted test model (./mock.ts): locally, or for admins checking production. */
export type AgentProvider = 'free' | 'anthropic' | 'openai' | 'openrouter' | 'cursor' | 'mock';
/** 'cursor' works on the world's GitHub repository with a Cursor agent (see ./cursor.ts). */
export const AGENT_PROVIDERS: AgentProvider[] = ['free', 'anthropic', 'openai', 'openrouter', 'cursor'];

export const DEFAULT_AGENT_MODELS: Record<Exclude<AgentProvider, 'free' | 'mock' | 'cursor'>, string> = {
  anthropic: 'claude-sonnet-5-5',
  openrouter: 'anthropic/claude-sonnet-5.5',
  openai: 'gpt-6.1-sol',
};

export const PROVIDER_NAMES: Record<AgentProvider, string> = { free: 'Orb', anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter', cursor: 'Cursor', mock: 'Mock' };

/** The model's reasoning effort (the providers' own level names). */
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh';
export const AGENT_EFFORTS: AgentEffort[] = ['low', 'medium', 'high', 'xhigh'];
const isEffort = (v: unknown): v is AgentEffort => typeof v === 'string' && (AGENT_EFFORTS as string[]).includes(v);

/**
 * Anthropic and OpenAI keys run at high effort unless people chose another level, like a coding
 * agent in their own hands. Orb's AI thinks little (ORB_AI_EFFORT, default low): the provider's
 * default is high, and thinking is most of what a build costs. OpenRouter keeps its default: its
 * OpenAI-style chat API can't carry thinking from one step to the next.
 */
export function reasoningFor(provider: AgentProvider, ext: Record<string, unknown>): AgentEffort | undefined {
  if (provider === 'free') return isEffort(process.env.ORB_AI_EFFORT) ? process.env.ORB_AI_EFFORT : 'low';
  if (provider !== 'anthropic' && provider !== 'openai') return undefined;
  return isEffort(ext.effort) ? ext.effort : 'high';
}

export async function agentModel(provider: AgentProvider, apiKey: string | null, modelId: string | null): Promise<LanguageModel> {
  if (mockAi() || provider === 'mock') return mockAgentModel(); // testing, whatever the provider
  if (provider === 'free') return getServerModel(modelId);
  if (!apiKey) throw new Error('missing key');
  const id = modelId || DEFAULT_AGENT_MODELS[provider as Exclude<AgentProvider, 'free' | 'mock' | 'cursor'>];
  switch (provider) {
    case 'cursor':
      throw new Error('Cursor builds run as Cursor agents (see ./cursor.ts), not through a model.');
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({ apiKey })(id);
    }
    case 'openrouter': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1', name: 'openrouter', headers: { 'HTTP-Referer': SITE, 'X-Title': 'Orb' } }).chat(id);
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey })(id);
    }
  }
}
