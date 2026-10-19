// GET /api/move/start/<former host>/<path…> — a page visit to a former address, redirected here by
// next.config.ts: bring this browser's things over, then land on the path (src/server/move.ts).
import { handle } from '@/server/http';
import { startHandoff } from '@/server/move';

export const GET = handle(async (req: Request, ctx: { params: Promise<{ from: string }> }) => {
  const { from } = await ctx.params;
  return startHandoff(req, from);
});
