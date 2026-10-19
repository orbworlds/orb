// POST /api/auth/logout — clears the session cookie and unlinks this device → { ok: true } (SPEC §6).
import { handle } from '@/server/http';
import { logout } from '@/server/passkeys';

export const POST = handle(logout);
