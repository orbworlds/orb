// GET /.well-known/webauthn — Related Origin Requests: the addresses allowed to use passkeys bound to
// Orb's RP ID (src/server/origins.ts). Browsers fetch it from https://<ORB_PASSKEY_RP_ID>, so the
// former addresses never redirect it (next.config.ts).
import { relatedOrigins } from '@/server/origins';

export function GET(): Response {
  return new Response(JSON.stringify(relatedOrigins()), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' },
  });
}
