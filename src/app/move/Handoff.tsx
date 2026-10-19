'use client';
// The hand-off card (./page.tsx). On a former address it sends this browser's things over; on the
// new one it picks them up and takes them in; at the passkey home it makes the passkey that the
// browser couldn't make where it was, then hands the session back. src/server/move.ts has the
// whole journey.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { OrbSphere } from '@/components/orb/Orb';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { setChatSync } from '@/lib/chatsync';
import { MAX_BUNDLE, mergeEntries, packWithin, unpack, type Entries } from '@/lib/move';
import { ceremonyHere, isCancelled } from '@/lib/passkey';

export interface HandoffProps {
  step: 'send' | 'passkey' | 'claim' | 'start';
  /** Where Orb lives now. */
  site: string;
  /** send, passkey: the address this hand-off ends at. */
  back: string;
  /** Where to land, a path on the site. */
  to: string;
  /** passkey: what to do here. */
  kind: 'signin' | 'signup';
  /** passkey, signup: the new account's name. */
  name: string;
  /** claim: the former address's host, to start over from. */
  from: string;
  /** claim: back from making a passkey at the passkey home. */
  signingIn: boolean;
  /** claim: a few things were too big to bring. */
  dropped: boolean;
}

declare global {
  interface Window {
    /** Dev only: a smaller limit for what a browser brings along (scripts/test-move.mjs). */
    __orbMoveMaxBytes?: number;
  }
}

type View = 'busy' | 'passkey' | 'arrived' | 'failed';

const DEVICE = 'orb:device';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readEntries(): Entries {
  const s = storage();
  const out: Entries = {};
  for (let i = 0; s && i < s.length; i++) {
    const key = s.key(i);
    const value = key?.startsWith('orb:') ? s.getItem(key) : null;
    if (key && value !== null) out[key] = value;
  }
  return out;
}

/** Smallest first, so a nearly full storage keeps what matters most. False if something didn't fit. */
function writeEntries({ set, remove }: { set: Entries; remove: string[] }): boolean {
  const s = storage();
  if (!s) return false;
  let fits = true;
  for (const key of remove) s.removeItem(key);
  for (const [key, value] of Object.entries(set).sort((a, b) => a[1].length - b[1].length)) {
    try {
      s.setItem(key, value);
    } catch {
      fits = false;
    }
  }
  return fits;
}

const query = (name: string) => new URLSearchParams(location.search).get(name) ?? '';
const go = (url: string) => location.replace(url + location.hash);
/** A fresh hand-off from the former address `host` to `target`, landing on `to`. */
const startOver = (target: string, host: string, to: string) => `${target}/api/move/start/${encodeURIComponent(host)}${to.replace(/^\/(?=\?|$)/, '')}`;

/** A prerendered page waits until it's shown: hand-offs are single-use. */
function shown(): Promise<void> {
  if (!(document as Document & { prerendering?: boolean }).prerendering) return Promise.resolve();
  return new Promise((resolve) => document.addEventListener('prerenderingchange', () => resolve(), { once: true }));
}

