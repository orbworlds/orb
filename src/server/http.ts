// Small helpers for route handlers.

import { after } from 'next/server';

export function json(data: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(init.headers || {}) },
  });
}

export function error(status: number, code: string, message?: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: code, message: message ?? code, ...extra }, { status });
}

export async function readJson<T>(req: Request, maxBytes = 2_000_000): Promise<T | null> {
  try {
    const text = await req.text();
    if (text.length > maxBytes) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Who to count a request against in rate limits (Vercel sets x-real-ip): an IPv4 address, or an IPv6 /64. */
export function clientIp(req: Request): string {
  return ipBlock(req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '0.0.0.0');
}

/**
 * "2001:db8:a:b:1:2:3:4" → "2001:db8:a:b::/64": a home or phone gets a whole IPv6 /64 and can hop
 * between its addresses, so limits per address count the /64. IPv4 (also IPv4-mapped) stays as it is.
 */
export function ipBlock(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1];
  const lower = ip.toLowerCase();
  const halves = lower.split('::');
  if (!lower.includes(':') || halves.length > 2) return ip;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return ip;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** Wrap a handler so unexpected errors become a JSON 500 instead of an HTML page. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      console.error('[orb] route error', e);
      const path = args[0] instanceof Request ? new URL(args[0].url).pathname : undefined;
      try {
        after(() => import('./errors').then((m) => m.recordServerError(e, path)));
      } catch {
        // Outside a request (e.g. a handler called directly): nothing to record into.
      }
      return error(500, 'server_error', 'Something went wrong. Please try again.');
    }
  };
}
