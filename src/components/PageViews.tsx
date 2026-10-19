'use client';
// Page views, twice: Vercel Web Analytics (no cookies, no query strings or fragments — prompts and
// sign-in tokens ride there — and never the secret pages), and the first page view of each page
// load for Orb's own analytics (src/lib/analytics.ts; later ones come from in-app navigations).
import { Analytics, type BeforeSendEvent } from '@vercel/analytics/next';
import { useEffect } from 'react';
import { trackPageView } from '@/lib/analytics';

function beforeSend(event: BeforeSendEvent): BeforeSendEvent | null {
  const url = new URL(event.url);
  if (url.pathname.startsWith('/lab/')) return null;
  url.search = '';
  url.hash = '';
  return { ...event, url: url.toString() };
}

export function PageViews() {
  useEffect(() => trackPageView(), []);
  return <Analytics beforeSend={beforeSend} />;
}