async function post(path: string, headers: Record<string, string>, body?: BodyInit): Promise<string> {
  const res = await fetch(path, { method: 'POST', headers, body, credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`move ${res.status}`);
  return ((await res.json()) as { url: string }).url;
}

/** On the former address: send everything over. Returns where to go next. */
async function send(back: string, to: string): Promise<string> {
  const entries = readEntries();
  const max = (process.env.NODE_ENV !== 'production' && window.__orbMoveMaxBytes) || MAX_BUNDLE;
  const packed = Object.keys(entries).length ? await packWithin(entries, max) : null;
  const headers: Record<string, string> = { 'content-type': 'application/octet-stream', 'x-orb-move': query('s'), 'x-orb-back': back, 'x-orb-to': to, 'x-orb-pack': packed?.pack ?? 'json' };
  if (entries[DEVICE]) headers['x-orb-device'] = entries[DEVICE];
  if (packed?.dropped.length) headers['x-orb-dropped'] = '1';
  return post('/api/move', headers, packed?.body);
}

/** At the passkey home, signed in: send the session back. Returns where to go next. */
function handBack(back: string, to: string): Promise<string> {
  return post('/api/move', { 'x-orb-passkey': '1', 'x-orb-move': query('s'), 'x-orb-back': back, 'x-orb-to': to });
}

/** On the new address: pick up what was sent and take it in. False if some of it didn't fit. */
async function claim(to: string): Promise<boolean> {
  const headers: Record<string, string> = { 'x-orb-move-code': query('code') };
  const device = storage()?.getItem(DEVICE);
  if (device) headers['x-orb-device'] = device;
  const res = await fetch('/api/move/claim', { method: 'POST', headers, credentials: 'same-origin', cache: 'no-store' });
  // The code is spent: reloading from here just lands.
  history.replaceState(null, '', `/move?to=${encodeURIComponent(to)}${location.hash}`);
  if (!res.ok) throw new Error(`claim ${res.status}`);
  const format = res.headers.get('x-orb-pack');
  if (!format || format === 'none') return true;
  return writeEntries(mergeEntries(readEntries(), await unpack(await res.arrayBuffer(), format)));
}

export default function Handoff(p: HandoffProps) {
  const [view, setView] = useState<View>(p.step === 'passkey' ? 'passkey' : 'busy');
  const [waiting, setWaiting] = useState(p.step === 'passkey');
  const [problem, setProblem] = useState('');
  const started = useRef(false);

  async function makePasskey() {
    setWaiting(true);
    setProblem('');
    try {
      await ceremonyHere(p.kind, p.name);
    } catch (e) {
      setWaiting(false);
      if (!isCancelled(e)) setProblem(e instanceof Error ? e.message : "Couldn't use your passkey. Please try again.");
      return;
    }
    setView('busy');
    handBack(p.back, p.to).then(go, () => setView('failed'));
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void shown().then(async () => {
      if (p.step === 'start') return go(p.to);
      // Browsers that need a tap first (Safari) show the button instead.
      if (p.step === 'passkey') return makePasskey();
      if (p.step === 'send') return send(p.back, p.to).then(go, () => setView('failed'));
      try {
        const fits = await claim(p.to);
        if (p.signingIn) await Promise.race([setChatSync(true, { uploadAll: true }), new Promise((r) => setTimeout(r, 5000))]);
        if (fits && !p.dropped) go(p.to);
        else setView('arrived');
      } catch {
        setView('failed');
      }
    });
  });

  const signingIn = p.signingIn || p.step === 'passkey';
  const canRetry = !signingIn && (p.step === 'send' || (p.step === 'claim' && !!p.from));
  const retry = () => go(p.step === 'send' ? startOver(p.back, location.host, p.to) : startOver(location.origin, p.from, p.to));
  const onward = p.step === 'claim' ? p.to : new URL(p.to, p.back).toString();

  let title: string;
  let text = '';
  let actions: ReactNode = null;
  if (view === 'passkey') {
    title = p.kind === 'signup' ? 'Create your passkey' : 'Sign in with your passkey';
    text = problem || 'You’ll be right back where you were.';
    actions = (
      <div className="mt-5 flex flex-col items-center gap-1">
        <Button variant="primary" onClick={makePasskey} disabled={waiting}>
          {waiting ? <Spinner size={15} /> : <Icon name="key" size={16} />}
          {waiting ? 'Waiting for your device…' : p.kind === 'signup' ? 'Create passkey' : 'Use passkey'}
        </Button>
        <Button variant="ghost" onClick={() => go(onward)}>
          Go back
        </Button>
      </div>
    );
  } else if (view === 'arrived') {
    title = 'You’re all moved in';
    text = 'A few very large chats or saved games couldn’t come along.';
    actions = (
      <div className="mt-5 flex justify-center">
        <Button variant="primary" onClick={() => go(p.to)}>
          Continue
        </Button>
      </div>
    );
  } else if (view === 'failed') {
    title = 'That didn’t quite work';
    text = signingIn ? 'We couldn’t sign you in just now.' : 'We couldn’t bring your things over just now.';
    actions = (
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {canRetry && (
          <Button variant="primary" onClick={retry}>
            Try again
          </Button>
        )}
        <Button variant={canRetry ? 'ghost' : 'primary'} onClick={() => go(onward)}>
          Continue to Orb
        </Button>
      </div>
    );
  } else {
    title = signingIn ? 'Signing you in…' : p.step === 'start' ? 'One moment…' : 'Taking you to Orb’s new home…';
  }

  return (
    <main className="sky fixed inset-0 flex items-center justify-center p-6">
      <div
        className={`glass-strong w-full max-w-[340px] rounded-[var(--r-panel)] px-7 pt-8 pb-7 text-center ${p.step === 'claim' ? '' : 'animate-fade-up'}`}
        style={p.step === 'claim' ? undefined : { animationDelay: '120ms' }}
      >
        <OrbSphere size={56} building={view === 'busy'} />
        <div aria-live="polite">
          <h1 className="font-display mt-5 text-[26px] leading-[1.15] text-balance">{title}</h1>
          {text && <p className={`mt-2 text-[14px] leading-snug ${view === 'passkey' && problem ? 'text-[var(--bad)]' : 'text-ink-2'}`}>{text}</p>}
        </div>
        {actions}
      </div>
    </main>
  );
}
