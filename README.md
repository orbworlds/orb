# Orb

Make worlds and games by talking, then play them with anyone. **[orbworlds.com](https://orbworlds.com)**

You describe a world, an AI agent builds it while you watch, and you share the link. No install,
no account needed. Anyone can remix a public world and make it their own.

A world is a small web project: an `index.html` and the files it loads. It runs in a sandboxed
iframe and gets `window.orb` for saves, shared state, multiplayer rooms and a shop.

## Run it

```bash
npm install
ORB_MOCK_AI=1 npm run dev
```

That runs on <http://localhost:3000> with a local database (PGlite) and a mock builder, so nothing
else is needed. Set `ANTHROPIC_API_KEY` for real builds. Everything else you can configure is in
[docs/operations.md](docs/operations.md).

## Make a world in your own editor

```bash
npx @orbworlds/kit dev      # play the world in this folder, the way Orb runs it
npx orb push                # put it on Orb (asks you once to allow it in your browser)
```

See the [Orb kit](kit/README.md).

## The code

| | |
|---|---|
| `src/app/` | Pages and API routes (Next.js) |
| `src/server/` | Database, builds (the agent and its tools), payments, GitHub sync |
| `src/components/`, `src/state/` | The interface |
| `src/lib/runtime/` | What a world gets inside its frame (`window.orb`) |
| `kit/` | The Orb kit (`@orbworlds/kit` on npm) |
| `scripts/` | Tests, deploys and maintenance |

[SPEC.md](SPEC.md) describes how everything is meant to behave, and it changes along with the code.
How worlds should look is in [docs/WORLD_STYLE.md](docs/WORLD_STYLE.md).

Orb's own games (Orbcraft, Bed Wars, VampireZ, Wildbrush and the rest) each live in a repository of
their own at [github.com/orbworlds](https://github.com/orbworlds). Orb plays them from there.

## Tests

```bash
npm run test:engine     # unit tests
npm run test:api        # the API, end to end
npm run test:e2e        # the app in a browser, with the mock builder
npm run test:kit        # the Orb kit
```

`test:runtime`, `test:passkeys`, `test:move`, `test:cursor`, `test:billing` and `test:saves` cover
the rest. Each starts its own server.

## Contributing

Pull requests are welcome. CI runs the type check, lint and the unit and API tests on each one.
For a change in how Orb behaves, update [SPEC.md](SPEC.md) in the same pull request. Changes to a
game go to that game's own repository.

## License

MIT, see [LICENSE](LICENSE).
