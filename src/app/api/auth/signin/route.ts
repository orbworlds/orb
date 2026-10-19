// POST /api/auth/signin — { username, password } → MeResponse + session cookie (SPEC §6).
import { signIn } from '@/server/accounts';
import { handle } from '@/server/http';

export const POST = handle(signIn);
