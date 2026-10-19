// POST /api/auth/passkey/register/options — body { name } → WebAuthn creation options (SPEC §6).
import { handle } from '@/server/http';
import { registrationOptions } from '@/server/passkeys';

export const POST = handle(registrationOptions);
