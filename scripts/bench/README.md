# Orb's first-turn bench

What a person meets when they ask Orb for a new world: how soon something beautiful is on their
screen, how it looks when Orb hands back, and what that first turn costs. Optimizing it should make
Orb better for people, so it measures the real builder, end to end, on what people ask for.

- **The requests** (`prompts.txt`): ten, the way people ask Orb for a new world: mostly games, often
  asking for great graphics, and some places to look at.
- **The builder, as it is:** each request is typed into Orb's home page by a new visitor, on a
  server of this checkout (its own fresh database) building on Orb's AI as production does.
- **What's measured, each request** (times by the server's clock, from its traces: a machine that
  draws worlds in software, as test machines do, shows them later than people's devices would):
  - *first version*: seconds until the first version of the new world is made (the end of the first
    step that writes its files, which is when it reaches the person's screen), and a screenshot of it
  - *handed back*: seconds until the turn ends, and a screenshot then; also without the time its
    looks took, since looks here wait for software drawing
  - *cost*: US$ of the turn's model calls, its steps and its looks
- **How two versions compare** (`judge.mjs`): for each request, a blind judge (Claude Opus 5.5)
  sees the two worlds, as first shown and as handed back, and says which the person would be happier
  to see: more beautiful, and more clearly what they asked for. Each pair is judged twice, in both
  orders, and a version wins it when the two verdicts lean its way (one may call it even); a version
  that never showed anything loses to one that did. Read the sheet it makes too: it's the check on
  the judge.

## Run it

```sh
ANTHROPIC_API_KEY=… node scripts/bench/run.mjs base                 # this checkout, as it is
ANTHROPIC_API_KEY=… node scripts/bench/run.mjs pace                 # …from a checkout with a change
ANTHROPIC_API_KEY=… node scripts/bench/judge.mjs base pace          # the change against the base
```

`--only drive,f1` runs some requests, `--repeat 2` each twice (closer calls need it: one run a
request is a noisy measure), `--parallel 2` that many at once (more slows the drawing of each).
Results go to `.data/bench/<label>/`, a comparison to `.data/bench/<a>-vs-<b>.png` and `.json`.
To try a change, make it in a second checkout (`git worktree add`), run both at once, one build
each (`--parallel 1`, different `--port`s: then both draw at the same speed), and copy the second's
`.data/bench/<label>` here to judge. All ten take about an hour and US$10–20 a version.

Compare versions with each other, not with production: this machine draws worlds in software, so
looks take 20–60 s instead of about 5, a heavy world's looks can time out again and again (the
builder is told to look again later), and turns run longer and cost more than people's do
(production's median new-world turn: 3 steps, 1 look, about US$0.35).

## What we learned

Keep a line per comparison: what changed, the judge's verdict (first version, handed back), and the
medians (first files written, handed back, US$ a turn).

- **Nov 2026, `pace` vs `base`, shipped.** A new world's first turn is just its look and the one thing
  it's about, then a question. First version 7 better, 1 even, 2 worse; handed back 3 better, 7 worse
  (it does less per turn, by design). Medians: first files 89 s vs 179 s, handed back 320 s vs 455 s,
  US$1.14 vs 1.95 a turn; turns not back within 12 minutes 2 vs 5.
- **Nov 2026, `light` vs `base`, dropped.** The nature kit's light for every outdoor 3D world, games too
  (by its prompt line). First version 4 better, 6 worse; handed back 3 better, 1 even, 6 worse; US$1.70.
