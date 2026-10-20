#!/usr/bin/env node
// The orbworlds org on GitHub, as src/data/originals.json says. Every Orb Original is made in a
// repository of its own there, which is the only place its code is: Orb plays it from there
// (src/server/reposync.ts follows each repository), and nothing is copied either way. This keeps
// what's Orb's about those repositories:
//
//   - each world's repository: its description (`about` and the world's address on Orb), its link
//     and topics; public once the catalog says so (never back: that would lose its stars), and then
//     `main` protected (a reviewed pull request whose test passed; the app goes around it);
//   - orbworlds/.github, the only copy of what the worlds share: the org's profile, and the test
//     every world's repository runs (.github/workflows/world.yml, called from each one's
//     .github/workflows/test.yml), which other repositories in the org may use.
//
//   ORB_APP_ID=… ORB_APP_KEY=… node scripts/sync-org.mjs
//
// It runs as the org's GitHub App, so what it changes there is by its bot, never a person
// (.github/workflows/org.yml runs it when the catalog changes; scripts/setup-org.mjs gives that
// workflow the app).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, appLogin, gitAs } from './org-app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src/data/originals.json'), 'utf8'));
const { org: ORG, site: SITE } = catalog;

const slugify = (name) => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
const urlOf = (w) => `${SITE}/${catalog.org}/${slugify(w.name)}`;
const utm = (repo) => `utm_source=github&utm_medium=profile&utm_campaign=${repo}`;

/** The test every world's repository runs: npm test, and for a project a push to main packages it into the `orb` branch Orb plays. */
export const WORLD_WORKFLOW = `# Orb's test for its worlds, which every world's repository in the org runs (its
# .github/workflows/test.yml calls this): npm test on every pull request and push. A project (with
# tools/package.mjs) is also packaged on every push to main into the \`orb\` branch, which is what Orb
# plays. Made by Orb (scripts/sync-org.mjs).
name: World

on:
  workflow_call:

permissions:
  contents: write

jobs:
  play:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install --no-audit --no-fund
      - run: npm test
      - name: Package for Orb
        if: github.event_name == 'push' && github.ref == 'refs/heads/main' && hashFiles('tools/package.mjs') != ''
        run: |
          node tools/package.mjs "$RUNNER_TEMP/orb"
          cd "$RUNNER_TEMP/orb"
          git init -q -b orb
          git add -A
          git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' commit -q -m "Packaged from \${GITHUB_SHA::7}"
          git push -q -f "https://x-access-token:\${{ github.token }}@github.com/\${{ github.repository }}.git" orb
`;

function profile() {
  const row = (w) => {
    const play = `${urlOf(w)}?${utm(w.repo)}`;
    return `| <a href="${play}"><img src="https://raw.githubusercontent.com/${ORG}/${w.repo}/HEAD/docs/screenshots/1.webp" width="260" alt="${w.name}"></a> | **[${w.name}](${play})**<br>${w.about}<br><br>[Play](${play}) · [Code](https://github.com/${ORG}/${w.repo}) |`;
  };
  return `# Orb

Make worlds by describing them, play them together, remix anything: **[${new URL(SITE).host}](${SITE}/?utm_source=github&utm_medium=profile)**

| | |
|---|---|
${catalog.worlds.map(row).join('\n')}
`;
}

const RULESET = 'Orb: pull requests';
async function protectMain(gh, full, appId) {
  const { data: sets } = await gh('GET', `/repos/${full}/rulesets`);
  const body = {
    name: RULESET,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [{ actor_id: appId, actor_type: 'Integration', bypass_mode: 'always' }],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'pull_request', parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false } },
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'world / play' }] } },
    ],
  };
  const had = Array.isArray(sets) ? sets.find((s) => s.name === RULESET) : null;
  await gh(had ? 'PUT' : 'POST', had ? `/repos/${full}/rulesets/${had.id}` : `/repos/${full}/rulesets`, body);
}

const app = await appLogin(ORG);
const gh = api(app.token);
console.log(`as ${app.identity.name}`);
let failed = 0;

for (const w of catalog.worlds) {
  const full = `${ORG}/${w.repo}`;
  try {
    const { status, data } = await gh('GET', `/repos/${full}`);
    if (status === 404) throw new Error(`${full} doesn't exist: a world's repository is made by hand (its first commit is the world), then listed here`);
    const description = `${w.about} Play it at ${new URL(urlOf(w)).host}${new URL(urlOf(w)).pathname}`.slice(0, 350);
    const changes = [];
    if (data.description !== description || data.homepage !== urlOf(w)) {
      await gh('PATCH', `/repos/${full}`, { description, homepage: urlOf(w) });
      changes.push('description and link');
    }
    const topics = [...new Set(['orb', 'orbworld', 'browser-game', 'threejs', 'webgl', ...w.topics])].slice(0, 20);
    if (JSON.stringify([...(data.topics ?? [])].sort()) !== JSON.stringify([...topics].sort())) {
      await gh('PUT', `/repos/${full}/topics`, { names: topics });
      changes.push('topics');
    }
    if (w.public && data.private) {
      await gh('PATCH', `/repos/${full}`, { private: false });
      changes.push('public');
    } else if (!w.public && !data.private) console.warn(`  ${full} is public but the catalog says private: left public (making it private would lose its stars)`);
    if (w.public || !data.private) await protectMain(gh, full, app.appId);
    console.log(`${full}${changes.length ? `: ${changes.join(', ')}` : ''}`);
  } catch (e) {
    console.error(`${full}: ${e instanceof Error ? e.message : e}`);
    failed++;
  }
}

// orbworlds/.github: the profile and the worlds' test, and other repositories of the org may call that test
{
  const full = `${ORG}/.github`;
  const { git, clone, commit } = gitAs(app);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-org-'));
  try {
    clone(full, tmp);
    const files = { 'profile/README.md': profile(), '.github/workflows/world.yml': WORLD_WORKFLOW };
    for (const [p, data] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true });
      fs.writeFileSync(path.join(tmp, p), data);
    }
    git(tmp, 'add', '-A');
    if (git(tmp, 'status', '--porcelain')) {
      commit(tmp, 'The profile and the worlds’ test, as Orb has them now');
      git(tmp, 'push', '--quiet', 'origin', 'HEAD:main');
      console.log(`${full}: profile and the worlds' test updated`);
    } else console.log(full);
    await gh('PUT', `/repos/${full}/actions/permissions/access`, { access_level: 'organization' });
    const { data } = await gh('GET', `/repos/${full}`);
    if (catalog.profile.public && data.private) await gh('PATCH', `/repos/${full}`, { private: false });
  } catch (e) {
    console.error(`${full}: ${e instanceof Error ? e.message : e}`);
    failed++;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
