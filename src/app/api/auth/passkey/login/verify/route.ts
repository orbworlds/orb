// POST /api/auth/passkey/login/verify — assertion → MeResponse + session cookie (SPEC §6).
import { handle } from '@/server/http';
import { authenticationVerify } from '@/server/passkeys';

export const POST = handle(authenticationVerify);
