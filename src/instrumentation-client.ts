// Runs before the app hydrates, so crashes during the first render are reported too.
import { initBotId } from 'botid/client/core';
import { reportError } from '@/lib/report';

try {
  window.addEventListener('error', (e) => reportError(e.error ?? e.message, { where: e.filename ? `at ${e.filename}:${e.lineno}:${e.colno}` : '', ownCode: true }));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason, { ownCode: true }));
} catch {
  // Reporting must never break the page.
}

// The requests src/server/botid.ts checks for bots: they carry BotID's proof that a person's browser sent them.
try {
  if (process.env.ORB_BOTID) {
    initBotId({
      protect: [
        { path: '/api/agent/jobs', method: 'POST' },
        { path: '/api/auth/signup', method: 'POST' },
        { path: '/api/auth/signin', method: 'POST' },
        { path: '/api/auth/passkey/register/options', method: 'POST' },
      ],
    });
  }
} catch (e) {
  reportError(e, { ownCode: true });
}
