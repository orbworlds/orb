# Running Orb

What the README leaves out: configuration, money, the lab, backups, the GitHub org and moving to
a new address. SPEC.md is the contract for how things behave; this is how to run them.

## Configuration

Everything is set in Vercel's environment for the project `orb`.

| Variable | Purpose |
|---|---|
| `POSTGRES_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Set by the Supabase integration (database + realtime) |
| `ORB_SECRET` | Session signing secret (set) |
| `ORB_ADMIN_TOKEN` | Admin API: `POST /api/admin/worlds/<id>` with header `x-admin-token` and `{"verified": true, "featured": 50}` |
| `ANTHROPIC_API_KEY` | Optional. Without it, free building uses the Vercel AI Gateway (needs AI Gateway credits or a card on file) |
| `ORB_MODEL` | Optional gateway model id (default `anthropic/claude-opus-5.5`; one model for everyone, Free and Pro) |
| `ORB_AI_EFFORT` | Optional reasoning effort of Orb's AI: `low` (default), `medium`, `high` or `xhigh` — thinking is most of what a build costs |
| `ORB_CURSOR_KEY` | Optional Cursor API key (`crsr_…`, Cursor dashboard → Integrations). Without `ANTHROPIC_API_KEY`, free builds then run as Cursor agents on it (see [Free builder budget](#free-builder-budget)) |
| `ORB_CURSOR_MODEL`, `ORB_CURSOR_EFFORT` | Optional Cursor model of those builds (default `claude-opus-5-5`; `claude-sonnet-5-5` costs half as much) and its effort (default `low`) |
| `ORB_FREE_DAILY_PER_ACCOUNT` | Optional daily free build units per account (default 30, or 25 on Cursor; a unit is a build with up to 100k characters of input) |
| `ORB_FREE_DAILY_PER_DEVICE`, `ORB_FREE_DAILY_PER_IP` | Optional daily free build units without an account, per device (default 12, or 10 on Cursor) and per IP address (default 40, or 25 on Cursor; an IP's accounts together get three times that) |
| `ORB_FREE_DAILY_USD` | Optional budget in US$ for all free builds together per UTC day (default 20; `0` turns free building off). Once it's spent, the free builder is back tomorrow (see [Free builder budget](#free-builder-budget)) |
| `ORB_FREE_DAILY_USD_ANON` | Optional part of that budget for builds without an account (default half): once it's spent, people are asked to sign in, and those signed in keep building |
| `ORB_FREE_MAX_OUTPUT_TOKENS` | Optional longest reply of one free build (default 12000) |
| `STRIPE_SECRET_KEY` | Optional Stripe secret key: Pro and credit packs can be bought (see [Plans and credits](#plans-and-credits)). Without it, Pro says "Coming soon" and credits still apply |
| `ORB_STRIPE_SECRET_KEY` | Optional Stripe secret key that wins over `STRIPE_SECRET_KEY` (which Vercel's Stripe integration manages and may overwrite): set it to sell through a Stripe account of your choosing, e.g. for Production only while previews keep the sandbox |
| `STRIPE_WEBHOOK_SECRET` | Optional signing secret of a webhook endpoint you made yourself in Stripe; without it Orb registers its own |
| `ORB_STRIPE_TEST_ACCOUNTS` | Optional usernames (comma-separated) that may check out on the live site while `STRIPE_SECRET_KEY` is a sandbox's (`sk_test_…`); everyone else sees Pro as "Coming soon", as a test card would get them Pro for free. With a live key, everyone can pay |
| `ORB_GUEST_CREDITS`, `ORB_FREE_CREDITS` | Optional credits a month per device without an account (default 100) and per free account (default 300) |
| `ORB_PRO_CREDITS`, `ORB_PRO_USD` | Optional Pro credits a month (default 2000) and its price in US$ a month (default 20) |
| `ORB_TOPUPS` | Optional credit packs any account can buy, `usd:credits` (default `10:800,25:2100,50:4200`) |
| `ORB_SHOP_SHARE`, `ORB_SHOP_DAILY` | Optional: makers' part of the paid credits spent in their worlds' shops (default 1: all of it), and the credits an account may spend in worlds a day (default 2000) |
| `ORB_PAYOUTS`, `ORB_PAYOUT_HOLD_DAYS`, `ORB_PAYOUT_MIN`, `ORB_PAYOUT_BUYERS`, `ORB_PAYOUT_REVIEW`, `ORB_USD_PER_EUR` | Optional cash payouts of makers' earnings (see [Shops in worlds](#shops-in-worlds)): `0` keeps them closed (they open by themselves once the Stripe account has Connect); days before a sale's earnings can be cashed out (default 30); fewest credits per cash-out (default 10000: US$100); fewest different players behind them (default 10); `0` sends cash-outs without Orb's check (default: every one is a request Orb approves on Pulse); a fixed US$-per-euro rate instead of the ECB's |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Optional GitHub OAuth app (callback `/api/github/callback`); without it users paste a token |
| `ORB_TRACE_DAYS` | Optional: forget build traces older than this many days (default: keep them forever) |
| `ORB_LAB_KEY` | Secret path of the lab pages, `/lab/<key>`: Pulse, Analytics, traces and the hidden worlds. Without it, production has no lab (`dev-lab` locally) |
| `ORB_APP_ID`, `ORB_APP_KEY` | The orbworlds org's GitHub App (its id and private key): Orb reads its Originals' repositories with it while they're private (a contents-only token). Set by `scripts/setup-org.mjs`; without them, only public repositories |
| `NEXT_PUBLIC_SITE_URL` | Optional. Orb's address (default `https://orbworld.vercel.app`): links in metadata, sitemap and robots.txt, and where former addresses send people |
| `ORB_FORMER_ORIGINS` | Optional. Addresses Orb used to live at, comma- or space-separated (see [Moving to a new domain](#moving-to-a-new-domain)) |
| `ORB_PASSKEY_RP_ID` | Optional. The hostname every passkey belongs to (default `orbworld.vercel.app`). Never change it: passkeys made so far would stop working |
| `ORB_ORIGINS` | Optional. Other addresses that serve this same Orb as they are (not redirected); passkeys work there too |

## Free builder budget

Like chatgpt.com, the free builder needs no account and doesn't stop for everyone when someone
abuses it. Each person has quotas of their own: per account, or per device and IP address without
one (an IPv6 address counts as its /64, which one home or phone has all of). [Vercel
BotID](https://vercel.com/docs/botid) keeps scripts out of free builds, signing up and signing in
([`src/server/botid.ts`](../src/server/botid.ts): on in builds made on Vercel; requests go on if the
check itself fails, as the quotas still hold), and an IP makes at most 50 accounts a day, so
accounts can't be farmed for their quotas.

The hard cap on money is the free builder's daily budget in US dollars (`ORB_FREE_DAILY_USD`, $20
by default; [`src/server/budget.ts`](../src/server/budget.ts)), as Cursor can't limit one API key's
spend. Every free build is charged to it as it goes, at the model's list price: exactly where the
provider reports usage, and estimated for Cursor agents (their stream counts the tokens the model
writes; what it reads is estimated generously) and for a model call cut short (Stop, a time limit:
the prompt it read and what it wrote by then). Once the day's money is spent, running builds
pause at their next model call and new ones hear that the free builder is back tomorrow (UTC). Builds
without an account may spend half of it (`ORB_FREE_DAILY_USD_ANON`), so an attack without accounts
only makes people sign in, and those signed in keep building. Pulse shows each day's spend against
the budget, and each Cursor build's trace its estimated cost (`costUsd`): compare them with the
Cursor dashboard's Usage now and then. Builds paid for with bought credits (Pro, packs) are outside
the budget and the daily caps; how much each person builds in a month is their
[credits](#plans-and-credits).

With the AI Gateway, also cap it there: buy credits with auto top-up off, and give the project a daily budget with
spend alerts (AI Gateway → Budgets → Projects, or
`vercel ai-gateway budgets set project orb --limit 10 --refresh-period daily`). A used-up budget
makes the free builder say it is back tomorrow; a gateway without credits or a card is logged as
`[orb] free builder DOWN`. Every free build logs its token usage as `[orb] build usage`.

With `ORB_CURSOR_KEY` the free builder is a Cursor Cloud Agent on that key, so builds use the
key owner's Cursor usage (Cursor dashboard → Usage; a spend limit there covers the whole account,
not just this key, hence Orb's own budget). No GitHub is needed:
the agent downloads the world's files from Orb and saves each improvement back through a link that
only works for that build while it runs (`/api/agent/jobs/<id>/files`, see
[`src/server/agent/sync.ts`](../src/server/agent/sync.ts)). Each edit the agent makes shows up in the
world at once, read from its stream ([`src/server/agent/mirror.ts`](../src/server/agent/mirror.ts)), and each save becomes a version.
It sees the world it makes, like the in-house agent: `sh .orb/look` runs its files in the person's
browser (without saving them), plays the world if asked, and gives the agent what the page saw —
errors, console, frame rate, the text on screen and screenshots
([`src/server/agent/look.ts`](../src/server/agent/look.ts)). It needs the world open in a browser,
which it is while someone watches their build.
A build has no time limit, like a Cursor agent's: it goes on until it's done (each Cursor run
stops after 30 minutes, and a follow-up run carries on where it left off), or until the person's
credits or the day's budget run out, when it pauses and keeps what it made. Orb asks its agent to
be quick (most builds take a minute or two) and only to take longer for big requests. The daily
caps above apply, with smaller defaults (25 builds a day per account; without one, 10 per device
and 25 per IP). A key
Cursor refuses shows up in Pulse → Problems as `Cursor builds refused`.

## Plans and credits

Building with Orb's AI costs credits; a credit is a cent of what the AI costs Orb at the model's
list price (what the [free builder budget](#free-builder-budget) counts), and a typical build
uses about 30 (the median free build on Sonnet 5.5 was 15; Orb's AI is Claude Opus 5.5 for
everyone now, at twice the price per token). [`src/server/credits.ts`](../src/server/credits.ts)
keeps everyone's wallet, [`src/server/billing.ts`](../src/server/billing.ts) and
[`src/server/stripe.ts`](../src/server/stripe.ts) sell Pro and the packs; people see it all at
`/pricing` and in *You → Plan*.

| | Price | Credits a month | Also |
|---|---|---|---|
| Free | $0 | 300 (about 10 builds) | |
| Pro | $20 a month | 2,000 (about 70 builds) | the same builder as Free; never paused by the free builder's budget or daily caps |

Without an account a device gets a small allowance to try Orb (`ORB_GUEST_CREDITS`, 100 by
default). The app never says how much, so it can change (say, when it's abused); running out
asks people to make a free account.

Credit packs (any account): $10 for 800, $25 for 2,100, $50 for 4,200. Pro is Orb's cost if a member
uses every credit (Stripe's fee aside); the packs also cover Stripe's fee; Free is what Orb gives.
Packs give a little less per dollar than what Pro adds over Free (85 credits a dollar), so Pro is
the better deal for regular builders, but not by enough that a second account with a second
subscription would pay off.
A month's plan credits don't carry over (Free's month is the calendar month in UTC, Pro's the
subscription's); pack credits stay until used, also after leaving Pro, and are spent after the
plan's. Builds with people's own keys use no credits.

### Shops in worlds

Credits also buy things inside worlds: a world lists what it sells in its page and calls
`orb.shop.buy(id)`, and Orb's own sheet asks the player at the price in Orb's saved copy of the
page ([`src/server/shop.ts`](../src/server/shop.ts), SPEC §7). Credits people paid for go first in
worlds (a Free account's packs before its month's free credits, which stay for building), and the
world's maker earns all of that paid part (`ORB_SHOP_SHARE`, 1: Orb takes no fee for now; credit
packs sell credits above a cent, which covers Stripe's fees); free credits buy things too but earn
nothing, so making accounts for their free credits pays nobody. Makers see what they
earned in *You → Plan* and can build with it (it becomes bonus credits, which earn nobody anything when spent in worlds, so earnings can't be passed to another account to be cashed out there) or **cash it out**
([`src/server/payouts.ts`](../src/server/payouts.ts)), on the lines of Roblox's Developer Exchange.
Only credits earned from **other players** count: what a maker's own accounts buy (sharing a device
or a card with them) earns credits to build with but never cash, and so do purchases of a payer whose
payment was refunded or disputed, which also takes back what their purchases earned. Sales clear
after 30 days, a cash-out needs at least 10,000 credits (US$100; Roblox asks 30,000 Robux, about
US$114) earned from at least 10 different players, and every one is a request Orb checks on the
lab's **Pulse** (who bought, how many players, the biggest buyer's part) and approves with the admin
token before Stripe pays it, in euros at the ECB's rate of the day. Stripe Connect onboards each
maker once (an Express account in their bank's country). Payouts open by themselves once Orb's
Stripe account has Connect: in Stripe's dashboard, Connect → Get started, choose "Platform" with
Express accounts, and fill in the platform profile (Orb pays the fees and takes the losses of
connected accounts). Stripe charges per active Express account and per payout; those fees are
Orb's. Keep a little money in the Stripe balance for payouts (a payout that finds too little
fails, and the earnings stay the maker's). Orb's own worlds (VampireZ, Bed Wars, Orbcraft) sell looks and a season pass this way, next to
what players earn there by playing.
Each account spends at most 2,000 credits a day in worlds (`ORB_SHOP_DAILY`).

There is one kind of build, an agent job on Orb's server, and it is charged live. Builds check
the credits before they start (402 `out_of_credits`, and the chat offers what next: an account,
Pro, a pack or one's own key) and are charged as they go, like the budget: a build that runs out
pauses at its next model call and keeps what it saved (its last step may take the balance a
little below zero). Stopping a build charges what it used up to then, the model call it cut short
included. Builds have no time limit, so the credits are what ends a long one. A build that fails
without saving anything is refunded, unless it ran out of credits. Each build in the chat shows
what it used, as it goes, also when it was stopped or only answered a question.

**Selling it (Stripe).** Orb needs only a secret key; it makes the Pro price, the customer
portal's settings and its webhook endpoint (`/api/billing/webhook`, from the production
deployment) itself, the first time someone checks out.

1. **Vercel → project `orb` → Integrations → Stripe** (or `vercel integration add stripe`): it
   makes a Stripe sandbox and sets `STRIPE_SECRET_KEY`. Redeploy (`npm run deploy`).
2. Try it on the site with an account named in `ORB_STRIPE_TEST_ACCOUNTS` (a sandbox's key only
   lets those pay on the live site): *You → Plan → See plans → Go Pro*, pay with the test card
   `4242 4242 4242 4242` (any future date and CVC), and *You → Plan* says Pro. *Manage billing*
   opens Stripe's portal (cancel at the period's end, card, invoices).
3. Going live: in the integration, **Import Existing Stripe Account** (or set
   `ORB_STRIPE_SECRET_KEY` for Production to the live account's key, best a restricted one with
   write access to Products, Prices, Checkout Sessions, Customers, Customer portal and Webhook
   Endpoints and read access to Subscriptions) and redeploy; Orb sets up the live account by itself
   as well, and everyone can go Pro. To check a new key right away, `POST /api/admin/stripe` with
   the `x-admin-token` header: it says which account the key reaches (the name and statement
   descriptor buyers see), whether it's live, and makes the price, the portal settings and the
   webhook now instead of at the first checkout. Customers of the account used before are
   forgotten when the new one doesn't know them (their next checkout makes a new customer).
   Rolling the key (Stripe → Developers → API keys) is the same: set the new one, redeploy, and
   Orb's webhook made with it replaces the old key's endpoint.

Checkouts also apply when people come back from Stripe (`/api/billing/return`), and a Pro period
that ended is looked up in Stripe, so plans work even while the webhook isn't there yet (Stripe's
dashboard → Developers → Webhooks shows Orb's endpoint and its deliveries). To use your own
endpoint instead, set `STRIPE_WEBHOOK_SECRET` (events: `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `customer.subscription.created|updated|deleted`,
`invoice.paid`, `invoice.payment_failed`). Refunds and disputes are done in Stripe's dashboard;
they don't take credits back. Prices are in US$ without tax: turn on Stripe Tax for that. Pulse
shows who is on Pro, the packs sold and what paid builds cost each day.

## Forgotten passwords

Accounts have no email, so an admin resets a forgotten password (the person then changes it in You):

```bash
curl -X POST https://orbworld.vercel.app/api/admin/password -H "x-admin-token: $ORB_ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"username": "max-builds", "password": "a new password"}'
```

## Build traces

Every AI build is recorded in full, the way Cursor keeps an agent's trace: what it was given (the
system prompt, the chat, the world's files), each model step (thinking, narration, every tool call
with its input and result, tokens and timing), each look at the world with its screenshots,
retries, versions saved and how it ended. That covers every build: Orb's own agent and Cursor
agents, on Orb's AI or the person's own key (older traces also hold single-shot `/api/build`
builds and rounds browsers ran with their own key, from before every build was an agent job).
Traces live in Postgres (`orb_traces`, `orb_trace_events`, `orb_trace_blobs`: payloads
gzipped, prompts, files and screenshots stored once by hash) and are kept until `ORB_TRACE_DAYS`
says otherwise.

To look at them, open the lab's traces page, `/lab/<key>/traces` (the key is `ORB_LAB_KEY`, see
[`src/server/lab.ts`](../src/server/lab.ts)). It lists traces newest first, with filters (status,
kind, provider, words in the prompt) and totals (tokens, storage), and each trace opens on its
whole timeline. **Export JSONL** there downloads them as JSON lines, one trace per line with all
its events: `/lab/<key>/traces/export`, plus `?since=2026-01-31`, `?limit=2000`, `?id=<trace>`, or
`?images=1` to put the screenshots in as data URLs.

## Analytics

Besides Vercel's Web Analytics (page views), Orb keeps its own events in `orb_events` (180 days)
and shows them at `/lab/<ORB_LAB_KEY>/analytics`, linked from Pulse: visitors, visits, how far new
people get (open a world, prompt, build, come back), worlds by opens and play time, sources, phones
and computers, countries, and everyone who came with a timeline of what they did. Tracked: page
views, world opens (and from where) and time in worlds, prompts (with their first 200 characters),
builds, undos, remixes, likes, restores, downloads, Explore (opening, filters, searches),
sharing, imports, accounts, people's own model keys (the provider, never the key) and error toasts.
The full list with props is in [`SPEC.md`](../SPEC.md) §6 "Analytics"; new ones are one call to
`track('snake_case_name', { … })` from `src/lib/analytics.ts`. Bots, headless browsers and the lab
pages aren't counted.

## Backups

Every night at 03:23 UTC, the **Backup** workflow ([`.github/workflows/backup.yml`](../.github/workflows/backup.yml))
copies what the site records about builds and visitors to the private repository `orbworlds/orb-backups`
(`ORB_BACKUP_REPO`), as the org's GitHub App, with
[`scripts/backup.mjs`](../scripts/backup.mjs): every trace with its prompts, files and screenshots,
each day's analytics events, and a daily snapshot of Pulse's numbers and of the recorded problems.
It reads them from the lab with its key (`/lab/<key>/traces/export`, `/traces/blob/<sha>` and
`/lab/<key>/backup`), from the repository secret `ORB_LAB_URL`: `https://<site>/lab/<ORB_LAB_KEY>`. It only adds and refreshes files, never deletes
any, so the backups keep what the database lets go of (analytics after 180 days, problems after 30).
Worlds and accounts aren't in it. Run it any time from the Actions tab (Backup → Run workflow), or
anywhere with `node scripts/backup.mjs <dir> https://<site>/lab/<key>`.

## The org and its games

Every Orb Original is made in a GitHub repository of its own in the `orbworlds` org, and that
repository is the only place its code is. [`src/data/originals.json`](../src/data/originals.json) lists
them (what Orb says about each: name, Explore copy, tags, order, thumbnail, its repository and the
blurb on GitHub), never their code. Orb plays each Original from its repository: it is linked like
any world kept in sync with GitHub (SPEC §2 "GitHub sync"), so a change merged there is live on Orb
within minutes, with no commit or deploy here. The single-file worlds are played from `main`; the
two projects (Wildbrush and Foxfire Fjord) from an `orb` branch their CI packages on every push.

What the repositories share lives once too:

- **The Orb kit** is [`kit/`](../kit/README.md) here, on npm as
  [`@orbworlds/kit`](https://www.npmjs.com/package/@orbworlds/kit): when the kit or Orb's runtime
  changes, [`.github/workflows/kit.yml`](../.github/workflows/kit.yml) publishes the next version
  ([`scripts/publish-kit.mjs`](../scripts/publish-kit.mjs), with the secret `NPM_TOKEN` of the npm account
  `orbworlds`; bump the minor in `kit/package.json` for a change worlds should opt into). Each world's
  `package.json` depends on it (`^0.3.0`, with its lockfile): `npm start` is `orb dev`, and a world
  without a suite of its own tests with `orb test`.
- **Their test** is one workflow in `orbworlds/.github` (`.github/workflows/world.yml`); each
  repository's `.github/workflows/test.yml` only calls it. It runs `npm test` on every pull request
  and push, and packages a project into its `orb` branch.
- **The rest** (README, screenshots in `docs/screenshots/`, the big games' suites in `test/play.mjs`)
  is each repository's own.

[`scripts/sync-org.mjs`](../scripts/sync-org.mjs) keeps what's Orb's about the org: each repository's
description (its blurb and the world's address on Orb), link, topics and visibility, the org's profile
and the shared workflow. [`.github/workflows/org.yml`](../.github/workflows/org.yml) runs it when the
catalog changes. [`scripts/game-shots.mjs`](../scripts/game-shots.mjs) plays each world and commits fresh
screenshots to its repository.

```bash
ORB_APP_ID=… ORB_APP_KEY=… node scripts/sync-org.mjs                    # what the org workflow does
ORB_APP_ID=… ORB_APP_KEY=… node scripts/game-shots.mjs [--only <repo>]  # new screenshots in the worlds' repositories
```

To change a world, open a pull request in its repository. To add one, make its repository (its first
commit is the world), list it in `originals.json`, and ship.

**Nobody's account appears in the public repositories.** Every repository started with a fresh
history, and Orb works there as its own **GitHub App** (its bot), since a public repository's Activity
page and Actions runs show who pushed. People who review and merge pull requests in the world
repositories do appear: use an account for that which is Orb's (say *orb-team*), not a personal one.

- **Setting it up:**
  1. Make Orb's GitHub App **in the org** (Organization settings → Developer settings → GitHub Apps →
     New), so the org owns it: name *Orbworlds* (its bot is `orbworlds[bot]`), homepage
     https://orbworlds.com, webhook off, repository permissions **Administration**, **Contents** and
     **Workflows**: read and write; only on this account. Generate a private key, then **Install** it
     on the org, all repositories.
  2. Give Cursor's agents `ORB_APP_ID`, `ORB_APP_KEY` (the key file's text), an org owner's
     `ORB_GITHUB_TOKEN` (fine-grained, the org's repositories: Secrets and Variables, read and write)
     and a Vercel token as secrets.
  3. `VERCEL_TOKEN=… node scripts/setup-org.mjs` gives the org workflow the app, and Orb's server too
     (production's `ORB_APP_ID` and `ORB_APP_KEY`), which reads the Originals' repositories with it
     while they're private (contents only).
- **Reviewing pull requests:** once a repository is public, `sync-org` makes its `main` need a reviewed
  pull request whose test passed (GitHub's free plan protects public repositories only); the app goes
  around it.
- **At launch:** set `"public": true` for each world and the profile in `originals.json`, then ship.
  The org workflow makes the repositories public (never the other way: that would lose their stars),
  and Orb's Originals link to them ("Source code · MIT" in the world's menu). In each repository's
  settings, upload a screenshot as the social preview (GitHub has no API for it).

### The code itself

Orb's code is public at [`orbworlds/orb`](https://github.com/orbworlds/orb). Its workflows run
there and only there (each checks `github.repository`): CI on every pull request, the backup, the
GitHub sync, the kit's publishing and the org. Their secrets are that repository's: `ORB_APP_KEY`,
`ORB_LAB_URL`, `NPM_TOKEN`, and the variable `ORB_APP_ID`.

For now the work itself happens in a private repository, `orbworlds/orb-private`, which keeps the
history and the pull requests: on every push to its `main`, [`public.yml`](../.github/workflows/public.yml)
(the one workflow that runs only there) has [`scripts/publish-public.mjs`](../scripts/publish-public.mjs)
make the files one commit in the public repository, by the org's bot, with the change's title.
`ORB_PUBLIC_REPO` names where it publishes.

## Moving to a new domain

Orb can move to a new address (say `https://orb.example`) and everyone keeps their account, worlds,
chats and settings, stays signed in and keeps their passkeys (usernames and passwords work at any
address anyway); old links open the same page at the
new address. Nothing changes until the variables below are set.

1. **Vercel → project `orb` → Settings → Domains:** add `orb.example` and set up its DNS. Keep
   `orbworld.vercel.app` attached and serving production (not *Redirect to another domain*, and
   don't rename the project): old links land there and every passkey belongs to it. Orb does the
   redirecting itself, so that people's things come along.
2. **Settings → Environment Variables (Production):**
   - `NEXT_PUBLIC_SITE_URL` = `https://orb.example`
   - `ORB_FORMER_ORIGINS` = `https://orbworld.vercel.app`
   - leave `ORB_PASSKEY_RP_ID` unset (it is `orbworld.vercel.app`) and never change it.
3. **GitHub sign-in** (only if `GITHUB_CLIENT_ID` is set): in the GitHub OAuth app, change the
   callback URL to `https://orb.example/api/github/callback`.
4. **Redeploy** (`npm run deploy`): the redirects and `NEXT_PUBLIC_SITE_URL` are fixed at build time.
5. **Check:** `https://orbworld.vercel.app/.well-known/webauthn` lists both addresses, and an old
   link opened in a signed-in browser lands on the same page at `orb.example`, still signed in.

Moving again later: add the address you're leaving to `ORB_FORMER_ORIGINS`
(`https://orbworld.vercel.app https://orb.example`), keep every former domain attached, and still
leave `ORB_PASSKEY_RP_ID` alone. Browsers only promise passkeys on five different site names
(`orbworld`, `orb`, …) per RP ID, so keep the list short.

What people see: the first time a browser opens a page at a former address, a small card says
"Taking you to Orb's new home…" for about a second while its Orb storage (device key, chats,
settings, saved games, model keys) and its sign-in travel over and merge with
anything it already had at the new address. They wait on the server under a single-use code only
that browser can pick up, for at most 10 minutes. If a browser holds more than about 4 MB, its
largest chats and saved games stay behind and the card says so. After that the browser goes
straight over with a permanent redirect, as do crawlers and link previews. The API, files and
`/.well-known` keep answering at former addresses, so anything calling them keeps working.

| Browser | Passkeys at the new address |
|---|---|
| Chrome and Edge 128+, Safari 18+ (Mac, iPhone, iPad) | Work directly (Related Origin Requests: `orbworld.vercel.app/.well-known/webauthn` lists the new address) |
| Firefox, older Chrome and Safari | Signing in or up visits `orbworld.vercel.app` for the passkey prompt and comes back signed in (Safari may ask for one more tap) |
| Safari before 16.4 | These don't mark page visits (`Sec-Fetch-Dest`), so old links skip the hand-off: they arrive signed out and sign back in with their passkey; worlds made there without an account can't be edited at the new address |

The passkey prompt names `orbworld.vercel.app` everywhere, since that's where the passkeys belong.

## Scripts

`node scripts/gen-template-cards.mjs` regenerates the small start-screen card thumbnails after changing a template thumbnail.
`node scripts/thumb-vampirez.mjs` renders VampireZ's thumbnail (Orb's picture of it, `public/templates/vampirez.webp`) in the game itself, as Orb plays it now or from a checkout (`--game <index.html>`) (the Count on a rooftop in
Hollowmere under a blood moon, staged through the game's `?debug` hooks, with the game's title in its own font)
after changing how Hollowmere, its vampires or its logo look; `node scripts/thumb-bedwars.mjs` does the same for
Bed Wars (Red's champion over Blue's bed on Sunset Mesa), and `node scripts/thumb-craft.mjs` for Orbcraft (Haven's
plaza, its keepers and portals, and the Wilds past the north gate).
`node scripts/previews.mjs [id …]` records the looping video previews that the top worlds' cards play
(`public/previews/`): 4 s loops at 1280×800 (the page drawn at twice its 640×400 size, so they stay sharp on
high-density screens; the lead tile's Orbcraft at 2.5×). How each world is shot is set in the script; `QUICK=1` takes a few stills first, to check a shot.
`node scripts/previews-from-post.mjs <id> <video> [start]` cuts one from its maker's own video instead (the
one in their post; for X, `https://api.fxtwitter.com/<user>/status/<id>` lists its files), for worlds
they filmed better than the recorder can play them here; `SHEET=1` shows stills with their times, to pick the start; `CROP=w:h:x:y` keeps part of the picture (past a video's own buttons) and `CRF=vp9,h264` sets its quality. A trailer that cuts every few seconds can still
give one: join three or four of its clean shots (no text, menus or faces) with ffmpeg's `xfade`
(fade, 0.4 s) into a file of about 6 s and cut the preview from that (Arkenfall, Messenger).

To see how the builder does on a prompt, `node scripts/build-check.mjs "a cozy snow globe"` builds it
on production the way a visitor would (`--base <url>` for another deployment) and saves screenshots
while it builds, the finished world as a visitor sees it (after a drag and a tap), its files and a
summary under `.data/build-check/`, then deletes the test world (`--keep` keeps it). The build's
full trace is on the lab's traces page.
