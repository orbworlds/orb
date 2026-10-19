# Orb kit

Play and test [Orb](https://orbworlds.com) worlds on your own computer, the way Orb runs them.

An Orb world is a small web project: an `index.html` and the files it loads. On Orb a world gets
`window.orb`: saves that follow the player, state everyone shares (leaderboards, guestbooks),
realtime rooms, shops. The kit gives a world all of that on `localhost`, so you can work on it in
your own editor and test it in CI.

```bash
npx @orbworlds/kit dev path/to/world      # http://127.0.0.1:4242, nothing to install
npm install --save-dev @orbworlds/kit     # or keep it in a project: then `npx orb dev`
```

Each of Orb's own worlds has it in its `package.json` already, so in one of those it's just
`npm install` and `npm start`. Open a second tab (or press **+ Player**) and you're two players in
the same world.

## Commands

```bash
orb dev [folder] [--port 4242] [--host 127.0.0.1]   play the world in that folder
orb test [folder] [--shot file.png]                run it in a headless Chrome: it has to draw, and nothing may throw
orb share                                          the links that open this repository on Orb
orb push [folder] [-m message] [--new] [--no-shot] put the world on Orb as you
orb login | orb logout                             sign this computer in or out (push signs in by itself)
```

A project with a build step keeps a `tools/package.mjs <out>` that writes the world as Orb serves
it; `orb dev` and `orb test` run it first, into `.orb/`.

`orb share` in a fork of an Orb world's repository prints a link that brings **your version** into
Orb as a world of your own, credited as a remix of the original (Orb reads `orb.json`'s `world`).
It keeps following your fork after that.

## Push to Orb

```bash
npx orb push -m "Faster bikes"
```

That's all, every time. The first push on a computer prints a link: open it where you use Orb and
press **Allow** (the code on the page matches the one in the terminal). The world then belongs to
you there, in that browser and in your account if you're signed in.

- No `world` in `orb.json` yet: a new world of yours. `orb.json` gets its id and address, so the
  next push goes to the same world. Commit it.
- A world of yours: a new version of it (nothing, when nothing changed). `-m` is what its history says.
- Someone else's world (a fork of an Orb game): your remix of it. `orb.json` then points at your
  remix and keeps the original as `remixOf`.
- `--new` makes a new world even when `orb.json` names one.

It sends the folder as Orb will run it (for a project with `tools/package.mjs`, its package), without
dot files, `node_modules` and `test/`. With Playwright installed it also takes a screenshot for the
world's card (`--no-shot` skips that). `ORB_TOKEN` signs in without the link (CI), and `ORB_SITE`
pushes to another Orb.

**For coding agents.** To put the world on Orb, run `npx orb push -m "<what changed>"` in its
folder. If it prints a link and exits with code 2, show the person that link, wait until they say
they allowed it, and run the same command again. It prints the world's address when it's done.

## What runs where

| On Orb | With the kit |
|---|---|
| The world runs in a sandboxed frame with Orb's runtime | The same frame and the same runtime |
| `localStorage` saved per player, synced to their account | Saved per player in this browser |
| `orb.store`: shared state on Orb's servers | Shared by every tab of this browser |
| `orb.room`, `orb.visitors`: realtime with everyone in the world | Between the tabs of this browser |
| `orb.shop`: players buy with Orb credits | The page's own list; buying asks, and charges nothing |
| `orb.me`: the player's Orb name, colour and looks | `Player 1`, `Player 2`… (`?player=2`, `?name=Ada`) |

The page reloads when a file changes. Errors from the world show at the top and in the console
with their file and line. `?bare` hides the kit's bar, `?room=<name>` opens a named room (what
`orb.room.invite` links do).

## In tests

`orb test` needs [Playwright](https://playwright.dev) in your devDependencies. A world's own test
suite can use the same browser setup:

```js
import { launch, routeCdn } from '@orbworlds/kit/browser';
import { serve } from '@orbworlds/kit/server';

const kit = await serve({ dir: '.', port: 0, watch: false, quiet: true });
const browser = await launch();          // Chrome with software WebGL
const page = await browser.newPage();
await routeCdn(page);                    // three.js from node_modules, for machines without a CDN
await page.goto(kit.url + '?bare');
```

## `orb.json`

```json
{
  "name": "Bed Wars",
  "world": "orb-bedwars",
  "url": "https://orbworlds.com/orbworlds/bed-wars",
  "repo": "orbworlds/bedwars"
}
```

`world` is the Orb world this code is (or was forked from), `url` its page on Orb, `repo` the
GitHub repository it lives in.

## Types

`orb.d.ts` types `window.orb`:

```js
/// <reference types="@orbworlds/kit/orb.d.ts" />
const orb = window.orb; // undefined outside Orb: keep the world playable on its own (orb?.store)
```

## License

MIT. `lib/runtime.js` is Orb's world runtime, built from Orb's source. New versions follow semver:
a minor version for things worlds can opt into, a major one for anything that could break a world.
