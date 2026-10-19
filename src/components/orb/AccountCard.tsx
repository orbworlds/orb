'use client';
// Account status + sign-up / sign-in with a username and password (and passkeys, for the accounts
// made with one), and the small shared session store (`useSession`) that YouView and ShareSheet
// read so signing in anywhere updates both.

import { setChatSync } from '@/lib/chatsync';
import { useEffect, useId, useRef, useState } from 'react';
import { create } from 'zustand';
import { track } from '@/lib/analytics';
import { api, ApiError } from '@/lib/api';
import { getDisplayName, newDisplayName, setDisplayName, setPlayerColor } from '@/lib/local';
import { passkeysSupported, signIn as passkeySignIn } from '@/lib/passkey';
import type { ApiConfig, MeResponse } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { toast } from '@/state/toast';
import { useUi } from '@/state/ui';
import { useWorld } from '@/state/world';
import { fieldClass, groupClass, Skeleton, useHydrated } from './WorldCard';

// ---------------------------------------------------------------------------------------------
// Session store (me + config), fetched once and shared.

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface SessionState {
  me: MeResponse | null;
  meStatus: LoadStatus;
  config: ApiConfig | null;
  configStatus: LoadStatus;
  /** Fetch /api/me (deduped). `force` refetches even when already loaded. */
  loadMe(force?: boolean): Promise<MeResponse | null>;
  setMe(me: MeResponse): void;
  /** Fetch /api/config once (deduped). */
  loadConfig(): Promise<ApiConfig | null>;
}

let mePromise: Promise<MeResponse | null> | null = null;
let configPromise: Promise<ApiConfig | null> | null = null;

/** Signed in, this browser goes by the account's name and blob: on new worlds and to others in a world's room. */
function adoptAccountName(me: MeResponse | null): void {
  const look = me?.user?.look;
  if (look?.color) setPlayerColor(look.color);
  useWorld.getState().dress({ color: look?.color ?? undefined, wear: look?.wear ?? [] });
  const name = me?.user?.name?.trim();
  if (!name || getDisplayName() === name) return;
  setDisplayName(name);
  const player = useWorld.getState().me;
  if (player) useWorld.setState({ me: { ...player, name } });
}

export const useSession = create<SessionState>((set, get) => ({
  me: null,
  meStatus: 'idle',
  config: null,
  configStatus: 'idle',
  loadMe(force = false) {
    if (!force && get().meStatus === 'ready') return Promise.resolve(get().me);
    if (mePromise && !force) return mePromise;
    set({ meStatus: get().me ? 'ready' : 'loading' });
    const p = api
      .me()
      .then((me) => {
        if (mePromise === p) set({ me, meStatus: 'ready' });
        adoptAccountName(me);
        return me;
      })
      .catch(() => {
        if (mePromise === p) set({ meStatus: get().me ? 'ready' : 'error' });
        return get().me;
      })
      .finally(() => {
        if (mePromise === p) mePromise = null;
      });
    mePromise = p;
    return p;
  },
  setMe(me) {
    mePromise = null;
    set({ me, meStatus: 'ready' });
    adoptAccountName(me);
  },
  loadConfig() {
    if (get().configStatus === 'ready') return Promise.resolve(get().config);
    if (configPromise) return configPromise;
    set({ configStatus: 'loading' });
    configPromise = api
      .config()
      .then((config) => {
        set({ config, configStatus: 'ready' });
        return config;
      })
      .catch(() => {
        set({ configStatus: 'error' });
        configPromise = null;
        return null;
      });
    return configPromise;
  },
}));

/** Current session (loads /api/me on first use). */
export function useMe() {
  const me = useSession((s) => s.me);
  const status = useSession((s) => s.meStatus);
  useEffect(() => {
    void useSession.getState().loadMe();
  }, []);
  return { me, status, signedIn: !!me?.user };
}

