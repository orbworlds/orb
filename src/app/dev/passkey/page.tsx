// Dev-only harness for passkey accounts (src/lib/passkey.ts + /api/auth/*). Used manually and by
// scripts/test-passkeys.mjs. Server state comes from the dev-only ./state route.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Harness from './Harness';

export const metadata: Metadata = { title: 'Account harness', robots: { index: false, follow: false } };

export default function DevPasskeyPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <Harness />;
}
