// POST /api/auth/password — { password }, signed in: set or change the password → MeResponse (SPEC §6).
import { setPassword } from '@/server/accounts';
import { handle } from '@/server/http';

export const POST = handle(setPassword);
