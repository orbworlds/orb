# Worlds worth adding

Orb Originals we want to build: our own takes on popular genres, never copies of another game's
code, art or name. Originals are remixable, so each one is also a starting point people can change
by chatting.

## Agreed

- **Endless calm drive** (like Slow Roads): a car on a winding road through endless, changing
  scenery (hills, forest, coast, desert), day and night, weather and music. No goal, just driving.
- **Low-poly time trials with a track builder** (like PolyTrack): snap together a track from
  pieces (ramps, loops, boosters), race the clock, share the track and beat other people's times
  (an `orb.store` leaderboard).

## Proposed

From what is most played on Roblox and Minecraft (October 2026).

- **Co-op survival with real players** (like 99 Nights in the Forest and Minecraft's Survival/SMP):
  gather wood, craft, keep the campfire alive and make it through the nights together. VampireZ
  already covers a one-night survival with bot teammates, and Orbcraft's Wilds the SMP side (one
  shared survival world a month, a safe town in it and PvP outside); still to do is the campfire
  co-op of 99 Nights, a small team holding out together.
- **Steal-and-collect** (like Steal An Egg and Steal a Brainrot): hatch and collect rare creatures
  in your base, sneak into other bases to steal theirs.
- **Obby** (like Tower of Hell): a tower of obstacle courses; easy to remix ("add a lava jump").
- **Town roleplay** (like Brookhaven and Adopt Me!): houses, cars and pets to hang out with; grows
  out of Hangout.
- **Social deduction** (like Murder Mystery 2): innocents, a sheriff and a murderer; needs six or
  more players in one room.
- **Arena shooter** (like RIVALS): quick cartoon duels, against bots first.
- **Discover by combining** (like Infinite Craft): drag two things together and the AI decides what
  they make; every first discovery is shared with everyone. Little Alchemy 2 is in Explore; the AI
  twist is new.

From the most loved beautiful indie games of 2025–2026 (October 2026): worlds that are the point.

- **Sand surfing** (like Sword of the Sea): glide a board over dunes that roll like waves, past
  sunken ruins at dusk; other surfers' trails show live, a trick and run-time leaderboard.
- **One great mountain** (like Cairn and PEAK): a free climb with stamina up a single peak above
  the clouds, roped to friends; cairns people leave stay, fastest-summit and fewest-falls boards.
- **Cloud kingdom flight** (like Sky: Children of the Light): fly a glowing cape over floating
  islands; light passes between strangers flying together.
- **Hex landscape puzzle** (like Dorfromantik): lay tiles so rivers, rails and forests join up in a
  tilt-shift diorama; one daily seed and board for everyone.
- **Kelp dive** (like ABZÛ): swim down through kelp, whales and bioluminescence; the deepest-dive
  board and diving in pods. Aquarium and Ocean Waves in Explore only look at the sea.
- **Snow descent** (like Lonely Mountains: Snow Riders): ski down powder with friends, ghost
  replays; about friends and freeriding, not the laps of the track builder above.
- **Forest tea house** (like Wanderstop): brew tea in a glowing clearing for visitors who are
  real players.

## Scouted for Explore

Scouted in October 2026; the ones that played in Orb's frame are in Explore now. Still out:

- **itch.io games** answer a frame on another site with a "hotlinked" page, whatever the URL
  (`html-classic.itch.zone` too), so none can be embedded: Soundmarine, There's a house in the sky,
  Shutterbug, Koto, Air Garden, Archipelago, Feather Park, Tanuki Sunset, Little Troubles in Spooky
  Town, Sky Fang, UFOmageddon 3D, Neon Roads, Mecha Redline, Nordic, Molt. Asking each author for a
  copy hosted elsewhere would be enough.
- **WebGPU worlds we could not check**: they frame fine, but the software GPU our checks run on
  can't start them, so nobody has seen them play inside Orb yet. **Tidewater**
  (dgreenheck/tidewater, MIT: a cozy island fishing game with a simulated ocean, among the best
  found), Powder Rush, Three.js Punk Drive, Transformer and Elysium Commons (scottsun.io), Deep Sea
  Fish, Voxel City, Spring Ramble, Mars GT and Pandora Flower. Check each on a machine with a real
  GPU before adding it.
- **Above the Clouds** (a Burj Khalifa concept site) and **Procedural Planets** were left out: an
  advert, and a generator with sliders more than a world. So were Procedural Terrains (an editor
  app), Regolith (its maker ties it to a token), Off Road Earth (bare terrain where it starts) and
  fan games built on someone else's characters (Storm Race, Soccar, Natsu by Spectromachina, The
  Simpsons Hit & Run, Battle of Hoth).

## Embeds we would add if their sites allowed it

These refuse to load in a frame (`X-Frame-Options` or `frame-ancestors`). Asking their authors to
let `orbworld.vercel.app` frame them would be enough: Slow Roads, PolyTrack, Null Range, Wild
Haggis Survivors, Field of Command, Astral War, Kart Royale, BuildYourTown, Little Flock, WenWare,
*Quick, Draw!*, Blob Opera, Infinite Craft, Sandboxels, Coastal World, Igloo Inc, Marble by World
Labs, Still Night, Tidebreaker, Operation Elsewhere, Heatsink, Junkyard King, Clash Karts, Kage no
Michi, Claude of Tanks, GTA Kenny City, Wyrmhole, The Aviator, and the games on genex.games
(Snowball, Midnight Apex) and on claude.ai artifacts (Mini Moto).

Three refuse a frame but are MIT on GitHub, yet are too big for a world (200 MB and 10 MB a file since, `FILE_LIMITS` in
`src/server/files.ts`) and need a Vite build: **False Earth** (momentchan/false-earth: an astronaut
walking a WebGPU planet of a million grass blades and flowers, the most beautiful thing found;
84 MB of assets, and its engine is a git submodule), **Neon Zenith** (billpwchan/neon-zenith: a
neon Kowloon to drive and fly; 181 MB built) and **Halcyon** (billpwchan/halcyon: a tropical atoll
with an FFT ocean, scanned reef and whales; about 560 MB, with scanned assets under their own
licences). Hosting them needs worlds that can be bigger, or their large files served from a CDN.

## Hosting fixes that would unlock more open-source worlds

- Imported worlds that load files by root-absolute paths (`/vendor/three.module.js`) break,
  because the page's `<base>` points at its files but `/…` still means Orb's own site. Rewriting
  those paths to relative ones on import would let Gogh Strike (embedded today) and similar
  projects be hosted on Orb.
