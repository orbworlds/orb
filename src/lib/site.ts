/** Orb's first address. */
export const DEFAULT_SITE = 'https://orbworld.vercel.app';

/** Orb's public address (links in metadata, the sitemap and robots.txt). */
export const SITE = (process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_SITE).replace(/\/+$/, '');

/**
 * Orb's source on GitHub, linked from the home page's footer. Null while the repository is private:
 * set it to 'https://github.com/orbworlds/orb' once it's public.
 */
export const GITHUB_URL: string | null = null;
