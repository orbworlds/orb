// GET /api/github/login[?next=/w/<id>] — start "Connect GitHub" via OAuth (SPEC §6).
// Only active when GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set; otherwise 404 JSON and the
// UI falls back to the paste-a-token flow. The callback hands the token to the browser in the URL
// fragment, which gives it to POST /api/me/github.
import { GH_STATE_COOKIE, GH_STATE_PATH, randomId, safeNext } from '@/server/auth';
import { error, handle } from '@/server/http';
import { requestOrigin } from '@/server/origins';

const STATE_TTL_SEC = 10 * 60;

export const GET = handle(async (req: Request): Promise<Response> => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId || !process.env.GITHUB_CLIENT_SECRET) {
    return error(404, 'not_configured', "GitHub sign-in isn't set up here. You can paste a token instead.");
  }

  const { origin } = requestOrigin(req);
  const next = safeNext(new URL(req.url).searchParams.get('next'));
  const state = randomId(32);

  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', `${origin}/api/github/callback`);
  authorize.searchParams.set('scope', 'repo');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('allow_signup', 'true');

  // SameSite=Lax: the cookie must survive GitHub's top-level redirect back to the callback.
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const cookie = `${GH_STATE_COOKIE}=${state}.${encodeURIComponent(next)}; Path=${GH_STATE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_SEC}${secure}`;
  return new Response(null, {
    status: 302,
    headers: { location: authorize.toString(), 'set-cookie': cookie, 'cache-control': 'no-store' },
  });
});
