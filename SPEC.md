# Orb — make worlds by talking

Orb is a metaverse you build through chat. Roblox/Minecraft meets Cursor: you land on a calm,
beautiful blank world, say what you want, and watch it get built live. Every world gets a
shareable URL, loads instantly, needs no install and no login. Worlds are public and
remixable by default.

Production: https://orbworld.vercel.app (Vercel project `orb`, Next.js 16 App Router).

This document is the contract every contributor (human or agent) builds against.
If you change a contract, update this file in the same change.

---

## 1. Product principles

1. **Zero friction.** No forced login, no setup, no modal on first visit. The first screen IS the
   canvas. A 5‑year‑old can type "a pink castle on a cloud" and get something magical.
2. **Calm, luminous, minimal.** One always-present element: the **Orb** (a floating, draggable,
   iridescent sphere; on phones, past the start screen, it tucks half behind the screen's edge,
   clear of a world's own controls; home has it in its header instead). Everything else (chat,
   settings, account) lives inside it, in a panel only as tall as what it holds. The Orb is a toggle
   and stays where it was: a tap opens its panel beside it (under it on home; a bottom sheet on
   phones) and another tap closes it (it shows an × meanwhile). The one exception: as
   a world opens, "Explore" top-left goes back to Explore in one click; a few seconds after the world
   is ready it fades away, leaving the world the whole screen, and the pointer reaching the top-left
   corner, where it sat, brings it back; on a phone it shrinks to a small round arrow that stays
   (the world bar's "← Explore" and the browser's back go back too). Toasts never print over the world: there they're a small bubble beside the Orb.
   No clutter, no chrome, no ads, no badges-everywhere. The world is the hero.
3. **Live.** Users see their instructions executed (a request that fails can be tried again, in its place): narration streams, each build step lands in
   the world as it completes (cross-faded, no flashes).
4. **Forgiving.** Every build is a version: one tap undo. Runtime errors are auto-fixed once.
5. **Open by default.** Public worlds are remixable (forkable) unless the owner turns it off.
   Remixing copies the source; the UI says so clearly when you publish.
6. **Together by default.** A world you move around in shows everyone who's in it right now
   (`orb.visitors`), so every world is a place to meet friends. The builders add it unasked.

## 2. Core concepts

- **World**: a single self-contained HTML document (HTML + CSS + JS, three.js etc. from a CDN),
  run inside a sandboxed iframe. `kind: 'native'`.
- **External world**: a curated showcase entry that embeds an existing website by URL
  (e.g. Hikari Dream House). `kind: 'external'`. Not editable here and has no Remix (its menu links to
  its source repository, if any). Orb can't read its code, so what's
  typed in its chat starts a new world of one's own from that text. A curated world whose code is
  open source (`native` in `seeds.json`) is imported from its repository instead and runs from
  Orb's copy, remixable (a start page from `src/data/seed-pages.ts` when its repository has none
  a world can run).
- **Template**: a hand-crafted starter world — the blank island (`public/templates/blank.html`) and
  Orb Originals (Island, Blocks, Runner, Paint, Room…, `src/lib/templates.ts`), whose code is the
  Original's (`/api/worlds/orb-<id>`). Picking one loads it instantly (no AI call).
- **Device**: anonymous identity. A random `deviceKey` in localStorage; the server only stores
  `sha256(deviceKey)`. Anonymous worlds belong to the device.
- **Account** (optional): a username and a password (scrypt-hashed, no email; an admin resets a
  forgotten one). The username is the account's handle in world URLs (`/<username>/<world>`), typed
  any way ("Max Builds" → `max-builds`). Needed only for private worlds and cross-device
  ownership. Accounts made with a passkey (Face ID / Touch ID) still sign in with it and can add a
  password. Signing in links the device and claims its worlds. Passkeys on all
  of Orb's addresses share one RP ID (§3 "Addresses"). Signed out, the top of the You tab is the one
  place that asks for an account ("Keep your worlds on every device": Create account · Sign in); the
  plan shows for accounts, and Advanced (your own AI key, GitHub) once it's in use or asked for.
- **Chat**: per-world conversations stored locally (localStorage). A world starts with one;
  **New chat** (the world's ⋯ menu) starts another, and once it has two, a row above the chat
  switches between them (and to recent chats in other worlds). A reply reads in the order it
  streamed: what Orb said first, the build's steps as a checklist, what it said after. Only the
  newest reply that changed the world offers **Undo**; an undone reply fades, with "Back to how it
  was". Replies carry no version numbers or credits (the chat says so only when credits run low:
  "12 credits left · See plans"). While Orb works, one word: "Thinking…" (answers in someone else's
  world) or "Building…".