/** Server config (loads /api/config on first use). `null` while loading or when unavailable. */
export function useConfig() {
  const config = useSession((s) => s.config);
  const status = useSession((s) => s.configStatus);
  useEffect(() => {
    void useSession.getState().loadConfig();
  }, []);
  return { config, status };
}

/**
 * Whether passkey accounts can be offered here: the browser supports WebAuthn and the server
 * hasn't disabled them (an unreachable /api/config doesn't hide them).
 */
export function usePasskeysAvailable(): boolean {
  const hydrated = useHydrated();
  const { config } = useConfig();
  return hydrated && passkeysSupported() && config?.passkeys !== false;
}

// ---------------------------------------------------------------------------------------------
// Errors

function passkeyErrorMessage(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  // WebAuthn: the user dismissed the prompt or it timed out.
  if (name === 'NotAllowedError' || name === 'AbortError') return 'No problem — try again whenever you’re ready.';
  return 'Couldn’t sign you in with a passkey. Try your username and password.';
}

/** The server's words for what went wrong (a taken username, a wrong password…), or a fallback. */
function accountErrorMessage(e: unknown, action: 'signup' | 'signin' | 'password'): string {
  if (e instanceof ApiError && e.status < 500 && e.message) return e.message;
  if (action === 'signin') return 'Couldn’t sign you in. Please try again.';
  if (action === 'password') return 'Couldn’t save your password. Please try again.';
  return 'Couldn’t create your account. Please try again.';
}

