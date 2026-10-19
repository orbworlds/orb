// POST /api/auth/passkey/register/verify — attestation → MeResponse + session cookie (SPEC §6).
import { handle } from '@/server/http';
import { registrationVerify } from '@/server/passkeys';

export const POST = handle(registrationVerify);
