// Bring-your-own keys for server-side agent jobs: a job that runs for hours or days without a
// browser needs the person's key on the server, so it is kept encrypted (AES-256-GCM, key derived
// from ORB_SECRET) in the job row only while the job runs, and wiped when it ends.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { secret } from '../auth';

const key = () => createHash('sha256').update(`orb-agent-key:${secret()}`).digest();

export function sealKey(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function openKey(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  try {
    const [iv, tag, body] = sealed.split('.').map((s) => Buffer.from(s, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Token that lets Orb's own tick requests run a job (an outsider can't drive the runner). */
export function tickToken(id: string): string {
  return createHmac('sha256', secret()).update(`orb-agent-tick:${id}`).digest('base64url');
}

export function checkTickToken(id: string, token: string | null): boolean {
  if (!token) return false;
  const a = Buffer.from(tickToken(id));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
