// POST /api/auth/passkey/login/options — WebAuthn request options for a discoverable passkey (SPEC §6).
import { handle } from '@/server/http';
import { authenticationOptions } from '@/server/passkeys';

export const POST = handle(authenticationOptions);
