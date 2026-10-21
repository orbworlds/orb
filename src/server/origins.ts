// Orb's web addresses and the passkey relying party (docs/operations.md "Moving to a new domain", SPEC §3).
//
//   NEXT_PUBLIC_SITE_URL  where Orb lives now.
//   ORB_FORMER_ORIGINS    where it used to live: page visits there are handed over to the site
//                         with everything the browser had (next.config.ts, src/server/move.ts).
//   ORB_ORIGINS           more addresses serving this same Orb.
//   ORB_PASSKEY_RP_ID     the hostname every passkey is bound to. It never follows the site:
//                         changing it would orphan every passkey made so far.
//
// Passkeys made on any of these addresses use that one RP ID; browsers accept it away from its
// own host through Related Origin Requests (/.well-known/webauthn on the RP ID's host lists the
// addresses). Other hosts (localhost, preview deployments) keep using their own hostname.
import { DEFAULT_SITE } from '@/lib/site';

const DEFAULT_RP_ID = 'orbworld.vercel.app';

type Env = Record<string, string | undefined>;

export interface Origins {
  /** Where Orb lives now. */
  site: string;
  former: string[];
  extra: string[];
  rpId: string;
  /**
   * The address whose own hostname is the RP ID. Browsers without Related Origin Requests make
   * their passkey ceremonies there (a full-page round trip).
   */
  home: string;
  /** Addresses whose passkeys use rpId. */
  allowed: string[];
  /** Addresses a hand-off can end at (where people stay): the site and the extra ones. */
  targets: string[];
}

/** Origins from a comma- or space-separated list; anything that isn't an http(s) URL is skipped. */
function parseOrigins(list: string | undefined): string[] {
  const out: string[] = [];
  for (const raw of (list || '').split(/[\s,]+/)) {
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && !out.includes(u.origin)) out.push(u.origin);
    } catch {
      // not a URL
    }
  }
  return out;
}

const unique = (list: string[]) => [...new Set(list)];

export function originsConfig(env: Env = process.env): Origins {
  const site = parseOrigins(env.NEXT_PUBLIC_SITE_URL)[0] ?? DEFAULT_SITE;
  // Same rule as next.config.ts: the site's own hostname is never a former address.
  const former = parseOrigins(env.ORB_FORMER_ORIGINS).filter((o) => new URL(o).hostname !== new URL(site).hostname);
  const extra = parseOrigins(env.ORB_ORIGINS).filter((o) => o !== site && !former.includes(o));
  const rpId = (env.ORB_PASSKEY_RP_ID || '').trim().toLowerCase().replace(/\.$/, '') || DEFAULT_RP_ID;
  const home = [site, ...former, ...extra].find((o) => new URL(o).hostname === rpId) ?? `https://${rpId}`;
  return {
    site,
    former,
    extra,
    rpId,
    home,
    allowed: unique([site, `https://${rpId}`, home, ...former, ...extra]),
    targets: [site, ...extra],
  };
}

/** The listed origin with this host ("example.com" or "localhost:3000"), if any. */
export function originForHost(list: string[], host: string | null | undefined): string | null {
  if (!host) return null;
  return list.find((o) => new URL(o).host === host.toLowerCase()) ?? null;
}

function firstHeaderValue(v: string | null): string | null {
  const first = v?.split(',')[0]?.trim();
  return first || null;
}

/**
 * The browser-facing origin of a request, honouring reverse-proxy headers (Vercel sets
 * x-forwarded-host / x-forwarded-proto). Shared with the GitHub OAuth routes.
 */
export function requestOrigin(req: Request): { origin: string; hostname: string } {
  const url = new URL(req.url);
  const host = firstHeaderValue(req.headers.get('x-forwarded-host')) || req.headers.get('host') || url.host;
  let proto = (firstHeaderValue(req.headers.get('x-forwarded-proto')) || url.protocol.replace(/:$/, '')).toLowerCase();
  if (proto !== 'http' && proto !== 'https') proto = 'https';
  try {
    const parsed = new URL(`${proto}://${host}`);
    return { origin: parsed.origin, hostname: parsed.hostname };
  } catch {
    return { origin: url.origin, hostname: url.hostname };
  }
}

/**
 * Relying party for WebAuthn: on Orb's own addresses the stable RP ID, elsewhere (localhost,
 * previews) the request's hostname. The expected origin is always the request's. `home` is set
 * when the browser needs Related Origin Requests to use the RP ID from this address.
 */
export function relyingParty(req: Request, o: Origins = originsConfig()): { rpID: string; origin: string; home: string | null } {
  const { origin, hostname } = requestOrigin(req);
  if (!o.allowed.includes(origin)) return { rpID: hostname, origin, home: null };
  // Subdomains may use their parent as RP ID, unless it's a single label like "localhost".
  const native = hostname === o.rpId || (o.rpId.includes('.') && hostname.endsWith(`.${o.rpId}`));
  return { rpID: o.rpId, origin, home: native ? null : o.home };
}

/** GET /.well-known/webauthn on the RP ID's host: the addresses allowed to use its passkeys. */
export function relatedOrigins(o: Origins = originsConfig()): { origins: string[] } {
  return { origins: o.allowed };
}
