<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Working on Orb

- **Ship by default.** A change that is done and tested gets merged into `main` and deployed. Don't leave pull requests open: ship them or close them.
- **How to ship.** Others push to `main` too, so start from a freshly fetched `origin/main`: on a temporary branch, merge each PR with `git merge --no-ff -m "Merge PR #N: <title>"`, run `npx tsc --noEmit`, `npm run lint` and the tests the change touches (README → Tests), push to `main` and run `npm run deploy` (its build applies the database schema). Then check production, and Problems on the lab's Pulse page. Docs alone need no deploy.
- **Work happens in `orbworlds/orb-private`; `orbworlds/orb` is its public copy.** Every push to `main` is published there by the org's bot (`.github/workflows/public.yml`), with no PR numbers or co-author lines, so nobody's account shows. Never push to the public one. Everything committed goes public: no secrets, keys or personal details in files.
- **Orb's own games live in their own repositories** (`orbworlds/<repo>`, listed in `src/data/originals.json`). Change one there, as a pull request. The Orb kit is `kit/` here; how the org works is in docs/operations.md → "The org and its games".
- **SPEC.md is the contract**: change it in the same commit as the behavior. How worlds should look: `docs/WORLD_STYLE.md`; the games we want: `docs/WORLD_WISHLIST.md`; running Orb: `docs/operations.md`.
- **The database is the server's alone.** Every table has row-level security on and Supabase's data-API roles (`anon`, `authenticated`) have no rights; the end of `src/server/ddl.mjs` keeps it that way, for new tables too. Browsers only get Supabase's public key for Realtime broadcast.
- **Payments take only Stripe's word**: whatever grants credits or a plan reads the checkout or subscription back from Stripe, never from the request or the webhook's copy.
- **Secrets** live in Vercel's environment and Cursor's secrets — never in the repo, a chat or a log.
