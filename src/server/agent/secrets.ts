// Bring-your-own keys for server-side agent jobs: a job that runs for hours or days without a
// browser needs the person's key on the server, so it is kept encrypted (AES-256-GCM, key derived
// from ORB_SECRET) in the job row only while the job runs, and wiped when it ends.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { sameString, secret } from '../auth';

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

/**
 * A job's tokens: 'tick' lets Orb's own tick requests run it (an outsider can't drive the runner),
 * 'files' is its files link for a Cursor agent (./sync.ts).
 */
export function jobToken(purpose: 'tick' | 'files', id: string): string {
  return createHmac('sha256', secret()).update(`orb-agent-${purpose}:${id}`).digest('base64url');
}

export function checkJobToken(purpose: 'tick' | 'files', id: string, token: string | null): boolean {
  return !!token && sameString(jobToken(purpose, id), token);
}
