// Vercel BotID (https://vercel.com/docs/botid): an invisible check, like chatgpt.com's, that a
// request comes from a person's browser and not a script. It guards what costs Orb money or makes
// accounts — free builds, signing up and signing in — so people stay welcome without an account
// while scripts can't farm the free builder. src/instrumentation-client.ts lists the same routes
// for the browser's side; both are on only in builds made on Vercel (ORB_BOTID, next.config.ts).
//
// When the check itself fails, the request goes on: the quotas (./freetier.ts) still hold, and an
// outage at BotID must not stop everyone building.

import { checkBotId } from 'botid/server';
import { error } from './http';

/** The 403 for a request from a bot, or null. Off Vercel, ORB_BOTID_TEST=bot makes every request one (tests). */
export async function botCheck(): Promise<Response | null> {
  const test = process.env.VERCEL ? '' : (process.env.ORB_BOTID_TEST ?? '');
  if (!test && !process.env.ORB_BOTID) return null;
  let bot: boolean;
  try {
    bot = test ? test === 'bot' : (await checkBotId()).isBot;
  } catch (e) {
    console.error('[orb] BotID check failed', e);
    return null;
  }
  return bot ? error(403, 'bot_detected', "Orb couldn't tell that a person sent this and not a bot. Try again in a moment.") : null;
}
