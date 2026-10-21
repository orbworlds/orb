'use client';
import { setChatSync } from './chatsync';
// Passkey sign-up / sign-in from the browser (Face ID, Touch ID, Windows Hello, security keys…).
// Server side: src/server/passkeys.ts. Passkeys are discoverable, so signing in needs no username.
//
// Errors are thrown as `Error`s with short, friendly messages that can be shown as-is. When the
// user dismisses the system prompt the message is exactly 'cancelled' (see `isCancelled`) so the
// UI can stay quiet.
//
// Every Orb address shares one passkey RP ID (src/server/origins.ts). Where this address needs the
// browser's Related Origin Requests to use it and the browser can't, the ceremony happens at Orb's
// passkey home instead: a full-page round trip through /move that comes back signed in (the
// promise never settles, the page is leaving).

import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { ApiError, deviceHeaders } from './api';
import type { MeResponse } from './types';

const CANCELLED = 'cancelled';

type Kind = 'signup' | 'signin';

/** True if this browser can do WebAuthn at all (passkeys may still be unavailable on the device). */
export function passkeysSupported(): boolean {
  try {
    return typeof window !== 'undefined' && window.isSecureContext !== false && browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** Whether an error thrown by signUp/signIn means the user simply dismissed the prompt. */
export function isCancelled(e: unknown): boolean {
  return e instanceof Error && e.message === CANCELLED;
}

/** Create an account named `name` with a new passkey on this device. Signs in and claims this device's worlds. */
export async function signUp(name: string): Promise<MeResponse> {
  const clean = name.replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('Please choose a name first.');
  return ceremony('signup', clean, true);
}

/** Sign in with any Orb passkey available on this device (or a nearby phone). */
export async function signIn(): Promise<MeResponse> {
  return ceremony('signin', '', true);
}

/**
 * The ceremony alone, for the /move page at the passkey home: no device key (the browser that
 * asked links its own when the session gets back to it) and no chat sync here.
 */
export async function ceremonyHere(kind: Kind, name: string): Promise<MeResponse> {
  return ceremony(kind, name, false);
}

// ---------------------------------------------------------------------------------------------

type WithHome<T> = T & { home?: string };

async function ceremony(kind: Kind, name: string, ownDevice: boolean): Promise<MeResponse> {
  assertSupported();
  const signup = kind === 'signup';
  const capabilities = clientCapabilities();
  const optionsJSON = signup
    ? await post<WithHome<PublicKeyCredentialCreationOptionsJSON>>('/api/auth/passkey/register/options', { name }, ownDevice)
    : await post<WithHome<PublicKeyCredentialRequestOptionsJSON>>('/api/auth/passkey/login/options', {}, ownDevice);
  const home = ownDevice ? optionsJSON.home : undefined;
  if (home && (await capabilities)?.relatedOrigins === false) return viaHome(kind, name);
  let response;
  try {
    response = signup
      ? await startRegistration({ optionsJSON: optionsJSON as PublicKeyCredentialCreationOptionsJSON })
      : await startAuthentication({ optionsJSON: optionsJSON as PublicKeyCredentialRequestOptionsJSON });
  } catch (e) {
    if (home && wrongAddress(e)) return viaHome(kind, name);
    throw friendlyCeremonyError(e, kind);
  }
  const me = await post<MeResponse>(signup ? '/api/auth/passkey/register/verify' : '/api/auth/passkey/login/verify', response, ownDevice);
  if (ownDevice) void setChatSync(true, { uploadAll: true });
  return me;
}

/** The browser's WebAuthn capabilities where it can tell (relatedOrigins among them), else null. */
function clientCapabilities(): Promise<Record<string, boolean> | null> {
  const pkc = typeof PublicKeyCredential === 'undefined' ? undefined : (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> });
  if (!pkc?.getClientCapabilities) return Promise.resolve(null);
  return pkc.getClientCapabilities().catch(() => null);
}

/** The browser refused Orb's RP ID on this address (no Related Origin Requests). */
function wrongAddress(e: unknown): boolean {
  const err = e as { name?: string; code?: string; cause?: { name?: string } } | null;
  return err?.code === 'ERROR_INVALID_RP_ID' || err?.code === 'ERROR_INVALID_DOMAIN' || (err?.cause?.name || err?.name) === 'SecurityError';
}

/** Make the passkey at Orb's passkey home and come back here signed in. */
async function viaHome(kind: Kind, name: string): Promise<never> {
  const { url } = await post<{ url: string }>('/api/move/passkey', { kind, name, to: location.pathname + location.search }, true);
  // Coming back with the Back button shows this page as it was: start it afresh instead.
  window.addEventListener('pageshow', (e) => e.persisted && location.reload());
  location.assign(url);
  return new Promise<never>(() => {});
}

function assertSupported(): void {
  if (!passkeysSupported()) throw new Error("Passkeys aren't supported in this browser. Try Safari, Chrome or Edge.");
}

async function post<T>(path: string, body: unknown, ownDevice: boolean): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: ownDevice ? deviceHeaders({ 'content-type': 'application/json' }) : { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Couldn't reach Orb. Check your connection and try again.");
  }
  if (!res.ok) {
    let data: { error?: string; message?: string; retryAfter?: number } = {};
    try {
      data = await res.json();
    } catch {}
    throw new ApiError(res.status, data.error || 'http_error', data.message || 'Something went wrong. Please try again.', data.retryAfter);
  }
  return (await res.json()) as T;
}

/** Map WebAuthn failures to short, human messages. */
function friendlyCeremonyError(e: unknown, kind: Kind): Error {
  const err = e as { name?: string; code?: string; cause?: { name?: string } } | null;
  const name = err?.cause?.name || err?.name;
  if (e instanceof WebAuthnError) {
    switch (e.code) {
      case 'ERROR_CEREMONY_ABORTED':
        return new Error(CANCELLED);
      case 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED':
        return new Error('This device already has an Orb passkey. Try signing in instead.');
      case 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT':
      case 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT':
      case 'ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG':
        return new Error("This device can't save a passkey. Try your phone or another browser.");
      case 'ERROR_INVALID_DOMAIN':
      case 'ERROR_INVALID_RP_ID':
        return new Error("Passkeys don't work on this web address.");
    }
  }
  // NotAllowedError covers "user dismissed the sheet", "timed out" and "no passkey picked".
  if (name === 'NotAllowedError' || name === 'AbortError') return new Error(CANCELLED);
  if (name === 'SecurityError') return new Error("Passkeys don't work on this web address.");
  if (name === 'NotSupportedError') return new Error("This device can't use passkeys. Try your phone or another browser.");
  return new Error(kind === 'signup' ? "Couldn't create your passkey. Please try again." : "Couldn't sign in with your passkey. Please try again.");
}
