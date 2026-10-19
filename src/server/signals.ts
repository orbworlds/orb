// AbortSignal.any() holds the signals it combines weakly: an AbortSignal.timeout() that nothing else
// holds can be garbage-collected before it fires (Node 22), and then nothing times out — a stream
// meant to stop at a deadline runs on. Here a timer holds the deadline.

/** `signal`, or `ms` passing (a TimeoutError), whichever comes first. */
export function withDeadline(signal: AbortSignal, ms: number): AbortSignal {
  const deadline = new AbortController();
  setTimeout(() => deadline.abort(new DOMException('The operation timed out.', 'TimeoutError')), Math.max(0, ms)).unref?.();
  return AbortSignal.any([signal, deadline.signal]);
}
