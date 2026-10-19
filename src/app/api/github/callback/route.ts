// GET /api/github/callback?code=…&state=… — finish the GitHub OAuth flow (SPEC §6).
// Verifies `state` against the cookie set by /api/github/login, exchanges the code for a token and
// redirects to `<next>#gh_token=<token>` (default next = "/"): the browser holds the device key that
// says whose token it is, so `consumeGitHubTokenFromHash()` (components/orb/GitHubConnect.tsx) cleans
// the URL and hands it to POST /api/me/github. Failures redirect with `#gh_error=<code>`.
import crypto from 'node:crypto';
import { readCookie } from '@/server/auth';
import { error, handle } from '@/server/http';
import { requestOrigin } from '@/server/passkeys';

// Keep in sync with ../login/route.ts
const STATE_COOKIE = 'orb_gh_state';
const STATE_PATH = '/api/github';

function safeNext(raw: string | null): string {
  if (!raw || raw.length > 300 || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw.split('#')[0] || '/';
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Exchange the OAuth code for an access token (null on any failure). */
async function exchangeCode(code: string, redirectUri: string, clientId: string, clientSecret: string): Promise<string | null> {
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    if (!res.ok) {
      console.warn('[orb] github token exchange failed: HTTP', res.status);
      return null;
    }
    const data = (await res.json()) as { access_token?: unknown; error?: unknown };
    if (typeof data.access_token === 'string' && data.access_token) return data.access_token;
    console.warn('[orb] github token exchange failed:', typeof data.error === 'string' ? data.error : 'no token');
    return null;
  } catch (e) {
    console.warn('[orb] github token exchange failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

export const GET = handle(async (req: Request): Promise<Response> => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return error(404, 'not_configured', "GitHub sign-in isn't set up here. You can paste a token instead.");
  }

  const { origin } = requestOrigin(req);
  const url = new URL(req.url);

  // Cookie value: "<state>.<encoded next path>" (state is base62, so the first "." splits it).
  const raw = readCookie(req, STATE_COOKIE) ?? '';
  const dot = raw.indexOf('.');
  const expectedState = dot > 0 ? raw.slice(0, dot) : '';
  let next = '/';
  try {
    next = safeNext(dot > 0 ? decodeURIComponent(raw.slice(dot + 1)) : null);
  } catch {
    /* malformed cookie → "/" */
  }

  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const back = (fragment: string) =>
    new Response(null, {
      status: 302,
      headers: {
        location: `${origin}${next}#${fragment}`,
        'set-cookie': `${STATE_COOKIE}=; Path=${STATE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      },
    });

  const ghError = url.searchParams.get('error');
  if (ghError) return back(`gh_error=${ghError === 'access_denied' ? 'access_denied' : 'oauth'}`);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || !expectedState || !sameString(state, expectedState)) return back('gh_error=state');

  const token = await exchangeCode(code, `${origin}/api/github/callback`, clientId, clientSecret);
  if (!token) return back('gh_error=exchange');
  return back(`gh_token=${encodeURIComponent(token)}`);
});
