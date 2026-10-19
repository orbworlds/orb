// POST /api/auth/signup — { username, password } → MeResponse + session cookie (SPEC §6).
import { signUp } from '@/server/accounts';
import { handle } from '@/server/http';

export const POST = handle(signUp);
