// Any other /api path → 404. Without this, a two-part path such as /api/build reaches the world
// pages (/<maker>/<world>) and is answered with a page.

import { error } from '@/server/http';

const missing = () => error(404, 'not_found', 'No such API route.');

export const GET = missing;
export const POST = missing;
export const PUT = missing;
export const PATCH = missing;
export const DELETE = missing;