- **Home** (`/`) is Explore under an invitation to make a world, on a calm background of its own
  (no world behind it: light, the sky with a soft iris glow, fading into paper under the worlds;
  dark, one deep dark with the same glow, low). A header row: on the right
  the Orb itself, docked (it floats only inside worlds), and before it, signed out, a quiet
  **Sign in** (the You tab, at its sign-in form). Then the headline ("Step into a world"), the big composer, under it **Or remix** and three of Orb's own
  worlds (Orbcraft, Glow Paint, Star Runner: each remixes as a tile's Remix does, into the copy with
  its chat open), (for people who have some) one row of their own worlds or their friends' (**Your
  worlds**, with **See all**; read again each time home shows), then Explore's header and a few of
  its worlds (the lead and four rows, at every width), **More** (`/explore`: all of them,
  in place, as a page of its own: the browser's back returns home) and a footer (orbworlds, Plans,
  the Orb kit on npm, `/llms.txt` (how to make worlds, for AI agents), GitHub (the org:
  `GITHUB_URL`) and Back to top). Sending from the composer hands over to the chat on the canvas;
  the world it makes gets its own address as a new page (the browser's back returns home). Once
  Explore's header reaches the top it stays there, opaque over a hairline, with the Orb at its end.
  There is one Explore, and it is this page: a world's way back, "See all", `/explore` and a missing
  world's Explore button all go home, down at its worlds.
  The Orb there opens its chat under it ("What should we make?" with a few ideas; its You tab when
  the only news is a friend's, as in a world), and closes it again; it swirls while a build runs.
- **Opening a world** (a tile, a link, back/forward) shows one calm cover until the world has drawn
  (its ready signal; 20 s at most): its preview (or picture) under a soft scrim and its name, never
  another world in between. On a phone, a visitor's world that needs a keyboard (the `keyboard` tag)
  stops there first: "Best on a computer" and **Play anyway**, which loads it (once a session).
- **The world bar** (the top of the Orb's panel, above the chat; on a phone one row from the
  sheet's first height, "← Explore" joining it at full height): "← Explore"; the world's name, and
  under it its maker ("by you" on your own), for a remix what it came from ("by you · remixed from
  Glow Paint", a link that gives way first when room is short), and who's here (a green dot and how
  many, friends' faces); then like · **Remix** · share · ⋯. Remix is the one name for making your
  own copy: it opens the copy with its chat ("Your copy of Orbcraft. What should we change?" and a
  few ideas), once however often it's pressed while the copy is on its way; a world running on its
  maker's site has none. On your own world the ⋯ menu has **Rename** (or click the name) and its copy
  is **Duplicate**, and Download .zip is in its Share sheet. Share on a phone opens its share sheet,
  or copies the link and says so.
- **New world** (Explore, You, a missing world's page) opens the start canvas with the Orb's chat
  open and its composer focused, not the start screen. The Orb's first line there ("What should we
  make?") also offers "Or start from an existing world": three popular remixable worlds
  (`StartFrom`; picking one remixes it) and **See more**, which goes to Explore.
- **Profile**: every maker's page at `/<handle>` (their name, friends and public worlds), shown
  as a sheet over the start canvas; a world's "by …" opens it. Worlds live at
  `/<handle>/<world>`. Worlds without an owner live under their maker's name: Orb's own are by
  **orbworlds** (`/orbworlds/orbcraft`), the curated worlds other people made by them
  (`/leon-lin/athenaion`; a name in another script goes by the handle they posted with). That handle
  is kept for the maker (no account can take it) and its page lists their worlds. Every address a
  world ever had keeps working (`/orb/…`, `/web/…`). One no world has is the site's 404 (HTTP 404:
  "Nothing out here", with New world and Explore); a private world's answers as usual, and the page
  opens it for its maker only.
- **Friends** (accounts only): asked by username (or from a profile) and accepted by the other
  person; asking someone who asked you is saying yes. Friends see where each other are (the
  public world on their screen; a private one just shows "Online"), join them there (in the same
  room of it), invite each other into worlds, and find each other's worlds in the start screen's
  row. Inside a world they're marked as friends (`peer.friend`; a ♥ on `orb.visitors`' name tags).
  A signed-in page that is visible sends a heartbeat every 30 s (and soon after a room of the
  world opens or someone comes in); someone is online for 90 s after their last one, or until
  their page goes away.
- **Share links** say who shared them: signed in, a world's link (the share sheet, the bar's share
  button, `orb.room.invite`) carries `?with=<your handle>`. Whoever opens it is told who invited
  them and can ask them to be friends in one tap (signed out: their profile, where adding them
  makes an account first); the handle leaves the address at once.
- **Asking in someone else's world**: the chat is a guide there. Questions are answered in place
  (charged like any build on Orb's AI) and never copy the world. A change request gets **Remix**
  under the answer (the world bar's word): it remixes the world and builds the request in the copy.
  The welcome line says where they are ("You’re in Glow Paint by orbworlds. Ask me anything about
  it.") and offers two questions, and the composer says "Ask about Glow Paint…".
- **Remix credit**: when someone makes a remix of a public world their own (its first change), the
  world's maker (with an account) hears who did. A world's ⋯ menu counts its changed public remixes
  and lists them; each remix says what it came from ("Remixed from …" there too), so the remix tree
  can be walked both ways.
- **Orb Originals and their repositories**: Orb's own worlds (`src/data/originals.json`: what Orb
  says about each, its repository and the branch Orb plays; never their code). **Each is made in a
  GitHub repository of its own** in the `orbworlds` org, the only place its code is: pull requests
  there run its tests and are merged there, and nothing is copied into Orb's repository. Orb plays an
  Original from its repository: `src/server/originals.ts` keeps each one's row (name, Explore copy,
  tags, order, thumbnail) and links it to its repository's branch like any world kept in sync with
  GitHub (below), which brings a new commit in as the Original's files, in place (an Original has
  one version, kept in step; nobody owns it, and nothing is pushed back). Single-file worlds are
  played from `main`; a project (Wildbrush, Foxfire Fjord: a build step, `tools/package.mjs`) from
  its `orb` branch, which its CI packages on every push to `main`. While the repositories are
  private, Orb's server reads them as the org's GitHub App (`ORB_APP_ID`, `ORB_APP_KEY`, a
  contents-only token). What the repositories share exists once: the **Orb kit** (`kit/` here),
  on npm as `@orbworlds/kit` (`scripts/publish-kit.mjs`, from `.github/workflows/kit.yml`, publishes
  the next patch whenever what's in the package changed, its runtime built from Orb's; the minor and
  major are set in `kit/package.json`), which every world's `package.json` depends on with a lockfile
  (`npm start` = `orb dev`; `orb test`: the world runs through the kit in Chrome, draws, and nothing
  throws), and the worlds' test, one workflow in `orbworlds/.github` that each repository's
  `.github/workflows/test.yml` calls (`npm test`, and a project's packaging). `scripts/sync-org.mjs`
  (`.github/workflows/org.yml`, when the catalog changes) keeps each repository's description (its
  `about` and the world's address on Orb), link, topics and visibility, the org's profile and that
  workflow; `scripts/game-shots.mjs` commits screenshots to the repositories. Both run as Orb's
  GitHub App, so the public repositories show its bot, never a person's account
  (`scripts/setup-org.mjs` gives the app to the workflow and to Orb's server), and a world's `main`
  is protected (a reviewed pull request whose test passed; the app goes around it) once it is
  public. Once a world is
  public, its Original links to its repository ("Source code · MIT" in the world's menu), and so
  do its remixes. The links: `?remix` on a world's page opens its chat, beside its bar's **Remix**
  (never a copy made by opening a link); `?import=<owner>/<repo>` opens the
  You tab with that repository in the import form. Both leave the address at once
  (`src/state/links.ts`). A repository whose `orb.json` names an Orb world (`world`: a fork of a
  game) is imported as a remix of it when that world is public and remixable: credited, counted
  and listed like any remix, with the world it came from as version 1 and the repository's files
  as version 2 when they differ (so it counts as changed and its maker is told).
- **GitHub sync** (`src/server/reposync.ts`, the one way Orb works with people's GitHub): a world
  can be kept in sync with a branch of a GitHub repository, both ways. A world imported from a
  branch is linked to it; "Keep on GitHub" in its owner's menu puts a world in a new private
  repository of theirs and links it, and so does **Keep every world on GitHub** (You → GitHub,
  `orb_github_tokens.auto`) for each world of theirs at its first save (made, remixed, edited or
  built, by any builder). Orb keeps every world itself either way, so losing the GitHub account or
  the repository loses nothing. The link
  (`orb_world_repos`) remembers the commit and the world's tree both sides last agreed on.
  **GitHub → Orb**: when anyone opens the world (at most once a minute, after the response), when
  its owner taps **Sync with GitHub now**, and every 10 minutes for links nobody opened
  (`/api/cron/github`, from `.github/workflows/github-sync.yml`), Orb reads the branch's head; a new
  commit comes in as one new version (prompt `From GitHub (<repo>@<sha7>): <message>`), GitHub's
  changes since the agreement applied on top of the world as it is now (a file both sides changed
  takes GitHub's; Orb's is the version before). Public repositories need no token: their head comes
  from git's ref list (`<repo>.git/info/refs`, not the API's anonymous quota) and their files from
  codeload. **Orb → GitHub**: each new version (any build's, a hand edit's) is committed to the branch
  with only the files that changed since the agreement, so files Orb never imported (node_modules,
  orb-kit/, oversized ones) stay; if the branch moved meanwhile, Orb first brings that in, then
  pushes the merge. Pushing (and reading private repositories) needs the owner's GitHub token,
  which connecting in You → GitHub (OAuth, or a pasted token) gives Orb, kept sealed
  (`orb_github_tokens`, AES-GCM from `ORB_SECRET`) until disconnected; no browser keeps one (a
  token a browser kept from before goes to Orb once, `moveBrowserToken()`). Without one the
  repository leads and Orb follows. With it, private repositories can be imported too. The
  owner's menu shows the repository and how syncing goes (`WorldFull.repo`, only for its owner);
  **Stop syncing** removes the link and leaves the repository.
- **The Orb kit** (`kit/`): runs any world on `localhost` exactly as Orb does: the same sandboxed
  frame and Orb's runtime (`src/lib/runtime/sdk.ts`, built into `lib/runtime.js` when published),
  files served under `/api/tree/<64 zeros>/` with Orb's headers. Its page does Orb's part of §7 in
  the browser: each tab is a player (`?player=<n>`, `?name=`), rooms join the tabs over a
  BroadcastChannel, `orb.store` is shared by the tabs (Orb's limits), saves are per player, the shop
  sells the page's own list through a sheet that charges nothing, invites open `?room=`, and the
  page reloads when a file changes. `orb dev [folder]`, `orb share` (the links that open the
  repository on Orb, `?import=` for a fork), `orb.d.ts` (types of `window.orb`).
  **`orb push`** (`kit/lib/push.mjs`, `src/server/kit.ts`) puts the folder on Orb as the person: to
  `orb.json`'s `world` when it is theirs (a new version, none when nothing changed), as their remix
  when it is someone else's public, remixable world (`orb.json` then names the remix, `remixOf` the
  original), else a new world (remixable; `orb.json` gets its `world` and `url`). Files go as a
  .tar.gz without dot files, `node_modules` and `test/`; what a world can't hold (`cleanPath`) is
  reported, never dropped quietly; with Playwright, a screenshot becomes the card. Signing in, once
  per computer: the kit gets a code (`POST /api/kit/login`), the person opens `/kit/<code>` where
  they use Orb and allows it (`POST /api/kit/approve`), and the kit's poll picks up a token
  (`orbk_…`, signed like a session, a year) that acts as that browser — its device, and its
  account if signed in — in `Authorization: Bearer` on any route. In a terminal the kit waits for
  the click; otherwise (agents, CI) it prints the link, exits 2, and the next push carries on.
  Kept in `~/.config/orb/credentials.json` (`ORB_CONFIG_DIR`), or `ORB_TOKEN`.
- **Shops in worlds**: a world can sell things for Orb
  credits through `orb.shop` (§7). Its page lists them with their prices; buying always goes
  through Orb's own sheet, at the price in Orb's saved copy of the page, and what's bought belongs
  to the account (one of each per world, on every device). Paid credits go first in worlds (Pro's:
  the month's, then packs; Free: packs, then the month's free credits, which stay for building),
  and the world's maker earns `ORB_SHOP_SHARE` (100%: Orb takes no fee for now) of the part that was paid for: free credits
  buy things too but earn nobody anything, so accounts made for their free credits pay nothing
  out. Orb's sheet says how much goes to the maker. Makers try their own things for free and hear when something sells. Earnings show
  on the plan card (in credits and ≈ US$, a credit being a cent) and can go into their own building
  (they become bonus credits: they pay for builds, and buy things in worlds without earning anyone anything, so earnings can't be passed on to be cashed out by someone else) or be cashed out to their bank (below). Orb's own worlds (VampireZ's 19 looks,
  100–500 credits, and Blood Pass+, 750, the plus track of every monthly Blood Pass; Bed Wars' 29
  looks, 100–500, and Bed Pass+, 750, the premium track of every monthly Bed Pass; Orbcraft's 24
  looks, 100–500, and Wild Pass+, 750, the plus track of every season's Wild Pass) keep their
  sales. An account spends at most
  `ORB_SHOP_DAILY` credits a day in worlds. Things are priced like Roblox's (a credit is worth
  about a Robux): the builders suggest 50–300 credits for most things, up to 1,000 for something
  special, so a month of Free credits buys a few things rather than a whole shop.
  Making money is said where makers look: before their first sale the plan card says "Make money
  with your worlds" (with **Add a shop**, which puts that request in the chat, when a world of
  theirs is on screen), the plans sheet says it too, and after a build the builders' three next
  ideas can include a shop for a game, or a world people come back to, that sells nothing yet.
- **Cash payouts** (`src/server/payouts.ts`), on the lines of Roblox's Developer Exchange: only
  credits **earned from other players** can be cashed out. Free credits never earn anything, a
  maker's own purchases are free and earn nothing, and what a maker's **own accounts** buy (a buyer
  who shares a device with them, from analytics' device keys of 180 days and the devices table, or a
  card, by Stripe's card fingerprints of their payments) earns credits to build with but never cash.
  Cashable earnings are those of sales older than `ORB_PAYOUT_HOLD_DAYS` (30, so a chargeback comes
  first) that weren't reversed. A cash-out needs at least `ORB_PAYOUT_MIN` credits (10,000: US$100;
  Roblox's minimum is 30,000 Robux, about US$114) earned from at least `ORB_PAYOUT_BUYERS` different
  players (10), and sends all that's payable: payouts only ever come out of cashable earnings (all of
  them together never exceed what other players' cleared purchases earned), building comes out of
  the ones that can't be cashed first. Every cash-out is a **request Orb checks** (Pulse lists them
  with what's behind each: how many players, the biggest buyer's part, what can't be paid out;
  approved with the admin token, `POST /api/admin/payouts/:id`), unless `ORB_PAYOUT_REVIEW=0`.
  Rejected, or refused by Stripe (e.g. Orb's balance is too low), the earnings are the maker's again;
  one cash-out is open at a time. **Reversals**: a refunded or disputed payment (Stripe's
  `charge.refunded`, `charge.dispute.created`, read back from Stripe) takes back the credits it
  bought (a pack's, in proportion; the balance may go below zero), flags its payer (nothing they buy
  is cashable again) and reverses what their purchases of the last 120 days earned makers, also when
  that was already used or paid out (the maker's earnings go below zero; later sales cover it).
  The first time, makers pick their bank account's country and Stripe onboards them (an Express
  account; one in another country than Orb's Stripe account only receives transfers); Orb then
  transfers from its own Stripe balance and Stripe pays out to their bank. A credit is a US cent;
  Orb's Stripe balance is in euros, so payouts are sent in euros at the European Central Bank's rate
  of the day (`ORB_USD_PER_EUR` fixes one). Whether an account can be paid is Stripe's word, read
  back before every transfer. A payout is 'requested' in the statement that takes the earnings, then
  'pending' once approved, 'paid' with its transfer, or 'failed'/'rejected' with the earnings given
  back; one whose answer was lost is looked up in Stripe by its metadata (and only then sent again)
  the next time the maker's billing is read. Payouts open by themselves once Orb's Stripe account
  has Connect (a request Stripe refuses either way tells: about the country with Connect, about
  Connect without it); `ORB_PAYOUTS=0` keeps them closed. The plan card shows what's ready and why
  not yet (the minimum, the players, the hold), **Cash out** (the amount in euros), a request on its
  way, and **Payouts** (Stripe's dashboard).
- **Your blob**: the character Orb gives people in worlds (`orb.visitors` without a world's own
  character: a soft blob, or a glowing orb up in the air) is theirs to dress, in the You tab (after their worlds). A
  color of the palette is free (guests' stays on the device); things to wear (`src/lib/looks.ts`:
  sprout, flower, party hat, bunny ears, top hat, halo, crown on the head; blush, round glasses,
  shades on the face; 50–750 credits, like Roblox's avatar shop: a Free month gets two or three,
  a Pro month most of them) are Orb's own, bought with credits like things in worlds (Orb keeps
  these sales, and they count toward the day's cap). Tap one to try it on, then **Get it**; it's put on
  right away, one per slot. The account's color and what it wears follow it to every device and
  into every world: presence carries it to the others in a room (a change shows within seconds),
  the default blob wears it (the orb its head thing), and worlds can read `orb.me.wears` and
  `v.wears` for characters of their own. Like name and color, presence is the sender's word.

## 3. Architecture

```
Browser (Next.js client)                              Vercel Functions (Node)            Supabase Postgres
┌──────────────────────────────────────────┐          ┌──────────────────────────┐       ┌───────────────┐
│ Orb UI (chat / explore / you)             │  fetch   │ /api/worlds/*  CRUD,fork │  SQL  │ orb_* tables  │
│ useBuild ── follows the build job ────────┼────────► │ /api/agent/jobs  builds  │──────►│               │
│     │            ▲ its output             │          │   (agents on Orb's AI    │       └───────────────┘
│     ▼            │                        │          │    or your own key)      │
│ WorldFrame (double-buffered sandboxed     │          │ /api/auth/passkey/*      │
│   iframe, srcdoc = world + orb runtime)   │          │ /api/github/* (optional) │
│   ⇅ postMessage bridge (storage, store,   │          └──────────────────────────┘
│     capture, errors, realtime room)       │
└──────────────────────────────────────────┘
```

- Worlds run in `<iframe sandbox="allow-scripts …" srcdoc=…>` **without** `allow-same-origin`
  → opaque origin, cannot touch Orb's cookies/localStorage. The injected **orb runtime**
  shims `localStorage`/`sessionStorage` (persisted per world per device by the parent, and for
  signed-in people in their account, `orb_saves`), and starts a world's workers from a data:
  script that loads their file (the file's origin isn't the frame's); `history.replaceState`/
  `pushState` keep their state but not a new address (a srcdoc frame's can't change). Websites shown as worlds (`kind: 'external'`)
  keep their own origin (`allow-same-origin`) and their own storage, partitioned by the browser
  under Orb's site; Orb can't see or move it.
- World code is stored in Postgres (`orb_worlds.code`), versions in `orb_world_versions`,
  thumbnails as `bytea` served through a CDN-cached route.
- AI: there is one kind of build. Every build is an agent job on the server (`/api/agent/jobs`,
  `src/server/agent/runner.ts`) that works on the world's files, saves versions as it goes and
  keeps going without the page, charged as it goes (§6). On Orb's AI it is Orb's own agent on
  Vercel AI Gateway (OIDC, no key), or on Anthropic when `ANTHROPIC_API_KEY` is set, or —
  without `ANTHROPIC_API_KEY` but with `ORB_CURSOR_KEY` — a Cursor Cloud Agent on Orb's own
  key: the agent gets and saves the world through the job's files link
  (`GET`/`PUT /api/agent/jobs/:id/files?t=<job token>`, only while the job runs; `src/server/agent/sync.ts`),
  as do builds on a person's own Cursor key (a world kept on GitHub gets their versions like any other's). Each edit shows up in the world as soon as the agent's
  stream reports it (`src/server/agent/mirror.ts`); each save becomes a version. The agent sees
  the world the way the in-house agent's `look` tool does: `sh .orb/look` sends its files as they
  are, without saving them, with what to do first (`POST /api/agent/jobs/:id/files/look`); the
  job's tick passes the look on to the page that watches the build (`src/server/agent/look.ts`),
  and the agent gets the report back with the screenshots as files in `.orb/seen/`.
  Free builds are guarded the way chatgpt.com's are: quotas per account, or per device and IP
  without one (`src/server/freetier.ts`), and Vercel BotID on free builds, signing up and signing
  in (`src/server/botid.ts`, `src/instrumentation-client.ts`; 403 `bot_detected`). What they may
  cost in a day is a budget in US$ (`src/server/budget.ts`), half of it for builds without an
  account, so those are asked to sign in before the free builder rests for everyone.
  Builds on the person's own key (Anthropic, OpenRouter with any model, OpenAI, Cursor) run the
  same way: the key is saved only in their browser, and the job keeps it encrypted while it runs.
- Realtime (multiplayer presence/broadcast): Supabase Realtime broadcast channels, connected
  by the parent page on demand and bridged to the world via postMessage.

### Environment variables
| var | meaning |
|---|---|
| `POSTGRES_URL` | Supabase pooled connection (set by integration). Absent → local PGlite in `.data/` |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | realtime (set by integration) |
| `ORB_SECRET` | HMAC secret for session cookies |
| `ORB_ADMIN_TOKEN` | admin API (verify/feature worlds) |
| `ANTHROPIC_API_KEY` | optional; if set, free tier uses Anthropic directly instead of AI Gateway |
| `ORB_MODEL` | optional; default `anthropic/claude-opus-5.5` (gateway id). Orb's AI is one model for everyone: Pro has more credits, not another model |
| `ORB_AI_EFFORT` | optional; Orb's AI's reasoning effort (default `low`; `medium`, `high`, `xhigh`) |
| `ORB_CURSOR_KEY` | optional; Orb's own Cursor API key: without `ANTHROPIC_API_KEY`, free agent builds run as Cursor agents on it |
| `ORB_CURSOR_MODEL`, `ORB_CURSOR_EFFORT` | optional; their Cursor model (default `claude-opus-5-5`) and effort (default `low`; with the model's smaller context, thinking on where it has the option) |
| `ORB_FREE_DAILY_PER_ACCOUNT` | optional; free build units per UTC day per account (default 30; 25 on Orb's Cursor key) |
| `ORB_FREE_DAILY_PER_DEVICE`, `ORB_FREE_DAILY_PER_IP` | optional; free build units per UTC day without an account, per device (default 12; 10 on Cursor) / per IP (default 40; 25 on Cursor; ×3 for the IP's accounts together). An IPv6 address counts as its /64. With `ORB_MOCK_AI=1` the daily caps are off unless set |
| `ORB_FREE_DAILY_USD` | optional; budget in US$ per UTC day for all free builds together (default 20; 0 = no free building), charged as builds go (exact from provider usage, estimated for Cursor agents and for a model call cut short; `src/server/budget.ts`, table `orb_spend`). Spent → running builds pause at their next model call, new ones get 503 `ai_unavailable` until UTC midnight |
| `ORB_FREE_DAILY_USD_ANON` | optional; the part of it builds without an account may spend (default half). Spent → those builds are asked to sign in (429), signed-in builds go on |
| `ORB_FREE_MAX_OUTPUT_TOKENS` | optional; longest reply of one free build (default 12000) |
| `STRIPE_SECRET_KEY` | optional; Stripe's secret key (`sk_test_…`/`sk_live_…`): Pro and credit packs can be bought (`src/server/stripe.ts`). Orb makes the Pro price (lookup key `orb_pro_month_usd_<cents>`), the portal's settings and, without `STRIPE_WEBHOOK_SECRET`, its webhook endpoint (from the production deployment only) itself, kept in `orb_meta` per key; a new key's endpoint replaces Orb's old ones at the same address (a rolled key, a database that forgot its endpoint). Without it Pro shows "Coming soon" and credits still apply |
| `ORB_STRIPE_SECRET_KEY` | optional; a Stripe secret key that wins over `STRIPE_SECRET_KEY` (which Vercel's Stripe integration manages and may overwrite), e.g. a live account's key for Production while previews keep the sandbox |
| `STRIPE_WEBHOOK_SECRET` | optional; the signing secret of a webhook endpoint you made yourself (`/api/billing/webhook`); Orb then registers none. `ORB_STRIPE_WEBHOOK_URL` sets the address Orb registers instead (tests) |
| `ORB_STRIPE_TEST_ACCOUNTS` | optional; with a sandbox's key (`sk_test_…`) on the production deployment, only these usernames (comma-separated) may check out (`payments` is false for everyone else); previews, local runs and live keys aren't limited |
| `ORB_GUEST_CREDITS`, `ORB_FREE_CREDITS` | optional; credits a month per device without an account (default 100; never shown in the app, so it can change) and per account on Free (default 300). A credit is US$0.01 of AI at the model's list price |
| `ORB_PRO_CREDITS`, `ORB_PRO_USD` | optional; Pro's credits a month (default 2000) and price in US$ a month (default 20) |
| `ORB_TOPUPS` | optional; the credit packs any account can buy, `usd:credits` comma-separated (default `10:800,25:2100,50:4200`) |
| `ORB_SHOP_SHARE`, `ORB_SHOP_DAILY` | optional; what part of the paid credits spent in a world's shop its maker earns (0–1, default 1), and the credits an account may spend in worlds in a day (default 2000) |
| `ORB_MOCK_AI=1` | local testing: builds follow a scripted agent (`src/server/agent/mock.ts`, no network, no cost) |
| `ORB_TRACE_DAYS` | optional; keep build traces (§8) this many days. Unset: forever |
| `ORB_EVENTS_PER_DAY` | optional; analytics events kept a day in all (default 20,000, about 1,400 visitors; each takes ~0.7 KB of database for 180 days), then the rest of the day's are dropped |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | optional; enables "Sign in with GitHub" OAuth for repo sync. Without them the UI offers a personal-access-token paste flow |
| `ORB_LAB_KEY` | the secret path of the lab pages `/lab/<key>` (hidden worlds, pulse, analytics, traces, backup). Without it production has no lab pages; locally the key is `dev-lab` |
| `NEXT_PUBLIC_SITE_URL` | optional; Orb's address (default `https://orbworld.vercel.app`, `SITE` in `src/lib/site.ts`) |
| `ORB_FORMER_ORIGINS` | optional; former addresses (origins, comma/space-separated) that hand people over to the site |
| `ORB_PASSKEY_RP_ID` | optional; the passkey RP ID on every Orb address (default `orbworld.vercel.app`). Never changes |
| `ORB_ORIGINS` | optional; more addresses serving this Orb unredirected (passkeys allowed, hand-offs may end there) |

### Addresses (moving to a new domain)

docs/operations.md "Moving to a new domain" has the steps; `src/server/origins.ts`, `src/server/move.ts`.
Code that needs Orb's own absolute URL uses `SITE`, never a literal.

- **Passkeys:** on the site, former and extra addresses the RP ID is `ORB_PASSKEY_RP_ID` and the
  expected origin the request's; other hosts (localhost, previews) use their own hostname.
  Browsers accept the RP ID away from its host through Related Origin Requests
  (`/.well-known/webauthn` lists the addresses). Where they can't, the options responses carry
  `home` and `src/lib/passkey.ts` makes the passkey there instead: a full-page round trip through
  `/move` at the *passkey home* (the address whose hostname is the RP ID) that returns signed in.
- **Hand-off:** on a former address, a page visit (`Sec-Fetch-Dest: document`) from a browser
  without the `orb_moved` cookie is redirected (`next.config.ts`) to
  `/api/move/start/<former host>/<path>` on the site, which sets a browser-bound state cookie and
  sends it to `<former>/move`. That page posts its `orb:*` localStorage (gzipped) to `/api/move`
  with its session; the site's `/move?code=…` claims it (only in the browser holding the state
  cookie, once, within 10 minutes), signs in, merges and lands on the path. All other requests
  for pages there get a 308 to the same path on the site; `/api/*`, `/_next/*`, `/.well-known/*`,
  `/dev/*`, `/move` and files are served as they are. Paths `/move`, `/api/move/*` and
  `/.well-known/*` are reserved.
- **What travels:** every `orb:*` localStorage entry, so per-browser state belongs in `orb:` keys.
  Merge (`src/lib/move.ts`): entries the new address lacks are set, the ones it has stay, except
  that a different carried `orb:device` wins together with `orb:name` and `orb:color` (the server
  moves the replaced key's worlds, handle and likes to it); `orb:chats` merge by thread id, the
  newer `updatedAt` winning with its `orb:chat:<id>`; id → value maps (`MAPS`: `orb:world-names`,
  `orb:ls-at`) are combined. Above `MAX_BUNDLE` the largest chats, then saved games
  (`orb:ls:<id>`), stay behind.

## 4. Directory layout & ownership

```
src/
  app/
    layout.tsx, globals.css, page.tsx (start), w/[id]/page.tsx, explore/page.tsx, pricing/page.tsx,
    w/[id]/opengraph-image.tsx, move/ (the hand-off card when Orb moves address)
    api/…                                 ← server routes
  components/
    orb/        Orb.tsx, OrbPanel.tsx, ChatView.tsx, ExploreSheet.tsx, YouView.tsx, …
    world/      WorldFrame.tsx, WorldBar.tsx
    ui/         small primitives (Button, Sheet, Glass, Icon…)
    Shell.tsx   the client app shell shared by all pages
  lib/
    types.ts            shared types (contract)
    local.ts            localStorage helpers (device key, name, settings, chats, keys)
    api.ts              typed client for /api (contract)
    templates.ts        template catalog metadata
    engine/protocol.ts  streaming parser of a build's output (pure)
    engine/prompt.ts    a build request: limits, validation, the chat made safe for every provider
    engine/client.ts    runBuild(): starts a build's agent job and follows its output
    engine/useBuild.ts  React hook following a world's builds (chat threads, previews, repair round)
    runtime/sdk.ts      orb runtime script (string) + injectRuntime()
    runtime/bridge.ts   parent-side message bridge (storage, store, room, capture, errors)
    analytics.ts        track(): product events → POST /api/events (§6 Analytics)
  state/tracking.ts     what the shell tracks from its stores (world opens and time, builds)
  server/
    db.ts, schema.ts, seed.ts, auth.ts, worlds.ts, ratelimit.ts, ai.ts, http.ts,
    origins.ts (addresses, passkey RP), move.ts (hand-off between addresses),
    credits.ts (plans, wallets), billing.ts + stripe.ts (Pro and packs through Stripe),
    shop.ts (orb.shop: purchases in worlds, makers' earnings)
    agent/              builds: runner.ts (the jobs), prompt.ts (the agents' system prompts),
                        cursor.ts (Cursor agents), workspace.ts (file tools), look.ts, mock.ts
    events.ts           what /api/events keeps; analytics.ts: the analytics page's queries
    reposync.ts         worlds kept in sync with a GitHub repository, both ways (§2 GitHub sync);
                        github.ts: a world's new repository; importer.ts: repositories as worlds
  data/
    seeds.json          curated external + original worlds
public/templates/blank.html, <id>.webp   the blank island, and Orb's pictures of the Originals (public/worlds/<name>.webp too)
src/data/originals.json Orb's Originals: what Orb says about each, its repository (orbworlds/<repo>) and branch
kit/                    the Orb kit (bin/orb.mjs: dev, test, share, push; lib/server.mjs, lib/host.html + host.js,
                        lib/browser.mjs, lib/smoke.mjs, lib/push.mjs, orb.d.ts), on npm as @orbworlds/kit
scripts/publish-kit.mjs the kit on npm (@orbworlds/kit, with Orb's runtime): the next version when it changed
scripts/sync-org.mjs    the orbworlds org: repositories' descriptions, links, topics, visibility; the profile
                        and the worlds' shared test (org-app.mjs: Orb's GitHub App)
scripts/game-shots.mjs  the Originals' screenshots, committed to their repositories
scripts/harness.mjs     what the test scripts share: checks, a `next dev` of their own, requests, passkeys
```

## 5. Data model (Postgres, all tables prefixed `orb_`)

See `src/server/schema.ts` for the DDL. Only Orb's server, as the tables' owner, reads and writes
them: every table has row-level security on with no policies, and Supabase's data-API roles
(`anon`, `authenticated`, whose key browsers get for Realtime) have no rights on them. Key table `orb_worlds`:
`id` (10-char base62, or a stable slug for seeds), `name`, `description`, `kind` ('native'|'external'),
`code`, `external_url`, `source_url`, `owner_device`, `owner_user`, `author_name`,
`visibility` ('public'|'private'), `forkable`, `forked_from`, `template`, `verified`,
`featured` (int sort weight), `tags` (text[]), `thumb` (bytea), `thumb_type`, `thumb_version`,
`thumb_url` (external), `plays`, `likes`, `forks`, `version`, `created_at`, `updated_at`, `origin`
(curated worlds, jsonb from `src/data/seeds.json`: their maker's post `postUrl` on `platform`, that
post's `views` and `likes`, the repository's `stars`, `postedAt`, the maker's `handle` and
`authorUrl`, the `prompt` they shared and what they `madeWith`; cards carry it as `origin`).

Explore lists `visibility='public'` worlds that have a thumbnail and a name other than
"Untitled world", as tiles that fill the screen edge to edge (2 columns on phones, 3 from 768px, 4
from 1280px, 5 from 1800px; while trending without a search the first tile leads, two columns wide,
and two rows tall from 768px). A tile is the world's picture (or preview; a quiet tint while it
loads) with its name and maker on it (in two columns, the name in up to two lines and the maker on
its own); hovered or focused, it also says what the world is (its description, never the prompt
it was made with: that's in the world's "How it was made") and how many played it (not when none).
A world with people in it right now always says so ("● 3 playing": `WorldCard.live`, from
`orb_here`). A tile is a link to the world: a click plays it in place, a click with a modifier key
(or the middle button) opens it in a new tab. The header (filters, always-visible sort, search)
stays at the top while scrolling the worlds. Sorts: Trending (default) and New (people's worlds
only, newest first: curated worlds arrive in batches and would bury them; with a filter, every world
of that kind, as people's worlds carry no kind).
People's own worlds join Trending once they've earned it: a like, 10 plays (`EARNED_PLAYS`) or Orb's
pick (`featured`, `verified`). A world just built (changed since it began: version 2 on) gets its first 2 days there
(`FRESH_DAYS`), wearing a "New" badge, so its first players can find it; Trending's fading boost for
new worlds does the rest. Untouched templates and bare copies wait. Otherwise they're under New,
in search and on their maker's page. Trending leads with Orb's own order of the curated worlds
(`src/lib/curation.ts`), each maker's spread out so none shows twice among four neighbours. Curated
worlds that don't hold up are `hidden` in `src/data/seeds.json` (playable by link). On touch
screens, worlds that need a keyboard (tagged `keyboard`) come after the others in each page (not in
a search). At home, Trending under All fills four rows under the lead, then **More** (when
there are more); a filter, New or a search shows all its worlds (more load as you scroll). A search
looks through every listed world (not only the ranked ones; no filter shows as picked, and picking
one ends the search): names and makers from the start of a word (found as they're typed),
descriptions and tags too from 4 letters on ("snow" finds snowy), by whole words or their plurals
below that ("car" finds cars, not a carpet). Names that match come first, then descriptions and
tags, then makers, each in the chosen sort. It shows all it finds; one that finds nothing says
"Nothing called “…” yet" with **Make it** (its words in the composer at the top, focused), then
what's trending.
`/explore` opens home at its worlds, all of them (more load as you scroll), and carries them in its
address (`?filter=games&sort=new&q=…`), which the server renders as asked. A new filter, sort or
search keeps the header where it is, its worlds starting right under it. Explore stays as it was
left (filter, sort, search, scroll) while a world is played: going back to it (the world's way back)
leaves the world (a build of one's own goes on in the background) and goes home (pushed, so the
browser's back returns to the world), down where it was left. Its filters: All, Games
(`tag=game`), Places (`tag=world`) and Art & toys (`tag=art,toy`), one category per world: the first of `game`, `world`, `art`/`toy` in its tags (a game has a goal, a
world is a place to wander, a toy is something to make or play with freely, or a scene to look at),
else its template's. The curated worlds name exactly one (`src/data/seeds.json`,
`src/data/originals.json`); the in-house agent says a new world's when it names it (`name_world`'s
`kind`), saved as its first tag if its tags name none.

The top worlds have a **live preview**: a few seconds of the world as a looping video
(`public/previews/<id>.mp4`, listed with a hash of each file in `src/data/previews.json`, recorded by
`scripts/previews.mjs`, or cut from the video in its maker's post by `scripts/previews-from-post.mjs`). Their cards in Explore and in the start screen's row play it muted over the
thumbnail while the card is on screen, and pause it when it isn't. The video only loads once the card
scrolls into view, and fades in once it plays. With `prefers-reduced-motion` or Save-Data the
thumbnail stays still.

`orb_here` (`who`: 'u:<account>' or 'd:<device hash>', `world_id`, `at`): who is in which public world
right now, one row each, from that heartbeat; stale rows are swept.

GitHub sync (§2): `orb_world_repos` (one per linked world: `repo`, `branch`, `root` (where the
world's files are in the repository), `synced_sha` and `synced_tree` (what both sides last agreed
on), `checked_at`, `pulled_at`, `pushed_at`, `state` ('ok'|'readonly'|'error') and `note`), and
`orb_kit_logins` (the kit signing in, 10 minutes: `code`, `poll_hash`, the token sealed once
allowed, `name`).
`orb_github_tokens` (`owner`: 'u:<account>' or 'd:<device hash>', `login`, `token_enc`, sealed, `auto`:
keep every world of theirs on GitHub).

Build traces (§8, `src/server/traces.ts`; no foreign keys, they outlive jobs and worlds):
- `orb_traces`: one row per build run. `id` (the job's id), `group_id` (the chat turn), `kind`
  ('agent'|'cursor'|'build'|'direct'), `world_id`, `owner_device`, `owner_user`, `provider`, `model`,
  `mode`, `prompt`, `status` ('running'|'done'|'failed'|'cancelled'), `error`, `steps`, token totals
  (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`),
  `started_at`, `ended_at`, `duration_ms`, `meta` (effort, repair round, versions and looks counts…).
- `orb_trace_events`: its timeline, `(trace_id, seq)`. `at`, `type`, `summary` (small jsonb, for
  queries and lists), `payload` (the whole event as gzipped JSON), `size` (unzipped bytes).
- `orb_trace_blobs`: system prompts, world files and screenshots, stored once. `sha` (sha256 of
  the bytes), `data`, `size`, `media_type`, `used_at`. Payloads point at them as `"orb-blob:<sha>"`
  (a world's files as `{ path: sha }`).

Product analytics (§6 Analytics) are rows of `orb_events`, kept 180 days: `id`, `at` (the
server's clock: when the batch came, less how long before that the browser says it happened),
`name`, `device` (the device key's hash), `user_id` (the signed-in account), `session` (the tab's
visit), `path` (no query string or fragment), `world_id`, `props` (jsonb: flat, ≤ 2 KB),
`referrer` (another site, on a tab's first page view), `country` (Vercel's geo header), `mobile`.
Indexed on `at`, `(name, at)` and `(device, at)`.

Friends (`src/server/friends.ts`): `orb_friends` is one row per pair of accounts, `(a, b)` with
the smaller id first in byte order (as JavaScript compares strings; the check uses `collate "C"`),
`requested_by`, `status` ('pending'|'friends'). `orb_presence`: per account, the `world_id` on
screen at the last heartbeat, `at`, `away` (its page went away since) and `rooms` (jsonb
`[{ room, peer }]`, ≤ 8: the rooms of that world the page is in, '' for its own, with its peer
id in each). `orb_notifications`:
`user_id`, `kind` ('friend_request'|'friend_accepted'|'invite'|'remix'|'sale'), `actor_id` (null
for a remixer without an account, whose remix's author name stands in, and for sales: buyers stay
anonymous), `world_id` (invites: the world; remixes: the remix; sales: the world), `detail` (sales:
`{ count, credits, item }`: one unread note per world adds up for a day), `created_at`, `read_at`;
the last 30 days are shown. All go with their accounts.

Plans and credits (`src/server/credits.ts`, `src/server/billing.ts`): `orb_wallets` is one row
per payer (`payer`: `u:<user id>` or `d:<device hash>` without an account), in millionths of a
US$ (a credit is 10,000): `plan` ('free'|'pro'; devices are guests), the period of the plan's
credits (`period_start`, `period_end`: the UTC month, or the Stripe subscription's), its
`allowance_micros` and `used_micros`, `topup_micros` (bought packs; may go below 0 after a
build's last step), `bonus_micros` (credits given, not bought: earnings put into building, and plan
credits a refund gives back after their period; builds take plan credits, then bonus, then top-ups,
and a build's refund gives top-ups back only what it took from them, `orb_agent_jobs.charged_topup_micros`;
in worlds' shops bonus credits, like free ones, earn nobody anything), `earned_micros` (what the account's worlds' shops earned it, not yet used) and
`earned_total_micros` (all it ever earned), and for Pro `stripe_customer`, `stripe_subscription`,
`sub_status`, `cancel_at`, `synced_at`. `orb_credit_log` notes what moved credits (`kind`: 'build' |
'refund' | 'topup' | 'earnings' (earnings put into building), `micros`, `ref`: the job or the
checkout; unique per kind and ref, so a refund or a pack counts once). `orb_agent_jobs.charged_micros`
is what a job has charged its maker so far.

Shops (`src/server/shop.ts`): `orb_purchases` is one row per thing an account owns in a world,
`(world_id, item_id, buyer_user)` unique: `item_name`, `seller_user` (the world's owner when it
sold; null for Orb's worlds and the maker's own), `price_micros`, `paid_micros` (the part from paid
credits), `earned_micros` (the maker's share of it), `status` ('pending' while the credits are
taken, then 'done'; a pending row older than a minute was cut off and goes), `test` (the maker's
own, free), `created_at`. Rows stay when the world goes (no reference); they go with the buyer.
Orb's own looks for the blob are rows of `world_id` `'orb:looks'` (never a world's id; no seller),
and `orb_users.look` is the account's blob: `{ "color", "wear": [look ids] }` (`src/server/looks.ts`).

Payouts (`src/server/payouts.ts`): `orb_payout_accounts` is one row per account with a Stripe
Express account (`stripe_account`, `country`, `ready`: transfers active and payouts enabled, as
Stripe last said, `synced_at`); `orb_payouts` one row per payout (`id` `po_…`, `user_id`,
`stripe_account`, `micros` of earnings, `amount` in the currency's cents, `currency`, `usd_per`,
`status` 'requested'|'pending'|'paid'|'failed'|'rejected' (one requested or pending per account),
`transfer`, `error` (also the reason of a rejection), `reviewed_at`, `created_at`; kept when the
account goes, for the books). A paid payout is also an `orb_credit_log` row of kind 'payout'
(negative micros); a refunded or disputed pack takes its credits back as kind 'topup_back' (ref: the
charge). `orb_cards` holds the cards each payer paid with (`payer`, Stripe's `fingerprint`), and
`orb_wallets.flagged_at`/`flag_reason` a payer whose payment was refunded or disputed;
`orb_purchases.reversed` a purchase whose earnings were taken back.

`orb_saves` keeps signed-in people's progress in Orb's worlds: `(user_id, world_id)`, `data` (the
world's localStorage as JSON text), `size`, `at` (when the browser saved it; the newer copy wins).
An account keeps at most 400 worlds' saves and 30 M characters in all.

`orb_moves` holds hand-offs waiting at the new address (§3 "Addresses"): `code_hash` (sha256 of
the single-use code), `state_key` / `state_hash` (the browser's state cookie), `user_id`,
`device_hash`, `data` (the packed `orb:*` storage, opaque to the server), `pack`
('gzip'|'json'|'none'), `expires_at` (10 minutes).

## 6. HTTP API (JSON unless noted)

All requests from the client send `x-orb-device: <deviceKey>` (see `lib/local.ts`) and the
session cookie (same-origin). Errors: `{ error: string, message?: string, retryAfter?: number }`.

| method & path | body / query | response |
|---|---|---|
| `GET /api/config` | | `ApiConfig` |
| `GET /api/me` | | `MeResponse` (an account's `user` has its blob's `look`: `color`, `wear`) |
| `PATCH /api/me` | `{ name }` | `MeResponse` |
| `GET /api/worlds` | `?sort=trending\|featured\|popular\|played\|liked\|views\|new&q=&tag=&verified=1&limit=&cursor=&mine=1` (tag matches tags, kind, or a category (above); `q` matches words (above), names first; `remixable=1`: only Orb worlds anyone may remix; `mine` includes private + untitled) | `{ worlds: WorldCard[], nextCursor?: string }` |
| `POST /api/worlds` | `CreateWorldInput` | `{ world: WorldFull }` |
| `GET /api/worlds/:id` | | `{ world: WorldFull }` (404 if private & not owner; `remixes`: its changed public remixes; `size`: bytes of its files, for a multi-file world: over 25 MB, the world says while it opens that it can take a minute, its preview playing behind its name) |
| `GET /api/worlds/:id/remixes` | | `{ worlds: WorldCard[] }`: its public remixes their makers changed (version > 1), newest first, ≤ 24 |
| `PATCH /api/worlds/:id` | `UpdateWorldInput` | `{ world: WorldFull }` (owner only) |
| `DELETE /api/worlds/:id` | | `{ ok: true }` |
| `GET /api/worlds/:id/zip` | | `application/zip`: the world's files (its index.html when it has no tree), for the owner or when it can be remixed; else 404. A visitor's world menu and the owner's Share sheet offer it ("Download .zip") (Orb has no code panel: a world's files change through its builds) |
| `GET /api/worlds/:id/versions` | | `{ versions: WorldVersionInfo[] }` |
| `GET /api/worlds/:id/versions/:v` | | `{ version: number, code: string }` |
| `POST /api/worlds/:id/fork` | `{ authorName? }` | `{ world: WorldFull }` |
| `POST /api/worlds/:id/github` | owner; `{ action: 'sync' \| 'create' }` | `{ world: WorldFull }`: `sync` brings in the linked branch's new commits and sends Orb's new versions now; `create` puts the world in a new private repository of the owner's (their token kept on Orb) and links it. 400 `github_required` / `github_failed`, 409 already linked |
| `DELETE /api/worlds/:id/github` | owner | `{ world: WorldFull }`, no longer synced (the repository stays) |
| `GET /api/me/github` | | `{ login, auto }` or `{ login: null }`: the viewer's GitHub connection |
| `POST /api/me/github` | `{ token?, auto? }` | `{ login, auto }`: a token once GitHub accepts it (kept sealed); `auto` turns Keep every world on GitHub on or off (400 `github_required` before connecting). `DELETE` forgets the token → `{ login: null }` |
| `GET /api/cron/github` | (anyone; rate limited) | `{ checked }`: linked worlds not checked for 10 minutes, a few at a time |
| `POST /api/kit/login` | (rate limited by address) | `{ code, poll, url }`: the kit starts signing in; `url` is `/kit/<code>` |
| `GET /api/kit/login?poll=` | | `{ token, name }` once allowed (once), 202 `{ status: 'pending' }`, 404 expired (10 minutes) |
| `POST /api/kit/approve` | `{ code }`, as the browser allowing it | `{ name }` (null without one); 404 expired, 409 already allowed |
| `POST /api/kit/push?world=&name=&message=` | `Authorization: Bearer <kit token>`, body: the files as a .tar.gz with `index.html` at the top | `{ world: WorldFull, outcome: 'created' \| 'remixed' \| 'updated' \| 'unchanged', skipped, url }` (§2 "The Orb kit"). 400 `push_failed`, 401 `kit_login`, 404 not theirs and not remixable; 120 an hour |
| `POST /api/worlds/import` | `{ url }` (a GitHub repository, optionally `/tree/<ref>/<dir>`; private ones with the importer's token kept on Orb) | `{ world: WorldFull, files, warning? }`: its files become a new world of the importer's (no `orb-kit/`, `node_modules`, `.git`…), linked to the repository (and, imported from a branch, kept in sync with it: `world.repo`), with its license (remixable only with one). Import maps that load three.js from `node_modules` are rewritten to jsdelivr, code that imports packages by name with no import map gets one (three, `three/webgpu` and `three/tsl` from jsdelivr, the rest from esm.sh at the version range package.json asks for, sharing that three), stylesheets a module imports become links, JSON it imports is imported as JSON, `import.meta.glob` lists the matching files (or, `eager`, imports them), `import W from './w.js?worker'` makes workers of that module and `import.meta.env` reads as a production build's, TypeScript (`.ts`) has its types stripped and is served as `.js`, imports without a file extension get it, modules that run in workers import packages by their address (workers have no import map), a Vite project's `public/` (a `vite.config`, or Vite in package.json) is also served at the top, and root-absolute `src`/`href` (in import maps, in stylesheets' `url()`, and in code, `'/path'` strings of a file or a top folder of the tree) become relative so they follow the tree `<base>`. An `orb.json` naming a public, remixable world (`world`) makes it a remix of that world (see §2 "Open-source games"). 400 `bad_request` / `import_failed`; 12 an hour |
| `PUT /api/worlds/:id/thumb` | raw `image/webp\|jpeg\|png` body ≤ 500 KB | `{ thumbVersion: number }` |
| `GET /api/worlds/:id/thumb?v=` | | image bytes, `Cache-Control: public, max-age=31536000, immutable` |
| `POST /api/worlds/:id/play` | | `{ plays }` (deduped per device/day; shown as "plays") |
| `POST /api/worlds/:id/like` | | `{ liked, likes }` (toggle) |
| `POST /api/worlds/:id/store` | `StoreRequest` | `{ value }` |
| `GET /api/worlds/:id/shop` | | `ShopView`: what the saved world sells (`items`: id, name, price, emoji, description), what the viewer owns there, their `credits` and how many of them are `paid` for (null signed out), `mine`, `signedIn`. 404 for a private world that isn't yours |
| `POST /api/worlds/:id/shop` | `{ item, price }` (signed in) | `ShopBought` (`item`, `owned`, `charged`, `credits`, `already`). 401 `account_required`, 404 `unknown_item`, 409 `price_changed` (with `price`) or `busy`, 402 `no_credits` (with `need`), 429 `daily_limit` or 30 tries in 10 minutes |
| `GET /api/looks` | | `LooksView`: Orb's things for the blob (`items`: id, name, `slot` head\|face, price), what the account `owned` and its `look` (`color`, `wear`), its `credits` (null signed out), `signedIn` |
| `PATCH /api/looks` | `{ color?, wear? }` (signed in) | `LooksView`. `color`: one of the palette or null (the device's own); `wear`: things the account has, one per slot. 400 `invalid_color`, 403 `not_owned` |
| `POST /api/looks/buy` | `{ item, price }` (signed in) | `LooksView`, with the thing bought and put on (in its slot). Orb keeps the sale; otherwise as buying in a world (401, 404 `unknown_item`, 409 `price_changed`, 402 `no_credits`, 429 `daily_limit`, the same 30 tries in 10 minutes) |
| `POST /api/agent/jobs` | `BuildRequest` (`worldId` required); the person's own key: `x-orb-agent-provider` (anthropic\|openai\|openrouter\|cursor), `x-orb-agent-key`, `x-orb-agent-model`, `x-orb-agent-effort` | starts a build (every build is an agent job) and streams its output (§8), the job's handle first. 400 `bad_request` (no world) or `bad_key`; 404; 429 `{error:'rate_limited', retryAfter}` (also with 3 builds running); 503 `{error:'ai_unavailable'}`; on Orb's AI: 403 `{error:'bot_detected'}`, 402 `{error:'out_of_credits', plan}` |
| `GET /api/agent/jobs/:id` | `?from=N` | the job's output from character N, then live (after a reload, a dropped connection or a request's time limit). This, Stop and answering its looks are only for whoever started the job (its device, or account); anyone else gets 404 |
| `POST /api/agent/jobs/:id/cancel` | | Stop: `{ ok }`; the job ends within a moment and keeps what it saved |
| `GET /api/billing` | | `BillingInfo`: the viewer's `plan` (guest\|free\|pro), `credits` (`left`, `monthly`, `used`, `topup`, `periodEnd`, `cancelAt`, `pastDue`; the app shows them to accounts only), `payments` (Stripe set up), `manage` (has a Stripe customer), `earnings` (accounts: `credits` earned in their worlds' shops and not yet used, `total` ever, and `payouts` once they're open: `account` none\|pending\|ready, `payable`, `minimum`, `holdDays`, `buyers` and `minBuyers`, `requested`, `paid`, `currency`, `usdPer`, `country` from the connection), and the `plans` (Free's and Pro's credits, Pro's price, packs, `typicalBuild`, `shopShare`: what makers earn of paid credits spent in their worlds) |
| `POST /api/billing/checkout` | `{ item: 'pro' \| <pack id>, from? }` (signed in; packs on any plan) | `{ url }` of a Stripe Checkout page (back at `/api/billing/return`, or `from` if cancelled). 401 `account_required`, 409 `already_pro`, 503 `payments_off`. A Stripe customer the account doesn't have (another Stripe account's, from before Orb's key changed) is forgotten and the checkout starts without it |
| `POST /api/billing/payouts/setup` | `{ country, from? }` (signed in) | `{ url }` of Stripe's onboarding for the account's payouts (its Express account made in `country` the first time), back at `/api/billing/payouts/return`. 400 `bad_country` / `country_unsupported`, 503 `payouts_off`. `GET ?to=` (Stripe's refresh link): a fresh onboarding page, by redirect |
| `GET /api/billing/payouts/return` | `?to=<path>` | reads the payout account from Stripe, then 303 to `to` with `?billing=payouts` (ready) or `payouts-pending` |
| `POST /api/billing/payouts` | (signed in) | `{ payout: { credits, amount, currency, requested, pending }, billing: BillingInfo }`: all that's payable, as a request for Orb's check (or sent at once with `ORB_PAYOUT_REVIEW=0`). 409 `payout_setup` (none, or not finished with Stripe), `below_minimum` (too few credits or players) or `payout_open`, 502 `payout_failed` (the earnings stay), 503 `payouts_off`; 10 an hour |
| `GET /api/admin/payouts` | `x-admin-token` | `{ requests }`: cash-outs waiting for Orb's check, oldest first: the maker, credits, amount and currency, the bank's country, and what's behind it (`sales`: cashable sales, `buyers`, `topBuyerShare`, top `worlds`; `excluded` and `reversed` credits) |
| `POST /api/admin/payouts/:id` | `{ action: 'approve' \| 'reject', note? }` + `x-admin-token` | `{ status }`: approved, sent now (`paid`, or `pending` when Stripe's answer was lost); rejected, the earnings go back. 404 when it isn't a waiting request, 409 `payout_setup` (Stripe can't pay the account: the earnings go back), 502 `payout_failed` |
| `POST /api/billing/payouts/dashboard` | `{ from? }` (signed in) | `{ url }`: Stripe's dashboard for the account's payouts (onboarding while unfinished). 404 without a payout account |
| `POST /api/billing/earnings` | (signed in) | `BillingInfo`: what the account's worlds earned becomes bonus credits to build with (`credits.bonus`) |
| `POST /api/billing/portal` | `{ from? }` (signed in) | `{ url }` of Stripe's customer portal (cancel at the period's end, card, invoices). 404 without billing (also when the Stripe account doesn't have the customer: Orb forgets it) |
| `GET /api/billing/return` | `?session_id=cs_…&to=<path>` | applies the checkout, then 303 to `to` with `?billing=pro\|topup\|pending` |
| `POST /api/billing/webhook` | a Stripe event, signed (`Stripe-Signature`) | 200 `{ received }`; 400 `bad_signature`. Checkouts, subscriptions (read fresh from Stripe) and invoices |
| `POST /api/auth/passkey/register/options` | `{ name }` | WebAuthn options (+ `home`: the passkey home, where this address needs Related Origin Requests). 403 `bot_detected`; 429 (also after 50 new accounts a day per IP) |
| `POST /api/auth/passkey/register/verify` | attestation | `MeResponse` (sets cookie) |
| `POST /api/auth/passkey/login/options` | | WebAuthn options (+ `home`, as above) |
| `POST /api/auth/passkey/login/verify` | assertion | `MeResponse` (sets cookie) |
| `POST /api/auth/signup` | `{ username, password }` | `MeResponse` (sets cookie; claims this device's worlds, which move to `/<username>/…`). 400 `bad_username`/`bad_password`, 403 `bot_detected`, 409 `username_taken`, 429 (30 tries an hour per IP, 50 new accounts a day per IP) |
| `POST /api/auth/signin` | `{ username, password }` | `MeResponse` (sets cookie). 401 `wrong_password`; 403 `bot_detected`; 429 after 12 tries per username (40 per IP) in 15 min |
| `POST /api/auth/password` | `{ password }` (signed in) | `MeResponse`: sets or changes the password |
| `POST /api/admin/password` | `{ username, password }` + `x-admin-token` | `{ ok, username }`: resets a forgotten password |
| `POST /api/admin/stripe` | `x-admin-token` | `StripeStatus`: checks Orb's Stripe key — `connect` (makers' cash payouts are open), `live`, the `account` it reaches (`id`, `name` and statement `descriptor` as Checkout and card statements show them, `country`, `currency`, `charges`, `payouts`, `due`) — and makes what a first checkout would: the Pro `price`, the `portal` settings, the `webhook` (from the production deployment); `problems` lists what didn't work |
| `POST /api/auth/logout` | | `{ ok: true }` |
| `GET /api/people/:handle` | | `{ profile: Profile }`: the maker at `/<handle>`, their public worlds and how the viewer stands with them (`friend`: none\|you\|requested\|incoming\|friends; where they are only for friends). 404 for no one |
| `GET /api/friends` | signed in (else 401 `signed_out`) | `FriendsData`: `friends` (online, `seenAt`, `world` on screen when public, `own`, `rooms` of it they're in), `incoming`, `outgoing`, `notes`, `unread` |
| `POST /api/friends` | `{ username }` | `{ state, person, friends: FriendsData }`. 400 `self`, 404 for no one; 30 an hour |
| `POST /api/friends/:id` | | accept their request → `{ friends }` (404 if there's none) |
| `DELETE /api/friends/:id` | | unfriend, decline or take back a request (with the notes between the two) → `{ friends }` |
| `POST /api/friends/sync` | `{ worldId, rooms? }` (null: none on screen; `rooms`: `[{ room, peer }]`, the page's peer id in each room of it) | the heartbeat → `FriendsData`. `{ leave: true }` (a beacon as the page goes) → offline at once |
| `POST /api/friends/invite` | `{ worldId, to: [friend ids] }` | `{ invited }` (friends only, once per world per 10 min). 400 `private_world`; 30 an hour |
| `POST /api/friends/read` | `{ ids? }` | `{ ok }`: those notes (or all) are read |
| `GET /api/friends/worlds` | | `{ worlds }`: friends' newest listed worlds |
| `GET /api/saves` | signed in (else 401 `account_required`) | `{ saves: [{ worldId, at, size }] }`: the worlds the account has progress for, newest first |
| `GET /api/saves/:worldId` | `?since=<ms>` | `{ data, at }` when the account's copy is newer than `since`; else 204 with `x-orb-save-at` (the account's time, 0 for none) |
| `PUT /api/saves/:worldId` | `{ data: { key: value }, at }` | `{ saved: true, at }`, or `{ saved: false, reason: 'older', at }` when the account's copy is as new or newer. 400 (values must be strings, within the world storage cap), 404 no such world, 413 `saves_full`; 1,200 an hour |
| `GET /.well-known/webauthn` | | `{ origins: string[] }`: the addresses allowed to use Orb's RP ID |
| `GET /api/move/start/<former host>/<path>` | `?<query>` | site only: 302 to `<former>/move?s=…&back=…&to=…`, sets the state cookie `orb_move_<key>` |
| `POST /api/move` | packed `orb:*` storage; headers `x-orb-move`, `x-orb-back`, `x-orb-to`, `x-orb-pack`, `x-orb-device?`, `x-orb-dropped?` | former addresses only: `{ url }` (the site's `/move?code=…`), sets `orb_moved`. With `x-orb-passkey: 1` at the passkey home: sends the session back. 429 after 30 per 10 min |
| `POST /api/move/claim` | header `x-orb-move-code` (+ `x-orb-device`) | the packed storage (`x-orb-pack`: gzip\|json\|none), sets the session cookie. 410 `move_expired`, 403 `move_mismatch` (another browser; uses the code up) |
| `POST /api/move/passkey` | `{ kind: 'signin'\|'signup', name?, to }` | `{ url }` of the passkey home's `/move` (sets the state cookie) |
| `GET /api/github/login` → GitHub → `GET /api/github/callback` | | redirects to `/#gh_token=…` (only if OAuth configured), which the page gives to `POST /api/me/github` |
| `POST /api/admin/worlds/:id` | header `x-admin-token`; `{ verified?, featured? }` | `{ ok: true }` |
| `POST /api/here` | `{ worldId }` (null: left) | `{ ok }`: "I'm in this world", sent every 45 s while a public world is on screen (and null when it no longer is); a world's cards count who did in the last 90 s (`live`) |
| `POST /api/admin/credits` | header `x-admin-token`; `{ handle, credits, ref }` | `{ given, wallet }`: gifts the account (or the guest, by its device's handle) bonus credits (they build but can't be cashed out), once per `ref` |
| `POST /api/events` | `{ sent, mobile?, device?, events: [{ name, t, session, path?, world?, props?, ref? }] }` (≤ 50 events; `t` and `sent` are the browser's epoch ms) | always 200 `{ accepted }` (see Analytics below) |

Ownership rule (`canEdit`): viewer's session user owns the world, or the viewer's device hash
owns it, or the viewer's device is linked to the world's owner user.

Builds on Orb's AI check the builder's credits first (402 `out_of_credits` when none are left;
`message` says what next for their plan) and are charged as they go, for what each model call
used: after each call, or when it is cut short (Stop, a time limit, a failure after it started
writing) at an estimate of the prompt it read and what it wrote (`cutCallUsd` in
`src/server/budget.ts`; Cursor agents are estimated from their stream all along). So a stopped
build costs what it used. The job's output carries a control frame `{ t: 'credits', used }`
(what the build used so far) after each charge and at the end; the chat doesn't show it (the
plan in the You tab has the balance). Builds have no time limit: Cursor runs that hit Cursor's 30 minutes are continued, and a
build ends when it's done, paused when the credits or the day's free budget run out. Every build
on Orb's AI uses the same model, Free or Pro.

Builds (`/api/agent/jobs`) also send `x-orb-trace-group: <chat message id>`,
so a build and its repair round share a trace group. The lab's trace pages (key: `ORB_LAB_KEY`,
`src/server/lab.ts`; a wrong key → 404, never indexed):

| path | query | response |
|---|---|---|
| `GET /lab/<key>/traces` | `?status=&kind=&provider=&q=` (words in the prompt) `&page=` | the traces, newest first, with totals (HTML) |
| `GET /lab/<key>/traces/<id>` | | one trace: its facts, the other rounds of its chat turn, its whole timeline (HTML) |
| `GET /lab/<key>/traces/blob/<sha>` | | a stored blob: images as themselves, anything else as sandboxed `text/plain`; `immutable` |
| `GET /lab/<key>/traces/export` | `?id=` or the list's filters, `&since=<date>&limit=` (default 200, ≤ 2000), `&images=1` | `application/x-ndjson` download: one trace per line with all its events, payloads decoded and system prompts written out; screenshots as `orb-blob:<sha>` (data URLs with `images=1`), world files as `{ path: sha }` (each at the blob route). Newest `limit`, oldest first; with `since`, the first `limit` from then |
| `GET /lab/<key>/backup` | `?since=<YYYY-MM-DD>` (default: the first day with events) | `application/x-ndjson`: `{ type: 'pulse', … }` (Pulse as of now), `{ type: 'problems', rows }` (every recorded problem), then one `{ type: 'events', day, rows }` per UTC day with analytics events. With the traces export and the blob route, what the nightly backup copies (`scripts/backup.mjs`, `.github/workflows/backup.yml`) |

### Analytics

Orb counts what people do with its own events, next to Vercel's Web Analytics (page views only).
`track(name, props)` (`src/lib/analytics.ts`) queues an event; the queue goes to `POST /api/events`
every 4 s, and at once through `navigator.sendBeacon` when the tab is hidden or closed (a beacon
can't set headers, so the device key rides in the body as `device`). Each event carries the tab's
visit (`session`: kept in sessionStorage across reloads, a new one after 30 minutes out of sight),
the path, and the world on screen unless its props name one in `world_id`. Nothing is tracked on
`/lab` and `/dev`. The server keeps only the device's hash and drops, quietly, events that are
cross-site, from bots or headless browsers, malformed (names `^[a-z][a-z0-9_]{1,39}$`, props flat
strings/numbers/booleans/nulls ≤ 2 KB) or over the limits (600 per IP every 10 minutes,
`ORB_EVENTS_PER_DAY` a day in all).

`/lab/<ORB_LAB_KEY>/analytics` (linked from Pulse; `?days=30` for 30 days) shows, per UTC day:
visitors (devices), new and returning, visits, page views and how long visits last; how far the
people who first came in those days got (opened a world → sent a prompt → finished a build → came
back another day); worlds by opens and time in them, with where they were opened from; events;
where visits come from (the referring site or `utm_source`); phones and computers; countries; and
everyone who came, each with a timeline at `/lab/<key>/analytics/person/<public device id>`.

| event | when | props |
|---|---|---|
| `page_view` | a page loads, the app goes to another address (not when it only rewrites it), back/forward | the tab's first: `landing: true`, `utm_source`, `utm_medium`, `utm_campaign` (and the referring site) |
| `world_open` | a world is opened | `source`: `home` (the home page: its worlds, with `filter`, `sort`, `q`, or its row of friends' and the person's own, with `tab`: `friends` \| `mine` and its `position`), `chat`, `my_worlds`, `liked`, `remixed_from`, `built` (a build finished elsewhere), `friend` (joining a friend; `room: true` when into the room they're in), `invite`, `profile`, `remixes` (a world's remixes sheet), `remix_note` (a note that your world was remixed), or by address: `link`, `reload`, `back` |
| `invite_open` | a world opened from someone's share link (`?with=`) | `by` (their handle), `signed_in`, `friend` (how the visitor stands with them) |
| `remixes_open` | a world's remixes sheet opens | `remixes` (how many) |
| `clip_record` | a clip is recorded (or couldn't be) | `ok`; `type`, `kb`; or `error` |
| `clip_share` | a clip is shared or downloaded | `how`: `native` \| `download` |
| `world_leave` | a world stops being seen (another world, the start canvas, the tab hidden or closed) | `seconds` it was on screen, `why`: `left` \| `hidden` |
| `world_error` | the world on screen throws (the first five different errors per page load) | `message` (first 200 characters), `line` |
| `prompt_send` | a prompt is sent | `where`: `hero` \| `chat` \| `suggestion`, `text` (first 200 characters), `length`, `provider` (`free` or the person's own), `model`, `is_new_world`, `mode`: `build` \| `ask` |
| `build_done` | a build ends, on screen or in the background | `status`: `done` \| `error` \| `stopped`, `seconds`, `steps`, `saved` (made a version), `repair`, `error` (first 120 characters), `background` |
| `build_undo` | a build is undone | |
| `remix` | a world is remixed (Remix in its world bar, or under a guide's answer) | `world_id` (the copy), `from_world`, `how`: `button` \| `build` |
| `remix_offer` | Remix under a guide's answer in someone else's world | `world_id`, `with_request` (the change they asked for is built in the copy) |
| `like` | like or unlike | `liked` |
| `history_restore` | an earlier version is brought back | `version` |
| `world_download` | the world's files are downloaded as a .zip | |
| `explore_open`, `explore_filter`, `explore_sort`, `explore_search` | Explore opens; a filter is picked; a sort is picked; a search's results arrive | `filter`; `sort` (with the `filter`); `q` (first 100 characters), `results` (null when it failed) |
| `explore_back` | a world's "Explore" button (to Explore) | `world_id` |
| `share_open`, `share_copy` | the share sheet opens; the link is copied or shared | `how`: `copy` \| `native`, `where`: `bar` \| `sheet` |
| `world_import` | a world is imported from a repository | `files` |
| `payout_setup` | the plan card's Continue with Stripe (or Finish payout setup) | `country` (null: continuing) |
| `payout_setup_done` | back from Stripe's payout onboarding | `ready` |
| `payout` | a cash-out asked for (or sent) | `credits`, `currency` |
| `remix_link` | a `?remix` link (an open-source game's README) opened its world's chat | `world_id` |
| `import_link` | an `?import=` link (the kit's `orb share`) opened the import form | `repo` (`owner/name`) |
| `sign_up`, `sign_in`, `sign_out` | account made, signed in, signed out | `where`: `you` \| `share` \| `profile`; `method`: `password` \| `passkey` |
| `key_added` | the person adds their own model key | `provider` (never the key) |
| `checkout_start`, `checkout_done` | Go Pro or a credit pack is clicked (on to Stripe); back from paying | `item`: `pro` or the pack's id; `where`: `plans` \| `you` \| `chat` |
| `billing_portal` | Manage billing (on to Stripe's portal) | |
| `shop_open` | a world asks to sell something (`orb.shop.buy`): Orb's sheet opens | `item` |
| `purchase` | Buy in that sheet | `item`, `ok`; `credits` (charged; 0 in your own world) or `error` |
| `earnings_use` | earnings go into building | `credits` |
| `earn_add_shop` | "Add a shop" on the plan card (the request goes into the chat) | |
| `look_buy` | a look for the blob bought (You tab) | `item`, `credits` |
| `look_wear` | what the blob wears changed | `wear` (ids, or `nothing`) |
| `blob_color` | a blob color picked | `color` |
| `error_toast` | an error toast shows | `text` (first 160 characters) |
| `home_tab` | the home page's row switches between friends' worlds and the person's own | `tab`: `friends` \| `mine` |
| `start_from` | a world is picked under the Orb's first line on a new world (to remix) | `world_id` |
| `start_from_more` | its See more (Explore) | |
| `profile_open` | a maker's profile opens | `handle` |
| `friend_add`, `friend_accept` | a friend request is sent; one is accepted (also by asking back) | `how`: `username` \| `request` \| `invite` (from someone's share link) |
| `friend_invite` | friends are invited into a world | `friends` (how many) |

## 7. The world runtime (iframe ⇄ parent)

The parent builds `srcdoc = injectRuntime(html, ctx)`, which inserts one `<script>` as the very
first child of `<head>` (creating `<head>` if needed). The runtime:

- shims `localStorage` / `sessionStorage` with an in-memory Storage seeded from `ctx.storage`
  (snapshot embedded as JSON) — writes are posted to the parent, which persists them under
  `orb:ls:<worldId>` in its own localStorage (and when, in `orb:ls-at`). Signed in, they also go
  to the account (`src/lib/savesync.ts`: 4 s after a change, at once when the page goes away, and
  on start whatever is newer here); a world being opened first takes the account's copy when it is
  newer, so it starts where the person left off on any device;
- forces `preserveDrawingBuffer: true` on WebGL contexts so thumbnails can be captured;
- reports `window.onerror`, `unhandledrejection`, failed `<script>`/module loads and the first
  few `console.error` calls;
- exposes `window.orb` (the world-author SDK, below);
- posts `ready` after `load` + 2 animation frames;
- answers probes: the builder agent (its `look` tool, or a Cursor agent's `sh .orb/look`) plays the world with synthetic input (keys, clicks, taps,
  drags, mouse-look under a simulated pointer lock, typing, `eval`) and gets back screenshots
  (the canvases plus an approximate redraw of the HTML on top; a screenshot can `zoom` into part
  of the screen for detail), the latest errors and console output, the frame rate and the text and
  controls on screen (see `src/lib/probe.ts`). A look with `viewport: 'phone'` plays on a 390×844
  screen: the page shows the world phone-sized in the middle of the stage meanwhile.

All messages are objects `{ __orb: 1, type: string, ... }` validated by `event.source`.

iframe → parent: `ready`; `error {message, stack?, line?, col?, source?}`;
`storage {area:'local'|'session', op:'set'|'remove'|'clear', key?, value?}`;
`capture {dataUrl}`; `store {reqId, op:'get'|'set'|'incr'|'push'|'merge'|'list', key, value?, by?, max?}`;
`room {op:'join'|'send'|'state'|'leave', room?, data?}` (`room` = the room's name, '' for the world's own);
`invite {reqId, room}`; `shop {reqId, op:'items'|'owned'|'buy', item?}`; `toast {text}`; `title {text}`; `probe-result {reqId, result?: ProbeResult, error?}`;
`clip-result {reqId, mime, data: ArrayBuffer (transferred)} | {reqId, error}`.
parent → iframe: `capture-request {reqId}`; `clip-request {reqId, ms, label}`; `store-result {reqId, ok, value?, error?}`; `invite-result {reqId, url}`;
`shop-result {reqId, ok, value?, error?}`;
`room-event {room, event: RoomEvent}`; `probe {reqId, actions: ProbeAction[], opts: {size?, shots?}}`.
A world is in at most 4 rooms at once (a page in at most 8 networked rooms; joining too fast gives solo rooms).
`capture` carries `reqId` when answering a request and none when the world called `orb.capture()`
(the host then uploads it as the thumbnail via `WorldFrame` `onCapture`). `error.source` is the failing
URL (absent for errors in the world's own HTML). Room peer ids are `<me.id>:<random>` (one per page and room);
rooms use broadcast events `state` and `msg`. A world id that is empty, `new`, or starts with
`draft`/`local`/`tmp`/`template` is a draft: `orb.store` is in-memory and rooms are solo.
A peer is `friend: true` while the viewer's friends sync vouches for it: a friend's heartbeat
named that peer id (`rooms`), the answer was asked after the peer's presence appeared, and only
one connection holds its presence key (peer ids aren't secret; a stranger reusing one after the
friend left, or alongside them, is no friend). The world bar counts who's in the world's own
room, you included (`onPeople` counts the others: one other person there makes 2, beside a green
dot, or friends' faces when friends are among them).
A **clip** (the world bar's "Record a clip", `src/state/clips.ts`) is `ms` (1–15 s; the app asks
for 8) of the world's main canvas, redrawn each frame onto a canvas of at most 1280 px with the
visitors' name tags and `label` (the world's address) drawn in, recorded with MediaRecorder (mp4
where the browser can, else webm, 4 Mbit/s). One at a time (`busy`); a world without a canvas
answers `no_canvas`. The world's HTML on top of its canvas isn't in it. The finished clip opens in
a sheet: a preview, Share… (the phone's share sheet with the file) and Download.
`orb.visitors` rides on a room (the world's own unless `room` is given): a player's pose is `_p`
in its room state, next to whatever the world gave `room.setState` (an object; a non-object state
leaves no room for it). The runtime samples the pose every 100 ms and sends it when it changes:
up to 24 numbers (rounded to 0.01), strings (≤ 64) and booleans, with velocities `vx`/`vy`/`vz`
added for `x`/`y`/`z`; `null` hides the player. On arrival `x`, `y`, `z`, `ry`, `yaw`, `heading`
and `angle` are smoothed (positions carried on at the sender's velocity for up to 1 s, angles the
short way round); a field the pose stops carrying is gone from the visitor too. `show()` places a
three.js character per visitor (at most 40, the nearest) with an HTML name tag in a
`[data-orb-visitors]` layer; its pose is the player's world position (its feet: the bounding box's
bottom) and facing, or the camera's less `eye`, or `pose()`. The character is the blob, wearing
`v.wears`, unless the world gives its own: `avatar(v)`, placed at the visitor's feet facing `ry`
and moved by `update(v, model, dt)`, dressed from whatever else their pose carries (what they wear
in that world, say). A pose with `fly: true` is someone
with no body there, exploring from the air (an orbit view, a free camera at that point): they
show as a glowing orb in their colour, eyes facing `ry`, with a light that stays a few pixels big
however far away and a name tag seen from five times as far as a character's. Rooms joined while the
builder plays the world (a probe) are solo too. `RoomEvent` `joined` carries `live`: true when the channel is up,
false for a solo room or when it wasn't up within 6 s (peers that turn up later still arrive as `join`).
`orb.shop` (§2 "Shops in worlds"): a world lists what it sells in a `<script type="application/json"
id="orb-shop">` of its page, `{"items":[{ id, name, price, emoji?, description? }]}` (ids
`[a-z0-9][a-z0-9-]{0,39}`, whole prices 1–1000 credits, names ≤ 40 and descriptions ≤ 140
characters, ≤ 40 items; entries that don't fit are left out). `items` and `owned` come from the saved
world (`GET /api/worlds/:id/shop`, kept 5 s by the bridge; a draft sells nothing). `buy(id)` opens
Orb's own purchase sheet (`src/components/world/PurchaseSheet.tsx`) for the newest frame only, one
at a time, and resolves with what the player did: `{ ok: true, item }` or `{ ok: false, item, reason }`
(`cancelled`, `no_credits`, `sign_in`, `unknown_item`, `busy`, `not_saved` for a draft, `looking`
while the builder plays the world, `not_on_orb` outside Orb). The world never sees prices charged,
balances or who bought.

### World-author SDK (documented to the model in the system prompt)
```js
orb.world            // { id, name }
orb.me               // { id, name, color, wears }  — the current player (anonymous or signed in); wears: what their blob wears
localStorage         // works normally; saved per player per world
await orb.store.get(key)              // shared state for ALL visitors of this world (JSON)
await orb.store.set(key, value)       // ≤ 8 KB per key
await orb.store.incr(key, by = 1)     // → new number
await orb.store.push(key, item, max = 50)  // append to a shared list (guestbook, leaderboard) → list
await orb.store.merge(key, patch)     // atomic shallow merge into an object (null removes a field) → object
await orb.store.list(prefix)          // { key: value } of ≤ 200 keys starting with prefix (≈ 2 MB at most)
const room = orb.room.join(event => {})   // realtime presence + messages among current visitors
                                          // events: joined {self, peers, live} · join/leave/state {peer} · message {peer, data}
room.send(data); room.setState(state); room.peers  // Map<peerId, {id,name,color,wears,state,friend}>; room.leave()
orb.room.join(cb, { name })          // a separate room of the world (own channel `orb-world:<id>:<name>`)
orb.visitors.show({ THREE, scene, camera, player })  // everyone here as characters with name tags (three.js);
                                     // + avatar(v) → Object3D, update(v, model, dt), height, eye, pose(), room, tags: false
                                     // pose() → { x, y, z, ry, fly: true } while exploring from the air: a glowing orb
                                     // without avatar: the blob, wearing what they wear on Orb (v.wears; the orb, its hat)
const v = orb.visitors.join(() => ({ x, y }), { room?, smooth?, snap? })  // share where you are, draw the others:
v.list   // [{ id, name, color, wears, friend, state, x, y, … }] (smoothed) · v.count · v.on('join'|'leave', fn) → off · v.leave()
         // id, name, color, wears, friend and state are Orb's: a pose can't set them
await orb.room.invite(name)          // share a link (?room=<name>) that opens the world in that room → URL | null
orb.room.invited                     // the room the link this page was opened with asked for, or null
await orb.shop.buy(id)               // Orb asks the player to buy an item of the page's orb-shop list → { ok, item, reason? }
await orb.shop.owned()               // ids the player's account owns in this world · orb.shop.items() → the list Orb sells
orb.capture()        // ask Orb to take the world's thumbnail now (e.g. at a beautiful moment)
orb.toast(text)      // small Orb-styled notification
```
`window.orb` exists only inside Orb. World code must guard: `const orb = window.orb;` and fall
back gracefully (`orb?.store`) so exported HTML still runs standalone.

## 8. Builds & their output

There is one kind of build: an agent job on Orb's server (`src/server/agent/runner.ts`). The
agent works on the world's files with tools (list, read, search, write, edit, look at the world
running in the person's browser…) in steps of one model call each, and saves versions of the
world as it goes; a Cursor agent does the same through the job's files link (§3). The job runs in
ticks of a few minutes that hand over to each other, so a build goes on for as long as it needs,
without the page.

`BuildRequest` = `{ worldId, messages, image?, errors?, mode, worldName? }`: the chat (earlier
turns summarized), a screenshot of the world, runtime errors to repair, and `mode` build or ask
(a guide in someone else's world: it answers, can offer a copy, and changes nothing). The agent
reads the world's files itself; its system prompts are in `src/server/agent/prompt.ts`.
- **Direction first.** Small and open requests are built right away, without questions. A big,
  ambitious new world (a whole game, a film, game or art style to match) first gets a quick first
  look in that style (palette, sky, light, materials, the main subject blocked out), saved, and
  the build stops there with one short question about the direction (Orb's agent gives it with
  its ideas, `suggest_next`'s `question`, and it is said last); its three suggestions are
  the answers ("Keep going like this" and two other directions), and the next message builds the
  rest. So a world going the wrong way costs a minute, not a whole build. When someone says the
  look is wrong, the agent changes the look of the whole world rather than tweaking it.
- The prompts are kept short (every build pays for each token, and Cursor adds its own): only
  what the model can't know by itself (the `window.orb` SDK, the starter island, three.js r186's
  pitfalls, saving and looking). No safety rules or audience of their own: the models' own
  guidelines apply. Orb's AI thinks at low effort (`ORB_AI_EFFORT`).

The job's output is text in tagged blocks (namespaced, so they never collide with HTML) plus
control frames (`\u001e` + JSON + newline) that the page strips:

```
<orb:say>Short, warm narration for the chat. Can appear several times.</orb:say>
<orb:title>Cloud Castle</orb:title>
<orb:suggest>Make it night|Add a dragon|Add music</orb:suggest>
<orb:remix/>            (ask mode only: the user wants changes → the page offers Remix under the answer)
<orb:error>…</orb:error> (the build failed: what to tell the person)
```
Frames: `handle` (the job, to reconnect to), `step` (a file change: pending, its label, done or
failed), `progress` (the change being written; the page doesn't show it), `tree` (the files changed:
preview them), `version` (a version saved), `status` (thinking…), `look` / `looked` (the agent
wants to see the world run: the page showing it plays it and answers), `credits` (what the build
used so far), `repo`, `resume` (continue in a new request).
- The page previews the newest tree (debounced, cross-faded), takes over each saved version
  (undo goes back to the version before the build) and shows the steps as a checklist, where they
  came in the output (text before a frame is shown before it).
- Runtime errors in the first ~4 s after a build saved the world trigger one automatic repair
  round in the same message.
- Stop ends the job within a moment: what it saved stays, and what it used is charged (§6).
- When the AI keeps failing, the job retries for about half a minute, then ends with "Couldn't build
  that right now." (and Try again); the person never sees a provider's own message (their own key's
  setup errors excepted).

**Traces.** Every build run is recorded in full for looking back at how builds go
(`src/server/traces.ts`, tables in §5, pages in §6): agent jobs and Cursor jobs (older traces also
hold single-shot `/api/build` requests and rounds browsers ran with the person's own key, from
before every build was an agent job). Events:
`input` (system prompt, chat, the world's files), `step` (one model call: the messages it added —
thinking, words, tool calls with their inputs and results — usage, finish reason, timing; for
Cursor, one agent run's thinking, words and tool calls), `look` (the actions and the page's whole
answer, screenshots as blobs), `output` (an older single-shot build's raw output), `retry`, `error`,
`compact`, `note` (nudges, pauses, hand-overs between ticks, Cursor runs started, a step cut short
and what it was charged), `commit` (a version saved) and `end` (status, error, the world's files). Recording stays off the build's path: writes
queue per trace and failures are only logged (`[orb] trace … failed`).

## 9. Design system

- Fonts: **Geist** (UI) + **Instrument Serif** (display, italic for hero lines).
- Surfaces: frosted glass — light: `rgba(255,255,255,.72)` + `backdrop-filter: blur(28px) saturate(170%)`,
  1px hairline `rgba(255,255,255,.6)` + outer `rgba(15,15,30,.08)`, layered soft shadow;
  dark (prefers-color-scheme): `rgba(20,20,28,.62)`, hairline `rgba(255,255,255,.08)`.
- Ink `#0c0c14`, secondary ink 60% alpha. Radii: 999 (pills), 22 (panels), 16 (cards).
- Backgrounds: light, the lavender-to-peach sky; dark, one deep neutral dark (`#0d0d14`, the iris
  glow low at its top) that never changes after load. Orb's own cards (404, error, the kit's and
  the move's) sit on it.
- Accent = iridescence (violet `#8b7bff` → sky `#5ec8ff` → peach `#ffb38a` → rose `#ff8fc8`), used
  only for the Orb, the send button glow and the verified seal.
- Focus rings: a 2px ink outline, 2px out, along each element's own shape, in either scheme.
- Motion: springy but calm (`cubic-bezier(.2,.8,.2,1)`, 250–450 ms). Respect `prefers-reduced-motion`.
- Mobile first: Orb panel = bottom sheet on < 640 px, as tall as what it holds (up to ¾ of the screen,
  the world's row over the chat; "full", nearly all of it, adds "← Explore"): a tap on its handle
  switches, a swipe down closes it (from full height, a drag down settles at half unless it goes most
  of the way), and the system Back closes it (then a profile over it) before leaving the page.
  Desktop: a 400 px panel on the Orb's side, level with it (from the Orb's top down when the Orb is
  in the upper half of the screen, from its bottom up when lower) and as tall as what it holds,
  closed by its "—". Esc closes it wherever focus is on the page (a world's frame keeps its own keys;
  a dialog or menu over it closes first); on home a click outside it does too (in a world, clicking
  the world leaves it open). Opening a world brings its chat. Its glass is nearly opaque (94% paper),
  so it reads the same over any world. Tabs: Chat · You; the world's row shows above the chat only.
- Copy: warm, short, never technical by default ("Building your castle…", not "Applying patch").
- Toasts: in a world, a small bubble beside the Orb (beside its panel when that's open on a wide
  screen, above or below it on a phone); just above the sheet while it's open on a phone; elsewhere
  at the bottom centre, above the safe area.
- Tab titles: "Orb — make and play worlds" at home, "<Name> by <maker> · Orb" in someone else's
  world, "<Name> · Orb" in your own, "<Page> · Orb" elsewhere.

## 10. Conventions

- TypeScript strict. No new dependencies without a strong reason (already installed: ai,
  @ai-sdk/{anthropic,openai,gateway}, postgres, @simplewebauthn/{server,browser},
  @supabase/realtime-js, zustand; dev: @electric-sql/pglite, playwright, three).
- Next.js 16: read `node_modules/next/dist/docs/` before using an API you are unsure of
  (route handler `params` are Promises; `middleware` is now `proxy`).
- Server-only modules import `'server-only'`-free plain code but must never be imported from client components.
- Local verification: `ORB_MOCK_AI=1 npm run dev` (PGlite, mock AI); Playwright via `kit/lib/browser.mjs`
  (`launch()`, `routeCdn(page)` — the sandbox cannot reach CDNs).
