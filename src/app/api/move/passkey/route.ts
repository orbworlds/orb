// POST /api/move/passkey {kind, name?, to} — make the passkey at Orb's passkey home when this
// browser can't here → { url } (src/server/move.ts, src/lib/passkey.ts).
import { handle } from '@/server/http';
import { startPasskey } from '@/server/move';

export const POST = handle(startPasskey);
