// Addresses around Stripe checkouts and payout setup: where people come back to, and Orb's webhook.

import { SITE } from '@/lib/site';

/** A page of this site to come back to (a path; anything else is the start page), without the billing note. */
export function returnTo(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || s.length > 400 || /[\s\u0000-\u001f]/.test(s)) return '/';
  const u = new URL(s, 'https://orb.invalid');
  u.searchParams.delete('billing');
  return `${u.pathname}${u.search}`;
}

/** Back to the page in `?to=` (see returnTo) after Stripe, with ?billing=<note> for the page to say how it went. */
export function backWith(req: Request, note: string): Response {
  const url = new URL(req.url);
  const to = new URL(returnTo(url.searchParams.get('to')), url.origin);
  to.searchParams.set('billing', note);
  return new Response(null, { status: 303, headers: { location: `${to.pathname}${to.search}`, 'cache-control': 'no-store' } });
}

/** Where Stripe's payout onboarding sends people: a fresh link when it expired, and back once done. */
export const payoutUrls = (origin: string, to: string) => ({
  refresh: `${origin}/api/billing/payouts/setup?to=${encodeURIComponent(to)}`,
  back: `${origin}/api/billing/payouts/return?to=${encodeURIComponent(to)}`,
});

/**
 * Where Stripe should send its events: ORB_STRIPE_WEBHOOK_URL, else the site's own address, and
 * only from the production deployment (a preview must not take the webhook over).
 */
export function webhookUrl(): string | null {
  const set = (process.env.ORB_STRIPE_WEBHOOK_URL ?? '').trim();
  if (set) return set;
  return process.env.VERCEL_ENV === 'production' ? `${SITE}/api/billing/webhook` : null;
}
