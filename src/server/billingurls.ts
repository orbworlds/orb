// Addresses around Stripe checkouts: where people come back to, and Orb's webhook.

import { SITE } from '@/lib/site';

/** A page of this site to come back to (a path; anything else is the start page), without the billing note. */
export function returnTo(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || s.length > 400 || /[\s\u0000-\u001f]/.test(s)) return '/';
  const u = new URL(s, 'https://orb.invalid');
  u.searchParams.delete('billing');
  return `${u.pathname}${u.search}`;
}

/**
 * Where Stripe should send its events: ORB_STRIPE_WEBHOOK_URL, else the site's own address, and
 * only from the production deployment (a preview must not take the webhook over).
 */
export function webhookUrl(): string | null {
  const set = (process.env.ORB_STRIPE_WEBHOOK_URL ?? '').trim();
  if (set) return set;
  return process.env.VERCEL_ENV === 'production' ? `${SITE}/api/billing/webhook` : null;
}