/** The handle a username becomes in world URLs ("Max Builds" → "max-builds", as the server makes it). */
function handleFor(username: string): string {
  return username
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

// ---------------------------------------------------------------------------------------------
// AccountCard

type Step = 'status' | 'signup' | 'signin';
type Busy = null | 'signup' | 'signin' | 'passkey' | 'password' | 'signout';

/** The last `useUi().signupSeq` a panel card answered. */
let handledSignupSeq = 0;

const labelClass = 'mb-1.5 block px-0.5 text-[13px] font-medium text-ink-2';
const hintClass = 'mt-1.5 px-0.5 text-[12px] leading-snug text-ink-3';

/**
 * Account status with sign-up and sign-in by username and password. Passkeys still sign in the
 * accounts made with one, and such an account can add a password here to sign in anywhere.
 * - `variant="panel"` (You tab): status card; "Create account" / "Sign in" expand a small form.
 * - `variant="inline"` (Share sheet, the save nudge): starts at the sign-up form with a `reason`
 *   headline, for flows that need an account (e.g. making a world private). `onCancel` shows a
 *   "Not now" button. `where` names the place in analytics.
 */
export function AccountCard({
  variant = 'panel',
  where = variant === 'inline' ? 'share' : 'you',
  reason,
  onSignedIn,
  onCancel,
}: {
  variant?: 'panel' | 'inline';
  where?: string;
  reason?: string;
  onSignedIn?(me: MeResponse): void;
  onCancel?(): void;
}) {
  const hydrated = useHydrated();
  const { me, status, signedIn } = useMe();
  const passkeys = usePasskeysAvailable();
  const setMe = useSession((s) => s.setMe);
  const loadMe = useSession((s) => s.loadMe);
  const [step, setStep] = useState<Step>(variant === 'inline' ? 'signup' : 'status');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const userId = useId();
  const passId = useId();

  useEffect(() => {
    if (step !== 'status' && variant === 'panel') userRef.current?.focus();
  }, [step, variant]);

  // Asked from elsewhere (e.g. adding friends while signed out), maybe before this card mounted:
  // open the sign-up form here.
  const signupSeq = useUi((s) => s.signupSeq);
  useEffect(() => {
    if (variant !== 'panel' || signupSeq <= handledSignupSeq) return;
    handledSignupSeq = signupSeq;
    setStep('signup');
    setError(null);
  }, [signupSeq, variant]);

  const go = (next: Step) => {
    setStep(next);
    setError(null);
    setPassword('');
  };

  const finish = (next: MeResponse, verb: string, method: 'password' | 'passkey') => {
    setMe(next);
    setStep('status');
    setError(null);
    setPassword('');
    // The passkey ceremony turns chat sync on itself.
    if (method === 'password') void setChatSync(true, { uploadAll: true });
    toast(`${verb}, ${next.user?.name || next.name}`, 'success');
    // This device's worlds are the account's now: the one on screen has a new address and maker.
    void useWorld.getState().refresh();
    onSignedIn?.(next);
  };

  const submit = async (action: 'signup' | 'signin') => {
    if (!username.trim()) {
      userRef.current?.focus();
      return;
    }
    setBusy(action);
    setError(null);
    try {
      const next = action === 'signup' ? await api.signUp(username, password) : await api.signIn(username, password);
      finish(next, action === 'signup' ? 'Welcome' : 'Welcome back', 'password');
      track(action === 'signup' ? 'sign_up' : 'sign_in', { where, method: 'password' });
    } catch (e) {
      setError(accountErrorMessage(e, action));
    } finally {
      setBusy(null);
    }
  };

  const withPasskey = async () => {
    setBusy('passkey');
    setError(null);
    try {
      finish(await passkeySignIn(), 'Welcome back', 'passkey');
      track('sign_in', { where, method: 'passkey' });
    } catch (e) {
      console.warn('[orb] passkey sign-in failed', e);
      setError(passkeyErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const savePassword = async () => {
    setBusy('password');
    setError(null);
    try {
      setMe(await api.setPassword(password));
      setPassword('');
      toast('Password saved — now you can sign in anywhere', 'success');
    } catch (e) {
      setError(accountErrorMessage(e, 'password'));
    } finally {
      setBusy(null);
    }
  };

  const doSignOut = async () => {
    setBusy('signout');
    try {
      await api.logout();
      track('sign_out');
      void setChatSync(false);
      // A guest again: a new guest name (the next person here isn't shown as the account), and the
      // account's world on screen may no longer be this device's to change.
      newDisplayName();
      await loadMe(true);
      void useWorld.getState().refresh();
      toast('Signed out');
    } catch {
      toast('Couldn’t sign out. Try again.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const shell = variant === 'panel' ? `${groupClass} p-4` : '';
  const errorLine = error && (
    <p role="alert" className="mt-2 px-0.5 text-[12.5px] text-[var(--bad)]">
      {error}
    </p>
  );

  if (!hydrated || (status === 'loading' && !me)) {
    return (
      <div className={shell} aria-busy="true">
        <Skeleton className="h-3.5 w-2/3 rounded-full" />
        <Skeleton className="mt-2.5 h-3 w-1/2 rounded-full" />
      </div>
    );
  }

  // Signed in ---------------------------------------------------------------------------------
  if (signedIn) {
    const user = me!.user!;
    return (
      <div className={shell}>
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--ok)_14%,transparent)] text-[var(--ok)]">
            <Icon name="key" size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-medium text-ink">{user.name}</div>
            <div className="truncate text-[12.5px] text-ink-2">{user.handle ? `Signed in as ${user.handle}` : 'Signed in'}</div>
          </div>
          {variant === 'panel' && (
            <Button variant="ghost" size="sm" icon="logout" onClick={doSignOut} disabled={busy === 'signout'} className="-mr-1.5">
              Sign out
            </Button>
          )}
        </div>
        {variant === 'panel' && user.password === false && (
          <form
            className="mt-3.5 pl-12"
            onSubmit={(e) => {
              e.preventDefault();
              void savePassword();
            }}
          >
            <input type="text" hidden readOnly autoComplete="username" value={user.handle ?? ''} />
            <label htmlFor={passId} className={labelClass}>
              Add a password to sign in anywhere
            </label>
            <div className="flex gap-2">
              <input
                id={passId}
                type="password"
                className={fieldClass}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
                disabled={!!busy}
              />
              <Button type="submit" variant="primary" size="sm" disabled={!!busy || password.length < 8} className="h-10 shrink-0">
                {busy === 'password' && <Spinner size={14} />}
                Save
              </Button>
            </div>
            <p className={hintClass}>{user.handle ? `Then sign in with the username ${user.handle}. Your passkey keeps working too.` : 'Your passkey keeps working too.'}</p>
            {errorLine}
          </form>
        )}
      </div>
    );
  }

  // Sign up / sign in ---------------------------------------------------------------------------
  if (step !== 'status') {
    const signup = step === 'signup';
    const handle = handleFor(username);
    return (
      <form
        className={`${shell} ${variant === 'panel' ? 'animate-fade-up' : ''}`}
        onSubmit={(e) => {
          e.preventDefault();
          void submit(step);
        }}
      >
        {variant === 'inline' && (
          <div className="mb-3">
            <div className="text-[14px] font-medium text-ink">{signup ? reason || 'Create your account' : 'Sign in'}</div>
            <p className="mt-0.5 text-[13px] leading-snug text-ink-2">{signup ? 'Pick a username and a password. Your worlds on this device come with you.' : 'Your worlds on this device come with you.'}</p>
          </div>
        )}
        <label htmlFor={userId} className={labelClass}>
          Username
        </label>
        <input
          ref={userRef}
          id={userId}
          className={fieldClass}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={signup ? 'e.g. star-builder' : 'Your username'}
          maxLength={40}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
          disabled={!!busy}
        />
        {signup && (
          <p className={`${hintClass} truncate`}>
            {handle.length >= 3 ? (
              <>
                Your worlds will be at {window.location.host}/<span className="font-medium text-ink-2">{handle}</span>/…
              </>
            ) : (
              '3 to 24 letters, numbers or dashes.'
            )}
          </p>
        )}
        <label htmlFor={passId} className={`${labelClass} mt-3`}>
          Password
        </label>
        <input
          id={passId}
          type="password"
          className={fieldClass}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={signup ? 'At least 8 characters' : undefined}
          autoComplete={signup ? 'new-password' : 'current-password'}
          enterKeyHint="go"
          disabled={!!busy}
        />
        {signup && <p className={hintClass}>There’s no email to reset it with, so keep it somewhere safe.</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" size="sm" disabled={!!busy} className="min-w-0">
            {busy === step && <Spinner size={14} />}
            {signup ? 'Create account' : 'Sign in'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => go(signup ? 'signin' : 'signup')} disabled={!!busy}>
            {signup ? 'Sign in' : 'Create account'}
          </Button>
          {variant === 'panel' ? (
            <Button variant="ghost" size="sm" onClick={() => go('status')} disabled={!!busy} className="ml-auto">
              Cancel
            </Button>
          ) : (
            onCancel && (
              <Button variant="ghost" size="sm" onClick={onCancel} disabled={!!busy} className="ml-auto">
                Not now
              </Button>
            )
          )}
        </div>
        {!signup && passkeys && (
          <button type="button" onClick={withPasskey} disabled={!!busy} className="mt-2.5 flex items-center gap-1.5 px-0.5 text-[12.5px] text-ink-2 transition-colors hover:text-ink disabled:opacity-50">
            {busy === 'passkey' ? <Spinner size={12} /> : <Icon name="key" size={13} />}
            Sign in with a passkey instead
          </button>
        )}
        {errorLine}
      </form>
    );
  }

  // Signed out ----------------------------------------------------------------------------------
  return (
    <div className={shell}>
      <div className="flex gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--field-bg)] text-ink-2">
          <Icon name="user" size={17} />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">Not signed in</div>
          <p className="text-[13px] leading-snug text-ink-2">Your worlds are saved to this device.</p>
        </div>
      </div>
      <div className="mt-3.5 flex flex-wrap gap-2 pl-12">
        <Button variant="primary" size="sm" onClick={() => go('signup')}>
          Create account
        </Button>
        <Button variant="ghost" size="sm" onClick={() => go('signin')}>
          Sign in
        </Button>
      </div>
    </div>
  );
}
