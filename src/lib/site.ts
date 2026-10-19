/** Orb's first address. */
export const DEFAULT_SITE = 'https://orbworld.vercel.app';

/** Orb's public address (links in metadata, the sitemap and robots.txt). */
export const SITE = (process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_SITE).replace(/\/+$/, '');

/** Orb on GitHub (the org: Orb and its games), linked from the home page's footer. */
export const GITHUB_URL = 'https://github.com/orbworlds';
