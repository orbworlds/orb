// Worlds kept in sync with GitHub (src/server/reposync.ts): check the ones nobody opened for a while,
// so a push to their repository comes in by itself. Called every 10 minutes by the GitHub sync
// workflow (.github/workflows/github-sync.yml). Safe to call by anyone: it only checks links that
// are due, a few at a time, and it is rate limited.

import { error, json } from '@/server/http';
import { rateLimit } from '@/server/ratelimit';
import { sweepRepos } from '@/server/reposync';
import { ready } from '@/server/schema';

export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  const db = await ready();
  const secret = process.env.CRON_SECRET;
  const trusted = !!secret && req.headers.get('authorization') === `Bearer ${secret}`;
  if (!trusted) {
    const r = await rateLimit(db, 'cron:github', 6, 60);
    if (!r.ok) return error(429, 'rate_limited', 'Too often.', { retryAfter: r.retryAfter });
  }
  return json({ checked: await sweepRepos(db, 20) });
}

export const POST = GET;
