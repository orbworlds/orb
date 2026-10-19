#!/usr/bin/env node
// An installation token of the org's GitHub App (ORB_APP_ID, ORB_APP_KEY) for a workflow step:
// masked in the log, then written to $GITHUB_ENV as APP_TOKEN (or printed, outside Actions).
import fs from 'node:fs';
import { appLogin } from './org-app.mjs';

const { token } = await appLogin('orbworlds');
if (process.env.GITHUB_ENV) {
  console.log(`::add-mask::${token}`);
  fs.appendFileSync(process.env.GITHUB_ENV, `APP_TOKEN=${token}\n`);
} else {
  console.log(token);
}
