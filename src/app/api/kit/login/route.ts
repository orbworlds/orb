// POST /api/kit/login → { code, poll, url }: the Orb kit asks to push as someone (src/server/kit.ts).
// They open `url` (/kit/<code>) where they use Orb and allow it; the kit polls with `poll`.
// GET /api/kit/login?poll=… → { token, name } once allowed (only once), 202 { status: 'pending' }
// until then, 404 when the code expired (10 minutes).

import { clientIp, json } from '@/server/http';
import { pollLogin, startLogin } from '@/server/kit';
import { requestOrigin } from '@/server/origins';
import { ready } from '@/server/schema';
import { fail, limitOrThrow, route } from '@/server/worlds';

export const POST = route(async (req: Request) => {
  const db = await ready();
  await limitOrThrow(db, `kitlogin:${clientIp(req)}`, 20, 600, 'Too many sign-ins from here just now. Try again in a few minutes.');
  const { code, poll } = await startLogin(db);
  return json({ code, poll, url: `${requestOrigin(req).origin}/kit/${code}` }, { headers: { 'cache-control': 'no-store' } });
});

export const GET = route(async (req: Request) => {
  const poll = new URL(req.url).searchParams.get('poll') ?? '';
  if (!/^[A-Za-z0-9]{20,64}$/.test(poll)) fail(400, 'bad_request', 'Expected ?poll=…');
  const db = await ready();
  const got = await pollLogin(db, poll);
  if (!got) fail(404, 'expired', 'That sign-in expired. Run the push again.');
  if (got === 'pending') return json({ status: 'pending' }, { status: 202, headers: { 'cache-control': 'no-store' } });
  return json(got, { headers: { 'cache-control': 'no-store' } });
});
