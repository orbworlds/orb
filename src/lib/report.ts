// Crashes in Orb's own pages, sent to /api/errors. Worlds run in their own frames and never get
// here. Not crashes: network hiccups, aborted requests, hydration warnings (browser extensions and
// page translators cause most) and errors from code that isn't Orb's. A page sends at most 5.

const NOISE = /ResizeObserver loop|^Script error\.?$|-extension:\/\/|Failed to fetch|Load failed|NetworkError|network connection was lost|^cancelled$|ChunkLoadError|Loading chunk|Minified React error #(418|423|425)\b|Hydration failed/i;
const sent = new Set<string>();

/** URLs without their query string or fragment (prompts and sign-in tokens ride there). */
const bareUrls = (s: string) => s.replace(/(https?:\/\/[^\s?#)]*)[?#][^\s):]*/g, '$1');

function describe(error: unknown): { name: string; message: string; stack: string } {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack ?? '' };
  if (typeof Event !== 'undefined' && error instanceof Event) return { name: 'Event', message: `${error.type} event`, stack: '' };
  let message: string;
  try {
    message = typeof error === 'string' ? error : (JSON.stringify(error) ?? String(error));
  } catch {
    message = String(error);
  }
  return { name: 'Error', message: message.slice(0, 300), stack: '' };
}

/** `ownCode`: drop errors with no stack frame in Orb's own scripts (extensions, injected code). */
export function reportError(error: unknown, { where = '', ownCode = false }: { where?: string; ownCode?: boolean } = {}): void {
  if (typeof window === 'undefined') return;
  const e = describe(error);
  if (e.name === 'AbortError' || !e.message) return;
  const message = bareUrls(`${e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}`).slice(0, 500);
  const stack = bareUrls([e.stack, where].filter(Boolean).join('\n')).slice(0, 4000);
  if (ownCode && !stack.includes(location.origin)) return;
  if (NOISE.test(message) || NOISE.test(stack) || sent.has(message) || sent.size >= 5) return;
  sent.add(message);
  const body = JSON.stringify({ message, stack, path: location.pathname });
  try {
    if (navigator.sendBeacon?.('/api/errors', new Blob([body], { type: 'application/json' }))) return;
  } catch {}
  void fetch('/api/errors', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
}
