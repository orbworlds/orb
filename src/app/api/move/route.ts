// POST /api/move — on a former address: keep this browser's things for the new one to pick up
// → { url } (src/server/move.ts).
import { handle } from '@/server/http';
import { createHandoff } from '@/server/move';

export const POST = handle(createHandoff);
