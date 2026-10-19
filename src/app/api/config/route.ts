// GET /api/config — public client configuration (SPEC §6). No secrets: the realtime key is the
// Supabase *anon* key, which is meant to be public.

import type { ApiConfig } from '@/lib/types';
import { aiConfigured, modelLabel } from '@/server/ai';
import { json } from '@/server/http';
import { route } from '@/server/worlds';

const env = (k: string): string => (process.env[k] ?? '').trim();

function realtime(): ApiConfig['realtime'] {
  const url = env('NEXT_PUBLIC_SUPABASE_URL') || env('SUPABASE_URL');
  const key = env('NEXT_PUBLIC_SUPABASE_ANON_KEY') || env('SUPABASE_ANON_KEY');
  return url && key ? { url, key } : null;
}

export const GET = route(async () => {
  const config: ApiConfig = {
    ai: aiConfigured(),
    model: modelLabel(),
    githubOAuth: !!(env('GITHUB_CLIENT_ID') && env('GITHUB_CLIENT_SECRET')),
    realtime: realtime(),
    passkeys: true,
  };
  return json(config, { headers: { 'cache-control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600' } });
});
