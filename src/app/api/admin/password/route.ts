// POST /api/admin/password — (admin) { username, password }: reset a forgotten password.
import { resetPassword } from '@/server/accounts';
import { handle } from '@/server/http';

export const POST = handle(resetPassword);
