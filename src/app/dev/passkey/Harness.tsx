'use client';
// Client side of the /dev/passkey harness. Tests drive it through window.__orbPasskey.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { api, deviceHeaders } from '@/lib/api';
import { getDeviceKey, getDisplayName } from '@/lib/local';
import { passkeysSupported, signIn, signUp } from '@/lib/passkey';
import type { MeResponse } from '@/lib/types';

/** Server view of the current request (see ./state/route.ts). */
interface SessionSnapshot {
  user: { id: string; name: string } | null;
  worlds: Array<{ id: string; name: string }>;
  passkeys: number;
  /** User this device is linked to in orb_devices (null after logout). */
  deviceUser: string | null;
}

interface PasskeyHarnessApi {
  supported(): boolean;
  deviceKey(): string;
  signUp(name: string): Promise<MeResponse>;
  signIn(): Promise<MeResponse>;
  logout(): Promise<{ ok: true }>;
  /** Create a world owned anonymously by this device; returns its id. */
  seedWorld(name: string): Promise<string>;
  session(): Promise<SessionSnapshot>;
}

declare global {
  interface Window {
    __orbPasskey?: PasskeyHarnessApi;
  }
}

async function fetchSession(): Promise<SessionSnapshot> {
  const res = await fetch('/dev/passkey/state', { headers: deviceHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`state ${res.status}`);
  return res.json();
}

async function seedWorld(name: string): Promise<string> {
  const res = await fetch('/dev/passkey/state', { method: 'POST', headers: deviceHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ name }) });
  if (!res.ok) throw new Error(`seed ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

const noSubscribe = () => () => {};

export default function Harness() {
  const nameRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState('');
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  // null during SSR, then the real answer in the browser (no hydration mismatch).
  const supported = useSyncExternalStore<boolean | null>(noSubscribe, passkeysSupported, () => null);

  const refresh = useCallback(() => fetchSession().then(setSession, (e) => setStatus(String(e))), []);

  useEffect(() => {
    if (nameRef.current && !nameRef.current.value) nameRef.current.value = getDisplayName();
    void refresh();
    window.__orbPasskey = { supported: passkeysSupported, deviceKey: getDeviceKey, signUp, signIn, logout: api.logout, seedWorld, session: fetchSession };
  }, [refresh]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setStatus(`${label}…`);
    try {
      const res = await fn();
      setStatus(`${label}: ${JSON.stringify(res)}`);
    } catch (e) {
      setStatus(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    void refresh();
  }

  return (
    <main style={{ maxWidth: 560, margin: '40px auto', padding: 16, fontFamily: 'var(--font-geist-sans), system-ui', lineHeight: 1.5 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600 }}>Account harness</h1>
      <p style={{ opacity: 0.6 }}>Passkeys supported: {supported === null ? '…' : supported ? 'yes' : 'no'}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '16px 0' }}>
        <input ref={nameRef} defaultValue="" aria-label="Name" style={{ flex: '1 1 200px', padding: '8px 12px', border: '1px solid #ccc', borderRadius: 999 }} />
        <button onClick={() => run('Sign up', () => signUp(nameRef.current?.value ?? ''))} style={btn}>Sign up</button>
        <button onClick={() => run('Sign in', signIn)} style={btn}>Sign in</button>
        <button onClick={() => run('Log out', api.logout)} style={btn}>Log out</button>
        <button onClick={() => run('Seed world', () => seedWorld('Harness world'))} style={btn}>Seed anonymous world</button>
      </div>
      <p id="status" style={{ minHeight: 24, fontSize: 14, overflowWrap: 'anywhere' }}>{status}</p>
      <pre id="session" style={{ background: 'rgba(127,127,127,.12)', padding: 12, borderRadius: 12, fontSize: 13, whiteSpace: 'pre-wrap' }}>
        {session ? JSON.stringify(session, null, 2) : '…'}
      </pre>
    </main>
  );
}

const btn: CSSProperties = { padding: '8px 14px', borderRadius: 999, border: '1px solid #ccc', background: 'transparent', cursor: 'pointer' };
