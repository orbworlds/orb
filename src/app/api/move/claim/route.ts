// POST /api/move/claim — on the site: pick up what this browser brought from a former address
// (src/server/move.ts).
import { handle } from '@/server/http';
import { claimHandoff } from '@/server/move';

export const POST = handle(claimHandoff);
