import type { Instrumentation } from 'next';

// Server errors Next catches itself: page renders and route handlers that throw. Routes wrapped in
// handle() (src/server/http.ts) answer with a 500 and record the error there instead.
export const onRequestError: Instrumentation.onRequestError = async (err, request) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { recordServerError } = await import('./server/errors');
  await recordServerError(err, request.path.split(/[?#]/)[0]);
};
