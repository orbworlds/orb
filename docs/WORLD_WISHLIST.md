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
  Fish, Voxel City, Spring Ramble, Mars GT, Pandora Flower and Particle Fighter
  (particlefighter.andrewblumson.com). Check each on a machine with a real GPU before adding it.
  (On 5 November Chromium's software Vulkan, `--enable-unsafe-webgpu
  --use-webgpu-adapter=swiftshader --enable-features=Vulkan --use-vulkan=swiftshader` plus a shim
  turning today's string `swizzle` of a texture view into the object this Chromium wants, ran
  three.js's WebGPU examples at 2–3 frames a second; but Tidewater and Tokyo DisneySea didn't finish
  a frame in two minutes, Transformer and Voxel City hit a Dawn bug writing 3D textures, and
  Highvale needs more than 256 texture layers. So they still wait for a real GPU.)
- **Above the Clouds** (a Burj Khalifa concept site) and **Procedural Planets** were left out: an
  advert, and a generator with sliders more than a world. So were Procedural Terrains (an editor
  app), Regolith (its maker ties it to a token), Off Road Earth (bare terrain where it starts) and
  fan games built on someone else's characters (Storm Race, Soccar, Natsu by Spectromachina, The
  Simpsons Hit & Run, Battle of Hoth).
- **Architecture worlds** (buildings, towns, gardens; scouted in late October 2026). To check again:
  **Kigumi Architecture** and **Sannenzaka** (re-presentation.jp: Japanese timber joinery, and a
  Kyoto street with the Yasaka pagoda) answered 502 all through the check, so nobody has seen them
  in a frame; neither has a licence. Left out: **Alexandria** (alexandria-mouseion.netlify.app, MIT
  but refuses a frame; about 120 MB with a Vite build, so it could be hosted), **Concordia**
  (refuses a frame, its simulation's code is private, and it needs a keyboard), **Model Museum: AI**
  (sael.net: more a leaderboard of company logos than a place, and its maker wants to be asked
  before anyone frames it), **Kage** (mengto.github.io: a scroll-driven essay page, not a place to
  explore), **Jastrzębia Góra** (splatter.app: a 2 GB drone scan of a lighthouse in forest under a
  black sky) and **The Silo** (a fan model of someone else's TV show). Neon Zenith and Three.js
  Punk Drive are listed elsewhere here. Checked and fine in a frame, but left for a later batch:
  Open House (Scenario's living room in seven styles), Qingming Bianjing (no licence yet), Warszawa
  Voxel, Villa Savoye, NAVIS (opens under a large settings panel; touch can't walk), Seijaku (ends
  in a property sales page with an inquiry form), Basilica of Celestial Light, BRUT, A Home Among
  the Bamboo, Towers, Ocean Drive (minutes to load on a weak GPU), Chinese Autumn Temple (about
  255 MB of assets), Morning Diner, Interwar Thessaloniki, WITHIN, Hush, CyArk's Civita di
  Bagnoregio and the Sainte-Thérèse chapel at Labenne. **Utsuroi** (a Kyoto house from
  dawn to night; billpwchan.github.io/utsuroi, since its own domain refuses a frame) loads in Orb's
  frame, but software WebGL never got past its loader: add it once someone sees it draw on a real
  GPU. Orb could host it (MIT, a Vite build of about 160 MB) once its one CC BY-NC-SA lantern is
  swapped out.
- **Scouted on 25 October 2026** (three.js forum Showcase, Show HN, X). In Explore now: The
  Forbidden City, Lunar Walk and New Rad City. **The Forbidden City** is embedded although it is
  MIT (watsonbkeel/forbidden-city-3d): the game itself is about 45 MB (`src`, `data`, `public`),
  but the repository carries 300 MB of `reports/` and 70 MB of `docs/`, so its tarball (342 MB) is
  past the importer's download cap and its files past a world's 200 MB. Hosting it needs the
  importer to leave out folders a page never loads, or the maker to move those reports elsewhere.
  **Tiny Boat, Big Lake** (danielalshriky.com/tiny-boat-big-lake: a little motorboat on a huge lake,
  among the most beautiful found) frames fine and its menu scene draws in Orb, but on software
  WebGL "Start the journey" never got further: check it on a real GPU and add it. **Highvale**
  (playhighvale.com) and **Digital Garden** (digitalgarden.si) need WebGPU or refuse a frame.
  Left out: the **Glowbit Games** series (Leaf Me Alone!, Boom Bloom!, Shine Ahoy!, Plip Plop!,
  Picnic Heist!, Crop Circle Crew, Clickety Clack!: lovely, but their pages carry ads and refuse a
  frame), **Efectazo** (a $2.99 "Go Pro" upsell on its menu), **Alpenwelt** (sign-in), **Roadkill**
  (sign-in), **Interstellar** and **RoadRash** (someone else's film and game), **Demo Disc**
  (pixelnest.io: a PlayStation in a bedroom showing other studios' demos, more a catalogue than a
  place), **Sillage** (a small, quiet 2D swim; fine in a frame, maybe for a later batch), **Fish
  Tank Plus** (a store page for a Windows screensaver; its browser tank is play.fishtankplus.com),
  **Warehouse Racing** (online kart racing with voice chat; not tried past its title), and Hotel
  Komaiha, Saltmere, Dirtbound, Aquarius, Zooki, Lam Rimba and I'll Call You Later, which refuse a
  frame.
- **Scouted on 26 October 2026**, a quiet day: nothing added. Left out: **Clearwater**
  (aureliengmz.github.io/clearwater: a lovely sunlit water surface with caustics, but a shader to
  look at rather than a place), **Landscape** (lo-th.github.io/landscape: a WebGPU terrain
  prototype driven from a settings panel), **Wizardos** (wizardos.io: daily coin rewards, a shop
  and a Poki login), **Zubspace** and **Glider 4.0** (remakes of other people's games), the
  Crayon open-world flight game by @aniketjart (refuses a frame) and **Roadster Racing** (refuses a
  frame).
- **Scouted on 27 October 2026** (three.js forum, Show HN, velven.ai/explore). In Explore now: World
  Explorer (hosted), Gulabi Nagar, Gulmohar Local and Wildlands: Seasonkeeper. No code could be
  found for the last three, so they are embedded. For a later day: **Three-Point Contest**
  (3pointscontest.netlify.app: a basketball shooting contest in a school gym, sport Explore lacks;
  fine in a frame, but its Shop wasn't looked into), **Low Tide** (low-tide.netlify.app: a top-down
  beach painted in impasto, gorgeous), **NINE LOOPS: SUBWAY** (design9.jp: an Exit 8-style loop
  game in a subway tunnel), **RIRRI'S** (world.irisli.dev: a rainy-night Japanese convenience store
  as a portfolio), **OFRENDA** (ofrenda.davidlangarica.dev: building a Día de Muertos altar) and
  **FLOAT** (floatparkour.vercel.app, on GitHub: brutalist first-person parkour), all fine in a
  frame. Left out: Hammy Pinball (Glowbit Games: ads), Father's Night (refuses a frame), Ocean
  (ocean-noniv: WebGPU only), Nekada (a timeline tool), Mini World (a children's app more than a
  world) and Cymatic Drift (lets only Velven frame it).
- **Scouted on 28 October 2026**: Infinite Garden, Low Tide and Three-Point Contest went in, all
  embedded (no code could be found). For a later day: **FLOAT** (floatparkour.vercel.app, on GitHub
  without a licence and needing a React build: fine in Orb's frame, but its recorded preview ran
  off the first platform into the void; record it walking, not sprinting), **SF Blimp** (sf-blimp.vercel.app: a blimp over a pixel-art San
  Francisco, charming; Velven credited Guillermo Rauch, but its page there is gone, so who made it
  needs confirming), **VybeNomad** (vaigames.com/vybenomad: a digital-nomad life sim; its site
  didn't load in time to check), **NINE LOOPS: SUBWAY**, **RIRRI'S** and **OFRENDA** (see 27
  October). Left out: **Whack!** (a plain whack-a-mole) and **City Drones** (citydrones.app: a
  landing page in front of the game, not looked into further).
- **Scouted on 29 October 2026**, a quiet day: NINE LOOPS: SUBWAY and RIRRI'S (both from 27
  October) went in, embedded, as no code could be found. Left out: **A Little Tidy**
  (games.roseyao.com: a lovely room-tidying game, but it sits in one family's own page of games
  made for their children, so it isn't ours to point strangers at), **OFRENDA** (its Begin button
  never answered here, twice), **Plushies** (prathje.github.io/plushies: a component library's
  demo page), **Metro Maneuver** (a 2D puzzle) and **Butcherbench** (a meat-cutting toy).
- **Scouted on 30 October 2026** (Velven, Show HN, three.js forum): Sundrift and ForestRide went
  in, embedded (no code found). For a later day: **Butterbean Hollow**
  (wesche.com/lab/fable/ufo-farm: a UFO abducting critters from a little farm island, by the
  maker of Sundrift; cute but slight) and **Freewheel** (noworklabs.com/freewheel: cycling through
  Guwahati's woods at night, but its own menu says it is still under construction). Recreations of real places
  are welcome (docs/operations.md), so Camp Nou (left out on 29 October) is in Explore now, and
  **Tokyo DisneySea** (3dscenes.qualityf2p.workers.dev/tokyo-disneysea, by Charly Delaroche) is
  wanted, but it needs WebGPU, which the software GPU here can't start: add
  it once someone sees it draw on a real GPU. Left out: **Voxel Musou** (failed to load here),
  **Dekoboko** (one motion demo in a list of them), **Pure Particles** (pureart-xyz: never got past
  its loader here). Not looked at yet: **Tiberava** (tiberava.online, a Roman city game on Show
  HN; its page never finished drawing for a screenshot on 25 October).
- **Scouted on 31 October 2026** (three.js forum, Show HN): Rækk du ferga? went in, embedded (no
  code found). **The Light that Remains** (thelightremains.vercel.app: a narrative sailing game
  made in memory of its maker's mother, among the most moving found) frames fine and its opening
  draws in Orb, dusk falling over a lighthouse island, but on software WebGL the sailing never
  began after two minutes: check it on a real GPU and add it. Left out: **Catcopter**
  (catcopter.com: lively live multiplayer, but its arena drew flat and 2D here), **Balk**
  (balk.club: asks for a sign-in), **M / DRIVE** (bmw-motorsport.vercel.app: a racer built round
  one car maker's models), and **Salon Noir** (a casino).
  Not looked at yet: **Cinderwake** (cinderwake.io, a survivors-style game on three.js's WebGPU
  renderer).
- **Football, looked for on 31 October 2026**: Sunday League went in, embedded (its code is on
  GitHub but all rights reserved, so it can't be hosted). Others found: **DISCBALL3D**
  (discball3d.com: 3D multiplayer soccer with discs, bots and a shop; frames fine, a good second
  pick), **Pixel Ball** (pixelball.live: 4v4; didn't load here), **0-0.io** (top-down 2D),
  **outlol** (refuses a frame, and sells pitch plots), **Krashout** and **Car Soccer** (refuse a
  frame) and **Efectazo** (see 25 October).
- **Scouted on 1 November 2026**, a quiet day: nothing added. **Architect 01**
  (danielalshriky.com/my-3d-worlds, by Daniel Alshriky, maker of Tiny Boat, Big Lake: a robot in
  a sunlit forest of stone ruins, a portfolio you walk rather than read; beautiful) frames fine
  and draws in Orb, and touching its star starts its opening, but on software WebGL the walk never
  began: check it on a real GPU with Tiny Boat. For a later day: **Survive the Horde**
  (babylon-fps.vercel.app, Babylon.js, on GitHub without a licence file: a substantial zombie
  shooter with an offline solo mode, but grey and modelled on PUBG; not beautiful enough yet).
- **Scouted on 2 November 2026** (three.js forum, Show HN): Virtual Diwali went in, embedded (no
  code found). For a later day: **The Clearing** (gogaetmaru.meaninglens0.workers.dev: a night
  forest where you write a line about your day and light a campfire; it draws in Orb, but its
  walker didn't move here, and strangers' lines show in the world) and **Lightyears Home**
  (lightyears-home.pages.dev: finding the way home by pulsars; not looked into past its menu).
  Left out: **Speedmaxxing** (maxxing.games: a racer on Dubai's Sheikh Zayed Road; refuses a
  frame), **Sand-racer** (WebGPU, shown only as a post on X), and **Hyrule diorama** (someone
  else's game world).
- **Scouted on 3 November 2026** (Show HN, three.js forum): Iso Hoops went in hosted (no build
  step; no licence for the game itself, so it can't be remixed) and Warsaw in Voxels embedded.
  **Warsaw in Voxels** (stared/warsaw-vibe-voxel, MIT, by the maker of Invisible Cities) could be
  hosted: its `web/` folder is a Vite project the importer runs from source, but its
  `public/data/trees.json` is 18 MB, over a world's 10 MB a file, so a copy would lose its trees.
  Larger files in worlds (or the tree data split in two upstream) would unlock it. Nothing else
  new on the forum since the 1st was worth adding.
- **Scouted on 4 November 2026**, a quiet day otherwise: Neighborhood Football went in, hosted
  (VladSez/iso-football: Iso Hoops' sibling, penalty practice against a diving keeper on five
  pitches; no build step, and like Iso Hoops no licence for the game itself). Nothing new on the
  three.js forum since the 2nd, and nothing on Show HN or Velven worth adding.
- **Scouted on 5 November 2026**: Paper Boat Storm went in, embedded. It is a world made with
  Diorama (gtanczyk/diorama, Apache-2.0: a sketch or a sentence turned into a paper-craft scene
  with Meta's models), but the world itself is a build the tool's command line makes and isn't in
  the repository, so it can't be hosted. The three.js forum's Showcase has had no new topics since
  1 November (checked its feed, its search and the topic numbers after it).
- **Mega scout on 5 and 6 November 2026**: seven searches at once (the three.js forum's best of
  the year, Hacker News, the catalogues of AI-made games, js13kGames, real places and scans, engine
  showcases and GitHub) found about 180 worlds Orb didn't have; where more could come from in bulk
  is under "Where many more worlds could come from" below. In Explore now: **SP13KTRA** and
  **DR1V3N WILD** (Frank Force's js13k racers, #13 of 317 in 2026 and #8 of 187 in 2024), embedded
  from his GitHub Pages copies because play.js13kgames.com refuses a frame and their licences
  reserve all rights; the **Tomb of Ramesses VI** (a SuperSplat scan by Flyover Zone); **Riyadh
  360** (hosted: Aymn74/riyadh-360, MIT, no build step; listed among the Slop Cities, in Arabic and
  English, with a guided tour and a sandstorm); **Sidi Bou Said** (embedded: its MIT code sits in a
  12.8 GB repository, far past the importer's download cap); OpenAI's **Physics Museum**;
  **Sumiro** (xikhar's, 2.6M views on X: embedded, because four of its models are over 10 MB);
  **Kettu-Vellam**, the Kerala snake-boat race; **A Game About Capybaras Delivering Food** (Vibe Jam
  2026's winner); **Blue Bajaj Rally** (a tuk-tuk race in highland Ethiopia); and Frank Force's
  **Sunshine Golf Classic**. Sumiro's, Kettu-Vellam's and the capybaras' videos are cut from their
  makers' own: the recorder here never got past Sumiro's title screen, Kettu-Vellam's race is too
  heavy for software rendering, and the capybaras' run gave it no picture. Then **Slop New York** and
  **Bay Ride** (both hosted, MIT: mrdoob's Manhattan in plain ES modules, and Prasenjit Nayak's painted
  bay, a Vite and TypeScript project the importer runs from source), **Sutro Tower** (Vincent Woo's
  drone scan), **Takibi Biyori** (a camping game made entirely in code; it sells optional cosmetic
  packs) and **Lagoon Tree Village**. All but Sutro Tower draw inside Orb but are too heavy for this
  machine to record in reasonable time (Bay Ride's sea shader takes minutes to compile here), so
  their videos are cut from their makers' posts. Last, **Sedona Sunset** (hosted: Prasenjit Nayak's
  walk up a red-rock wash in Arizona, MIT, plain ES modules; its video took 50 minutes to record
  here). Left out: **Wildbrush** (Danny Limanseta's, 1.24M
  views on X), because Orb's own Original has the same name; **Skip a Stone** (a lovely alpine lake,
  but the recorder couldn't throw a stone, so its clip would be a still, and its post has no video);
  **Koi Pond Garden** (souranyp-stack/koi-pond-garden, MIT, one HTML file: it hosts and draws inside
  Orb, but its own camera gives a letterboxed, nearly still clip here and its post's video is a
  16-minute screen recording; Explore also has Koi Canal and Kōyō-en); **Hard Road** (the endless
  winter drive the "Agreed" list asks for: WebGPU first, it was still compiling its shaders when
  checked here, and then its site answered our checks with 429; check it on a real GPU). Found and
  worth a later look: Camping Season, Terrain Rider (real mountain-bike trails), Roadarium (119
  real cities, made for learner drivers), Angkor Heritage (Cambodia in voxels), BOALT (sport
  fishing), Momiji Lake, Rivets & Roses (its interface opens in German), Volley Rally, Pelota (an
  alpha of the Mesoamerican ballgame), Willowmere, Emberfall (an engine demo), Mint's playground
  (Genesis Grove putting over splat landscapes, Breakline, Boulder Cove: MIT, but Next.js builds),
  Meticulai's Lost Marbles and Marble Golf, Neil the Seal, Eagle's Descent (the Apollo landing),
  Island Three (an O'Neill cylinder), Riviera Rivals, Snooker Sim, putt.day, Three Pins,
  InFlightSimulator, Biplane Skirmish and Cosmos Journeyer (AGPL, 443 MB). Hostable once looked at:
  Felt World (MIT, no build), ABYSSAL (MIT, Vite), Summer Cycle (MIT, but 460 MB of screenshots in
  its repository), Furkiozknn's Turkish series (Çay Ocağı and more: MIT, no build), Tiny Yurts and
  Dante (MIT js13k entries), Mistwood Cottage (CC BY) and Atlas of Space (Apache-2.0). Places:
  SuperSplat's Datang Everbright City (Xi'an), a Tehran mirror hall, the Queen's Hamlet at
  Versailles, Mont-Saint-Michel and Wat Paknam; CyArk's Tapestry tours need CyArk's permission
  first, and Park Atlas is built on other companies' brands. Made for WebGPU, so for a real GPU:
  Prasenjit Nayak's Island (MIT), Galaxium, Snow Day, Graveyard Pinball, Fractal Worlds, Jelly Baby
  and Abuja Tour.
  Rækk du ferga? now opens rekkerduferga.no: its `www.` address sends the frame on there, and Orb's
  frame grants its permissions (fullscreen, sound, gamepads) to the address it was given only;
  `scripts/check-embeds.mjs` now flags such addresses.
- **Scouted on 6 November 2026**, a quiet day after the mega scout: nothing added. The three.js
  forum's Showcase still has no topics after 1 November and threejs.org's featured grid is
  unchanged. Show HN: **Fishtank Atlas** (fishtankatlas.com/play/aquarium: an aquarium that teaches
  the nitrogen cycle, but flat and mostly panels, and nothing swims until the tank has cycled) and
  **Engine-X** (engx3d.com: 3D machines to take apart; refuses a frame); a WebGPU wildfire
  simulation and a desktop-simulation game were not worlds. New in the AI Games Feed: **HarbourLine**
  (simharbor.net, a cozy port builder) and **SKYWAKE** (a kite flight on usecrayon.ai) refuse a
  frame; **Glass Break** (Prasenjit Nayak's bottle-shooting range) is slight; Airsup's factory
  scenes are a company's product demos.
- **Scouted on 7 November 2026**: the three.js forum's Showcase woke up with about 35 new topics.
  Added **Walking Into Van Gogh** (Float's multiplayer walk through the starry-night village and
  Vincent's bedroom; only talking with Vincent needs a login), **Horizonte Quetzal**
  (GersonCode-prog, MIT, hosted: a quetzal falling into a ray-traced black hole; its text is in
  Spanish), **Rhyflitzer** (freaxnx01, MIT, hosted: an open-world racer through real towns on the
  Hochrhein, built from OpenStreetMap and swisstopo data), **Latte Art** (latteart.app) and
  **DRIFTIT** (driftit.app). **Coccolith** (iwakicyan/coccolith, CC BY 4.0 by its page's footer: a
  tiny pixel-art planet whose creatures keep to your clock) draws on its own site but not hosted:
  its 3D parts are a git submodule (iwakicyan/my-3d-parts), which GitHub's tarballs leave out, its
  code reads a Vite `define` (`__CHANGELOG__`, from `git log`), and its page's inline style loads
  `/ui/` from the site's top. Hosting it needs the importer to fetch submodules (False Earth's
  engine is one too), give a `define` a value and rewrite root paths in inline styles; as an embed
  it would still need its check inside Orb. Left out: **Stovetop** (frustum.me: five dishes on a gas
  hob with heat, oil and flame simulated) and **Vizbite** (fruits cut open to show their nutrients)
  refuse a frame; **Beyond Portals** asks for a Google sign-in; **Toonda** is a commercial MMO
  behind tracking cookies; **Gargantua** is Interstellar's black hole; **Slug Thug** is 21+ (cartoon
  weed growing); The Happy Hour & Co., Abdel rahman Ghannoum's portfolio and Homecraft are a
  studio's and people's own sites; Piramidka and CHROMA VIVA 008 are slight toys; CLANG! is a
  shooter shown only in a video; Lightverse gave no link; GitHub Planet, PrintHaus, NeuralSpecOcean,
  Cinematic Decks, SpinMi, Three-Live, Mokizen, a discography and a splat advert for AUREA Residences
  were not worlds.
- **Scouted on 8 November 2026**: added **Freeze Out** (Krisztian Somoracz's four-against-four
  snowball fight with bots, from the three.js forum; embedded at `newkrok.com/games/freeze-out/`,
  the address its Share button gives, since its page reserves all other rights) and **Millipool**
  (metalturtle's pool table overrun by billiard-ball millipedes, from the AI Games Feed and
  @threejs on X; its preview is cut from its maker's video). Left out: **Reges Town**
  (regestown.com, a city of AI citizens to walk, drive, cycle and fly through, from Show HN) sells
  advertising on billboards inside the city; **Particle Fighter** (Andrew Blumson's arcade fighters
  of 120,000 particles) runs on WebGPU only, with no fallback, so it waits for a real GPU; **Spiral
  Nest** (an ant colony in a bubble chamber) is 2D. The forum's other new topic, a renderer for
  vertical shorts, is not a world. Reddit answers this machine with a block page, so r/threejs and
  r/webgl went unread.
- **Scouted on 9 November 2026**: added **Ghana Street Games** (samuelaidoo45's 35 Ghanaian street
  games in 3D compounds and streets, from Show HN; CC0 characters and Poly Haven materials) and
  **FormulaZero** (builtbydimi's hybrid-era race car round Brianza Park, Monza's layout from
  OpenStreetMap and Lombardy elevation data, featured by @threejs; its preview is cut from its
  maker's trailer). Nothing was hosted: the database is over a free Supabase project's 500 MB, so
  open-source finds go in as embeds or wait until it has room. Left out: **Tides of Fortune**
  (tides-of-fortune.fr, silvestroz/tides-of-fortune: a 17th-century Caribbean pirate game, every ship,
  island and sound generated in code, among the best found) sits behind Vercel's bot checkpoint,
  which our headless checks can't pass ("Failed to verify your browser"), so nobody has seen it
  inside Orb, and its PolyForm Noncommercial licence rules out an Orb-hosted copy while Orb sells
  plans. **COO** (coo.mx: a spy pigeon over a hand-drawn downtown Toronto, featured by @threejs)
  was still on its loading screen ("calibrating near vision", phase 3 of 4) after seven minutes on
  this machine's software GPU, so it waits for a check on a real GPU. **Cake Farm** (a cozy communal
  farm) lets only itch.io frame it; **Midgarth Quest** is set in Tolkien's Middle-earth;
  **Samenland** (a medieval village that grows in real time, MIT) draws in 2D; **Camera Lab** (an exploded DSLR) is an object to turn rather than a world; a web client
  for 1995's WorldsAway, a PC configurator, a hiking roguelike and a chiptune tracker are not 3D
  worlds.
- **Scouted on 10 November 2026**: added **Streets of Nice** (Gwendall's arcade beat 'em up in a
  game shop in Nice, from the three.js forum; its preview is its opening scene, the looters gathering
  outside and flying back through the window, which runs for minutes on this machine before the
  fight). Nothing was hosted: the database is still over its space. **AFK City** (afkcity.com:
  Kushal Chudiwala's low-poly city that builds itself, which drew and grew to a town of 2,000 inside
  Orb) waits for a good video: its title screen's backdrop is a video, and at the recorder's size its
  own camera stays far overhead and dim, even zoomed; its maker's trailer is on YouTube
  (M6BRkQA0zZg), which this machine can't fetch. Left out: **Stop Walking** (stopwalking.online: one-button jumps through a psychedelic
  forest under a heckling fake live chat) is slight; Steam Deck OLED's and a branding studio's 3D
  showcases, a walk-through portfolio, room and gym planners (FormaNest, Spatium), an antenna
  simulator, music visuals (Lampjack), an atlas of LEGO sets and a conformal-geometry demo are not
  worlds. The AI Games Feed had nothing new.
- **Scouted on 11 November 2026**: added **What the Water Keeps** (Kevin Ngo's small boat steered by
  lantern light along a waterway through a chain of dreamlike realms, made with Claude Fable 5.2)
  and **Backrooms: Dimension 9** (apek's endless Backrooms whose rooms, characters and entities an
  AI keeps building, alone or with friends), both from X, their previews cut from their makers'
  videos; **BEYOND** (Afshin's solar system at true scale under the Gaia DR3 star catalogue, with
  real elevation data to land on; WebGPU with a WebGL 2 fallback, which is what drew here) and
  **Pastel Drive** (iolmao's cozy delivery game: parcels bring the colors back to a county a storm
  turned gray), both from the three.js forum. All four are embedded: the database is still over its
  space. Pastel Drive lays its countryside and traffic out at random, so its preview's take is
  seeded (the recorder's `seeded` init). Left out: **Akira Toriyama's drawing room**
  (bird.jacomakes.com, from Show HN) refuses frames; **Tiny València** (tinyvalencia.com, Valencia
  as an isometric city map, 220 points on Show HN) is drawn in 2D; **Alum Builder**
  (alum-builder.pages.dev) is an 18-step crystallography lesson rather than a world; a fan-made GTA
  6 radio wheel and Phoam (Android apps run in the browser; its demos are others' games) are others'
  work; a web studio's walk-in showroom, two landing pages (Modus, a black hole), a photo slider, a
  pergola configurator, a name picker, an AI face and Meanwhile on Earth (a globe of what distant
  observers would see of it) are not worlds.
- **Scouted on 12 November 2026**: added **Portals: Endless Worlds** (Ethan Mollick's hands-free
  flight through 471 generated worlds inspired by books, art and places, each opening onto the next
  through a portal; CC BY-NC-SA, so an Orb copy is ruled out while Orb sells plans), **Indiranagar,
  Live** (Aishwarya Das's square kilometre of Bengaluru from OpenStreetMap, the city's tree census
  and open building data), **Tilt Labyrinth** (lifcc's wooden ball maze), **Mist-Locked Gate** (歸藏's
  top-down xianxia action game with a boss and voice acting, the demo of an agent skill, AGPL) and
  **Tiny Planet** (Prasenjit Nayak's little round world to walk and fly round, MIT), all embedded
  while the database is over its space. Mist-Locked Gate's and Tiny Planet's previews are drawn at
  one device pixel per CSS pixel: at two they stall this machine's software GPU, as Walking Into Van
  Gogh did. Held for another day (five a day at most): **Turbo Tails** (Peter Yang's kart racer,
  turbo-tails.vercel.app; the recorder stalls on it at two device pixels too, so record it at one,
  and its trailer has titles over nearly every shot), **Saltwind** (a cozy sailing game with quests,
  ports and a giant squid, sheshadharihariharan.github.io/saltwind), **Cayley** (a flight simulator
  over real terrain in live weather, lauramionel.github.io/cayley-flight-simulator), **Lanternfall**
  (an idle battler by lantern light, loktar00.github.io/lanternfall, 182,000 views on X; not yet
  checked inside Orb), **Vancouver From Above** (vancouver.webly.site) and **Season World** (an
  alpine basin through four seasons, ryx168.github.io/maple-larch-d5e5). Left out: **Collection of
  Beauty** (a walkable museum of public-domain art, from Show HN), **Tour du Pain** (a cycling game
  for smart trainers round a lake in southern France, from the three.js forum), **Mini Racing** and
  **Threshold** refuse frames; **Rage Garage** (wrecking a supercar six ways) is WebGPU only and was
  still compiling its shaders here; **ELITE WARFARE** (a body-cam tactical shooter) is built on
  Karen Warfare's code, which has no licence, with models of unknown authorship; **I Would Have
  Gotten Away With It** is a reverse Scooby-Doo; howsmallarewe.com and Faraway fly the solar system
  as yesterday's BEYOND does; Common Crawl's CCBot platformer, a transit-planning game for the Bay
  Area, Isometric Burlington and a map of Persia through time are 2D; a portfolio in a cave, a
  juggling animation tool set in Paris, Escapee (a countdown page), landing-page comparisons,
  Perigee (a satellite viewer) and a voxel algorithm playground are not worlds. Repositories with no
  live site: Pickleball 3D (phantom0708/pickleball-3d, MIT: bots, online doubles, ten courts; a
  sports game to host once the database has room) and Shohorer Pothe (Dhaka's streets). Dustfall
  (dustfalls.netlify.app, an open-world western) didn't load in the screenshot pass, so look again.
- **Scouted on 13 November 2026**, a quieter day (no new topics in the three.js forum's Showcase):
  added **TukTuk** (basemazab's tuk-tuk weaving down a crowded Egyptian street past microbuses and
  watermelon carts, everything drawn in code; its words are in Arabic; found through Fable52.games)
  and **Riverlight** (KK's quiet kayak paddle down an endless river, from GitHub), both embedded
  while the database is over its space. Held for another day: **Pocket Soccer 3D** (Shaun Price's
  seven-a-side football with referees, offside and cards, shaunprice.github.io/soccer-3d: its
  stadium flight doesn't run on the recorder's clock and a match is three taps in, past an artwork
  screen and the intro, so its clip needs working out), **Ironvale** (SharpWizard's real-time
  strategy game with a four-chapter campaign, sharpwizard.github.io/ironvale: its first view is a
  small lit patch in fog under a large HUD), **Evensong** (a souls-like duel in a drowned cathedral,
  evensong-phi.vercel.app, the most beautiful of the day: neither it nor Fable52.games names its
  maker), **Dustfall** (dustfalls.netlify.app, an open-world western whose first scene is plain),
  **Time on the Water** (fishing on a lake at dawn, daiyu3659.github.io/fish) and **Saltwind** (its
  ship stays moored until the first quest, so the recorder's sail went nowhere). Seen only at their
  title screens, for a later look: Bayhaven (fablestar.games, an open-world crime game written live
  by Fable 5.2), Daedalus (a clockwork puzzle), Emberdeep (a torchlit dungeon), Rali Rodopi (a rally
  in Bulgaria's Rhodopes) and Schiffsbruch 3D (naval combat). Left out: **Hong Kong Birthday
  Patrol** (lyfar.com: flying presents to Hong Kong's buildings on their birthdays) refuses frames;
  **MAAD MAXXING** (a buggy chase featured by @threejs) is WebGPU only; Fable52.games also lists a
  Black Myth: Wukong boss fight and a League of Legends mode, others' games; Hanford Reach (a cozy
  settlement builder) and hahaliu1029's four (MOTHLIGHT, Tidebell, 青云宗, MISREMEMBER) have no site of
  their own that I found; EARTH_PLAN (a climate-disaster simulator round a globe) and an elevation
  atlas are not worlds.
- **Scouted on 14 November 2026**, a quiet day for new posts (nothing new in the three.js forum, on
  Show HN or on Fable52.games), so the best of those held on earlier days went in: **Turbo Tails**
  (Peter Yang's kart racer round Wild Isle; its clip is drawn at one device pixel per CSS pixel, as
  at two it stalls this machine), **Cayley** (lauramionel's flight simulator: a Cessna over Sion in
  live weather, seen from its chase camera) and **Season World** (ryx168's alpine basin through the
  four seasons), with two from GitHub: **Hillside Days** (LanCodevex's hand-painted-looking cottage
  on a floating hillside, to turn from morning to a starry night) and **Mistvale Farm** (NorwinYu's
  farm in a misty valley, MIT), all embedded while the database is over its space. Still held:
  **Lanternfall** (its moor is very dark at this size), **Vancouver From Above** (not yet recorded),
  **NightClub: Drift & Speed** (www.nightclub-driftspeed.xyz, night drifting through a neon Tokyo,
  featured by @threejs; not yet checked inside Orb), and the ones held on 13 November (Pocket Soccer
  3D, Ironvale, Evensong, Dustfall, Time on the Water, Saltwind). Left out from GitHub: Plumb 3D (a
  skyline parkour run) and Aetheria (an open-world adventure) showed only their instructions or
  loading screens; FPV Sim (a drone simulator) is a settings panel first; Chatmalo (a calico kitten)
  is a model to turn; Neo Earth 2226, Grothendieckian Universe (a puzzle game of mathematics), a
  Moon-and-Mars archive for children and a 3D tour of a computer's power supply are for another look
  or not worlds.
- **Scouted on 15 November 2026** (the three.js forum's Showcase woke up again, plus Show HN, GitHub
  and Fable52.games): added **Last Light** (Kylian Mallet's long Antarctic day as an emperor penguin
  chick, from GitHub), **Komok** (Norra Dev's multiplayer sticky ball rolling up an island town,
  coins and pencils first, cars and a house later) and **A Little Corner of Japan** (paladium's
  Komorebi, from GitHub: an isometric street corner to turn, with a ramen shop, a tea room and a
  study to step into, a clock to run into the night, and a city builder behind its Build a city
  button; its clip is filmed as a page at a laptop's size, as its canvas is see-through), all
  embedded while the database is over its space. Its first draft took the id of the Komorebi
  already in Explore (Sulat's pagoda garden): two worlds can share a name, so check the id is free.
  Held: **Woodangtang Seoul** (12-player co-op boss fights round Seoul, for phones too; its clip
  never got past the parachute drop into Gwanghwamun Plaza), **Vancouver From Above** (@tokifyi's
  city stands still as it opens: it needs a flight to film), **NightClub: Drift & Speed** (the car
  hardly moved in its clip), **The Lost Storm** (an isometric action RPG, MIT on GitHub, that starts
  at a name and sign-in screen) and **Aali** (satyasairay's marble game under a banyan: its clip
  needs a scripted flick of the shooter). Left out: Boys Theft Auto (an open world on Dhaka
  Cantonment's real map, under a GTA-parody name), Hornmere Square (a heavy splat scene that never
  finished a screenshot), Fable52.games' four new entries (Makinamon Pulso, Riftline, The County and
  Tidemark link only GitHub and aiarcade.games copies, no sites of their own), Midnight Grid,
  Thunder Valley and Deep Protocol from GitHub (title or settings screens first: for another look),
  Domino Rally (a 2D designer first, the 3D a click away), and Bagholder Online (a crypto trading
  room), Our Special World (a photo gift), Orbital Mechanics Sandbox (an N-body simulator) and an
  ink-wash wuxia inn (a studio's website), which aren't worlds. Tangle (Daniel Stephenson's game of
  strange loops) and Omnistew (a 3D multiplayer strategy game like Risk) refuse a frame.
- **Scouted on 16 November 2026** (ten new topics in the three.js forum's Showcase, plus Show HN,
  GitHub and Fable52.games): added **Nutmeg Street** (Vatsal Upadhyay's football game: curl the
  ball through the legs of people crossing a street and into the target, thirty stages, on phones
  too), **Oil Paint** (tianxiuyangyang's wanderer with a lantern on a snow ridge under the aurora,
  or in an autumn wood, all painted stroke by stroke; left to run, its paint crashed the recorder,
  so its clip is filmed in its own capture mode, `?capture`, a frame at a time through `lab.step`)
  and **Night Nabbers** (a raccoon heist game for up to 16 players a street, with bots and phone
  controls; its clip is its camera's flight down the street to the den, at half speed), all
  embedded while the database is over its space. Held: **Beporowa** (Majortarif's Bangla-first
  street racer through Borshabad, a megacity of rickshaw colours and monsoon floods: in both takes
  its car ran into the signboards of its first street within two seconds, so it needs a steered
  path). Held for a machine with a real GPU: **Petalwake** (jjcm's broom flight over an
  island of flower meadows, sea cliffs and harbour towns, MIT, at petalwake.non.io/v2: beautiful,
  but its 95 MB world takes minutes a frame here), **Vingt-Quatre Heures** (a 1970 Le Mans "film you
  can drive", with a 34 km drive round San Francisco Bay: it never got past its opening clock here)
  and **Long Drive** (shubham8111's calm drive along real roads from open map data: twenty minutes
  for eight frames, which found only a distant car behind a pine). Also held: **Tailwind Voyage**
  (Corne's cozy island game, a fox in a jeep: it stayed on its loading screen here) and **The Last
  Complication** (Show HN's watchmaking puzzle game, for another look). Left out from the forum:
  Gildrook (a RuneScape-like MMO whose public playtest ends on 17 November), Pixila's brick
  breaker, a gym's trophy room and a shader showcase (websites); from Show HN: Neon Canal
  (gamedevpl's anti-gravity racer in C++ and WebAssembly, simpler than the racers in Explore),
  Doom2D Forever, Hello Triangle and PongArena (2D) and PokéBonk (someone else's characters); from
  GitHub: about twenty near-identical tactical shooters made for a make.fun bounty, Castle Valley
  (an oil-brush remake of another artist's pixel-art post, whose site never loaded here), a Chinese
  translation of Petalwake, Last Harbor: Departure (survival horror in Chinese only), and for another
  look Synthwave City, Spot-light HD (a black lab chasing a laser dot), Haeryeong (a Joseon village
  life that never finished a screenshot), Lumpini Healing (a run round Bangkok's Lumpini Park), Red
  Dust, Neon Apex, Nightpiece (chess in a candlelit chapel) and a WWII patrol boat that never loaded;
  Curling Duel, a fantasy tower defence and a chameleon hide-and-seek are slight. Fable52.games' four
  new entries: Arcfall Artillery has a site of its own (arcfall.ez8.tools, turn-based artillery that
  opens on an online lobby); Black Tide, Undertow and Emberhold are only on aiarcade.games. AH NAH
  TRAH (Marco Ludovico Perego's duck walking to the sea, WebGPU) and Clayground (clayvr.com: a clay
  studio, the platform fighter Smoosh and the kart racer Kiln Cup) refuse a frame.
- **Scouted on 17–21 November 2026**, in one run: the session stopped part-way through 17 November
  and the daily runs of 18–21 November waited for it, so this one covered all five days (Show HN,
  the three.js forum's Showcase, which was quiet until a burst on the 21st, GitHub and about 45 new
  Fable52.games entries). Added, all embedded while the database is over its space:
  **Papertrails** (Shikhar's endless pop-up book, MIT: paper trees and houses fold up around the
  traveller as they walk; 127 stars in four days), **Squirrel** (swu-u's squirrel in an autumn
  town, climbing trees and power lines after acorns, phone first), **Blackburn Type D** (Andrej
  Dunaev's 1912 monoplane flown through four rings that open chapters on the surviving aeroplane;
  its clip starts in the air through its own `?fly=1`), **Santa Express** (thestringtheories'
  sixty-second sleigh run over a snowy village, filmed during its opening fly-through) and
  **Cherwell Valley Motor Club** (johnwards' classic cars in the stone villages of North
  Oxfordshire, from Show HN; its clip gives the Triumph a second and a bit of throttle, as two
  seconds take it across Deddington's market place into Otters Restaurant). Papertrails' and
  Squirrel's clips are drawn at one device pixel per CSS pixel: at two, one took an hour and the
  other crashed the recorder. Held:
  **A Goose Tale** (Mike Fernandez's goose finding its goslings in a dark wood, three.js WebGPU:
  still loading at 90% after half a minute inside Orb here), **Hidden Layers** (toby-bridges'
  glasswing butterfly through six worlds, a scroll-driven piece that didn't move on with the wheel
  here), **Portia** (Ville Mustonen's jumping spider hunting a jungle floor, MIT: its Begin threw an
  error here), **Paper Boat** (a river to float down, behind a name to type) and, from 17
  November, Luoyang City (a 1:1 open world of Luoyang), Escape the Fable (an MIT escape-room
  generator), Octoventure, Apex Lap, Duel Knights and Guangzhou Drift, for another look. Left out:
  **Rawza Ring** (a race on the real streets round Mazar-i-Sharif's Blue Mosque) for its
  billboards advertising its maker's channels; Devayan (Indian mythology, MIT: its play is far
  plainer than its title screen); The Wreck (a calm procedural dive, plain); Raptor Race (a
  portrait runner for iPhones); Maple Run (needs WebGPU); Flower Box (sells extras); Aevum (Google
  sign-in); Hold the Home (phones as its controllers); Interstellar (a film's ship and scene);
  Fable52's fan games of other studios' characters (a QQ Speed kart racer, CrossFire's Transport
  Ship, Black Myth's Tiger Vanguard, an ARAM arena); GTA-style cities (Delhi, Mumbai, Vice); more
  make.fun bounty shooters; Graveyard Shift, Last Return and Shutterpine (horror); portfolios, a
  VJ app (Lampjack) and Posy's flower cards; and for another look Toshkent 3D (Tashkent from
  OpenStreetMap), DOVA, Boo-mas, Ripcore, Pelican on a Bike, two rooftop parkour runs, Dune Run,
  Outpost Racer, Pocket Roads, Little Lifts, Hamster Colony and Free Kick Legends. Bellripple (a
  Korean temple garden, framed only on itch.io), DailyPlay Rally, Posy, Chongqing, Kiakia Dash (a
  bike delivery round Lagos), Wrongly Drawn, Compass Post (a geography game on a globe) and Rooftop
  Rally refuse a frame.
- **Scouted on 22 November 2026**, a quiet day for posts (nothing new in the three.js forum's
  Showcase or on Fable52.games since the day before, nothing frameable on Show HN), so mostly
  GitHub. With games' files kept on GitHub now, hosting is back. Added, hosted: **Woolly Island
  Park** (romy-826's island fairground made of felt, a carousel, a roller coaster and mushroom
  houses to walk among; its clip looks round from the mushroom houses, as the recorder's mouse wheel
  never reached its whole-island view to bring it closer), **Whisker Meadow** (LK1248's cozy cat
  sanctuary: win shy rescue cats' trust with slow strokes, phone first), **Kradas** (keaykub's Thai
  canal village of cut paper, MIT, whose gates lead to a realm of jade islands and a demon realm
  under a blood moon) and **Touchline Vale** (tzshanta-maker's eleven-a-side football against the
  computer, MIT, every model and sound made in code); embedded: **Khuntau** (Dulor's game of the
  Santal Sohrai festival: snatch pitha cakes round a bull tied to its post, or live the festival day
  in its story; its music isn't free to reuse, so it isn't hosted). Kradas has no page at its top
  and its gates link between folders: its start page (`src/data/seed-pages.ts`) runs the village
  with its `<base>` in the village's folder, and a folder's address in a world's files now goes on
  to its `index.html` (Next.js drops the slash at the end of an address, so `../realm-immortal/`
  loaded its page a folder up). Held: **Cheung Chau Flight Squad** (hkrgb's drone over Hong Kong's
  real terrain and aerial photographs, from Cheung Chau's harbour: a playtest build that changed
  version three times on the 22nd; for another look when it settles) and **Super Toy Plane Combat**
  (billysaas's dogfights through a giant toy house, MIT: hosted, it stops on its loading bar, as its
  online client is made from the page's own address, which a hosted copy doesn't have, and it has no
  site to embed). For another look: Garuda Control (Garuda's flight, with an optional ESP32 tilt
  controller), A-mazing Run (a medieval maze) and Comfy Golf (Ian Trimble's golf, in development
  behind a landing page). Left out: Little Swans Worldline (porcelain swans dancing on a moonlit
  lake, to music taken from someone's video), Majo no Tabitabi (a Wandering Witch fan game), Two
  Rivers (an India × Germany river world, mostly open water between small monuments), Apex Overland
  (an off-road racer plainer than the racers in Explore), Chaoluo Village (a student piece on the
  Hainan villages an earthquake sank in 1605, which opens as a website), Elsewhere (asks for a name
  and, peer to peer, shows other players your IP address), Latte Lattice (a café diorama toy),
  Burger Chick (shooting chickens for burgers), a shop's particle Christmas tree, AIsland (a test
  bench for AI models), Seoul City Walk (a React build), dozens of make.fun bounty entries
  (GTA-style crime cities, stealth games, spot-the-difference rooms), playable ads and tech demos.
- **Scouted on 23 November 2026** (24 new topics in the three.js forum's Showcase, posted on the
  22nd after that day's run, plus Show HN and GitHub). Added: **Ondeung** (dori's lantern festival
  of Jinju, South Korea: design a lantern and float it down the Namgang river among other people's,
  embedded, no code to host), **Spillway** (Ashwin Sathian's endless runner on a front door riding a
  hydrofoil through a flooded monsoon town, MIT, hosted), **Paperfold** (michidk's paper planes,
  folded, painted and thrown off a tower over a toy-coloured city, MIT, but embedded: its planes and
  their landings live on its own server; its clip turns to aim across the city, as a thrown plane
  flies differently each time and the recorder's met a wall) and **Tidewake** (James Thibaudeau's
  cel-shaded sailing between a hundred islands, no build step, hosted). Hosted, Spillway stopped at
  its first frame: it registers a service worker, and in Orb's sandboxed frame merely reading
  `navigator.serviceWorker` throws, so Orb's runtime now stands in for it with one that registers
  nothing (SPEC §7, checked in `scripts/test-runtime.mjs`). Held: **Glohop** (Vrat Bartonicek's any
  address on Earth built from OpenStreetMap as you arrive: Prague's Charles Bridge drew well, but
  its walker didn't move to the keys here and a drag of the mouse crashed the page, so no clip yet),
  **People of Bengaluru** (a lovely Koramangala to walk, but it is a city for Bengaluru's designers
  to meet: its walkers carry real people's names and employers; early access, Next.js),
  **Yunjianshan** (云间山, a calm walk up a mountain above the clouds: its site doesn't answer from
  here and its repository holds only its README and pictures), **Dive the SS United States** (Jon
  Michael Edwards's reconstruction of the liner's wreck: it stayed on its dive boat here) and, for
  another look, Outpost Racer, Starward (a space sandbox behind a species picker), Koi Pond
  (younis's garden diorama; Explore has Koi Canal and Kōyō-en), Open Learning Games (seven 3D Grade
  1 maths and English games, MIT) and JETSUN (Ant Games' 3D shoot-'em-up, which plays inside its
  site's own page). Left out: Yerevan Unlimited (a full-scale Yerevan to drive, but it sells its own
  currency), Bozkurt Online (an MMORPG whose site turns away automated visits), Belle Oaks (a
  leasing site's map) and Nepal's treks (a trekking company's site), Little Letters (scroll-driven,
  it didn't move with the wheel here), Gunport (another franchise's fighters), Thane's Quest and
  Mantar (2D), Worker 755 (needs an AI provider's key), VibeCity Kolkata (GTA-style, with guns),
  Coral Cruise and a Rahim Yar Khan bike tour (plain), Evergrow (a to-do list), Yelamu (a map of San
  Francisco in 1769), Rooftop Nights (its page was gone), and more make.fun bounty games,
  configurators and portfolios. The Romanian Museum of Inventors and TEB RUN refuse a frame.
- **Scouted on 24 November 2026**, quieter (six new topics in the three.js forum's Showcase, Show
  HN, two new Fable52.games entries and GitHub). Added, all hosted: **Saltgate** (Ardholt's salt
  marsh kept with the tides on a lunar clock: dig channels, work the sluices, fill the pans and
  trade the salt, MIT), **Kumo no Niwa** (NachoEstevo's girl and calico cat across seven floating
  gardens above the clouds, built from scratch with three.js and Web Audio, no license; its clip is
  its opening flight over the garden at night), and **Storm Hunters** (TheRealUFOBIRD's tornado
  chasing across a compressed United States, raymarched supercells, MIT; its clip is its title's
  tornado on the plains, drawn at one device pixel per CSS pixel as at two it took a minute a
  frame). Saltgate imports @opengamehq/sdk from esm.sh, whose first build of it took over half a
  minute here (it drew once it came). Held: **Yomatsuri Pinball** (たぬ's pinball on a summer festival
  table at night, everything made in code, MIT: it hosts and draws, once a start page sets
  `__BUILD__`, the version its Vite build writes in, but its table is tall and narrow, and the
  recorder's ball left the upper half within a second, so no clip yet), **Swish** (Ashwin Sathian's
  free throws on a rooftop court, MIT: its ball didn't take the recorder's drag here, for another
  look), **Nekomachi** (a rooftop cat in a pastel Japanese city: what it asks of you didn't show
  here), **Karipap Kitchen** (gabrielmlow21's curry puffs from scratch: charming, but slight),
  **Maido** (eleven towns at dusk to practise nine languages, with live voice and open chat among
  strangers) and **laisaochodung** (mitiapps's driving by Vietnam's traffic law, Apache-2.0: it
  refuses a frame but could be hosted; for another look). Left out: Online LP Café (a walkable copy
  of a real record shop in Suwon, but its storefront has a cart), SHAKY (a portal of mostly 2D
  mini-games), Ravenhush (horror), Dreamfield (a world builder), Learn Arduino and Open Flight
  (course sites), Chrometide (a picture tool), Fly Ball (steered with the head), Saltline Brawl (2D)
  and 天师摇人 (a slot machine) from Fable52.games, Photo Museum, Jensen Return and Kaukana, which
  refuse a frame, and more GTA-style cities, zombie shooters and make.fun bounty games.

- **Scouted on 25 November 2026** (four new topics in the three.js forum's Showcase, Show HN and
  GitHub; nothing new on Fable52.games or in games.omgithub.com's catalogue). Added, all hosted:
  **Feeling Free** (arjunkshah12345-hash's bike ride across a windy meadow of about 118,000 grass
  blades to a huge white city under an indigo cliff, with twelve paper lanterns to find and
  procedural music, no build step, MIT), **Lincoln Drive** (kalebbennaveed's Lincoln, Nebraska from
  the city's open GIS data, driven, walked, cycled or flown by helicopter from the State Capitol,
  with five stops to find; inspired by Matt Rubens's Go To Ann Arbor, no license) and **Final
  Seven** (Ho Lok Cheung's Denmark v France, the 2016 men's handball final, seven a side with real
  carrying rules: Explore's first handball; a Vite project Orb runs from its source, no license; its
  clip is the game's own computer-v-computer demo, which its page starts when its address has
  `?demo`, so the recorder's `init` hands it one, a world's srcdoc frame having no address). Held:
  **Tokyo Walker** (sonek-wq's PS1-style Tokyo, from Takeshiba Pier to Ginza and Tokyo Tower,
  retaking a grandfather's eight old photographs, with 101 achievements and 29 cats to find: it
  hosts and plays, but runs at a few frames a second on the test machine's software GPU and its
  opening is mostly pier and water, so it waits for a clip from one of its sights), **Microduck
  Lab** (R1chi33333's flock of 25 cm robot ducks loose in a comic-book house: its duck didn't step
  off its charging pad here, and its robot model is CC BY-NC-SA, so it would go in as an embed),
  **Melaka 1511** (louisenda86's alternate-history night in the Melaka sultanate's harbour: it
  stayed on its loading screen for over a minute here, for a check on a real GPU; one 15 MB model is
  over the 10 MB a file a world takes, so it would be an embed) and the **Veliko Tarnovo splat
  walk** (rosenk/tarnovo-splat-walk: Gaussian-splat streets of old Tarnovo made with World Labs'
  Atlas, with no page anywhere, and its finest scene is a 32 MB file). Left out: **Potala Palace**
  (kanshao2077's procedural palace at dusk, beautiful, but a model to turn rather than a place to
  walk), **Schloss Karlsberg Tour** (a lovely autumn walk on real LiDAR terrain, but an action RPG
  its makers rate 16+, with scares, ghost fights and a burning building), **EasyGreek Palace**
  (Greek words in plain rooms, taught in Russian), Gitaway (a work timer that grows a farm), Little
  Railway World (a flat map of Europe's railways here), Wish Courtyard (a React build whose walker
  didn't move here), Campus Chaos 3D (a blocky East Delhi campus), Bolones Autodrive (a synthwave
  crash toy behind a settings panel), BongBong (a tank shooter), Magic Carpet City (its site
  answered the checker with a 403), End User (2D), Zpup (an article's demo), Pet Everything (a 2D
  petting toy), Palabrones (a Spanish grammar game for a class of ten-year-olds), Patrician Hanse (a
  2D trading map after the Patrician games), Siv (a Civilization VI clone), Command 2120 (an online
  RTS modelled on Red Alert 2), the GPU demo gallery (Nvidia's and ATI's old demos), Go To Ann Arbor
  (Slop New York's engine in Ann Arbor, 334 MB; Explore has Slop New York), Taj Mahal 3D (an
  Electron app with a React build and no page), Solstice Manor (a LAN escape room for two), Starpuff
  Isle (gacha), a solar-system simulation and a PC screensaver from the forum, and more make.fun
  bounty games. **Fly** (mteinum/fly: an A320 over real Norwegian terrain, MIT, but it needs its own
  server for weather and ships), **Earth Marquee**, **Holmstead** and **Pool Club Live** refuse a
  frame.

- **Scouted on 26 November 2026**, quiet on the three.js forum (no new topics in its Showcase) but
  busy on Show HN, GitHub and Fable52.games, which is now aiarcade.games. Added: **Cold Smoke** (雪迹,
  huiskylabs's endless ski mountain that builds itself as you carve, above a sea of clouds from
  morning light to aurora, every picture and sound made in code; MIT, but its page is built by
  joining 56 source files, so it is embedded: a start page doing that join in the browser could host
  it; it takes over a minute to start on the test machine), **Brushwild** (Kevin Ngo's open world
  drawn in pen and pencil, an action RPG of towns, crypts and dungeons; MIT, but its TypeScript, TSX
  and a GLSL Vite plugin need a build, so it is embedded; its hero picker's Begin sits below a wide
  window's fold, so the recorder presses it by script), **Sky Islands** (StarKnightt's flight
  between floating islands and their waterfalls above the clouds at sunset, one HTML file, hosted;
  its 82 MB screen recording, which the page doesn't use, is left out as over the 10 MB a file a
  world takes), **Pramageddon** (DeveloperTheExplorer's nap shift outside a snowy Norwegian
  kindergarten, three prams to keep asleep; a Vite project, hosted, no license) and **Little Rally**
  (riyading's gravel stages through autumn woods with a co-driver reading the pace notes; its code
  isn't public, so it is embedded). Held: **Machine Wilds** (jungrok5: colossal walking machines in
  overgrown ruins, with times of day and weather; it crashed the test browser twice, for a check on
  a real GPU), **SOS Copter** (In Hoc Signo Ludimus's 90s-style helicopter rescue over a voxel
  Miami: its helicopter stayed on the pad here), **Free Flow** (glyphh-ai/free-flow, a downhill
  longboard race, Apache-2.0: it refuses a frame, so it could only go in hosted; not tried yet),
  **Eastfar** (a moody first-person fantasy walk made today) and **Lighthouse Cup** (a pixel-art
  volleyball match centre, MIT, which refuses a frame: more a management sim than a world). Left
  out: Ashen Hold (a vale on a world-moon, rough and heavily pixelated here), Cinderwatch (Kevin
  Ngo's tower defence), Roamwright (a worldbuilding engine's alpine viaduct to orbit), Endless
  Blocks (an autopilot flight over a blocky world), Tropical Speedboat (set in GTA VI's Leonida
  Keys), Steal from Granny (a sneak game behind menus and a shop), Ladro di cavalli 1038 (2D), Mud
  Pig Wash and Eggsimulator (toys), Slope Spy (a ski-resort comparison tool), Belt and Box (a
  conveyor-belt puzzle behind a consent prompt), cundi (a portfolio of small experiments), the DIT
  University campus map, Asterwood Academy (an AI tutor), Skyline Swing (it stayed black here), What
  the Dust Keeps (survival in a ruined Gaza Strip), Syndicate and qake (fights between players),
  Clashroids, Zork (text), a playable CD player and more make.fun bounty games. **One Fairway**
  (golf) and **Disc Unleashed** (ultimate frisbee) refuse a frame.

## Embeds we would add if their sites allowed it

These refuse to load in a frame (`X-Frame-Options` or `frame-ancestors`). Asking their authors to
let `orbworld.vercel.app` frame them would be enough: Slow Roads, PolyTrack, Null Range, Wild
Haggis Survivors, Field of Command, Astral War, Kart Royale, BuildYourTown, Little Flock, WenWare,
*Quick, Draw!*, Blob Opera, Infinite Craft, Sandboxels, Coastal World, Igloo Inc, Marble by World
Labs, Still Night, Tidebreaker, Operation Elsewhere, Heatsink, Junkyard King, Clash Karts, Kage no
Michi, Claude of Tanks, GTA Kenny City, Wyrmhole, The Aviator, Engine-X, HarbourLine, SKYWAKE,
Stovetop, Vizbite, Cake Farm, Akira Toriyama's drawing room, Collection of Beauty, Tour du Pain, Mini Racing,
Threshold, Hong Kong Birthday Patrol, Tangle, Omnistew, AH NAH TRAH, Clayground, Bellripple, DailyPlay Rally,
Posy, Chongqing, Kiakia Dash, Wrongly Drawn, Compass Post, Rooftop Rally, the Romanian Museum of Inventors (wolfitway.com), TEB RUN, Photo Museum, Jensen Return, Kaukana, Earth Marquee, Holmstead, Pool Club Live (on wavedash.com), Fly (fly.teinum.no), One Fairway, Disc Unleashed, and the games on genex.games (Snowball, Midnight Apex) and on claude.ai artifacts (Mini Moto).

Three refuse a frame but are MIT on GitHub, yet are too big for a world (200 MB and 10 MB a file since, `FILE_LIMITS` in
`src/server/files.ts`) and need a Vite build: **False Earth** (momentchan/false-earth: an astronaut
walking a WebGPU planet of a million grass blades and flowers, the most beautiful thing found;
84 MB of assets, and its engine is a git submodule), **Neon Zenith** (billpwchan/neon-zenith: a
neon Kowloon to drive and fly; 181 MB built) and **Halcyon** (billpwchan/halcyon: a tropical atoll
with an FFT ocean, scanned reef and whales; about 560 MB, with scanned assets under their own
licences). Hosting them needs worlds that can be bigger, or their large files served from a CDN.

## Where many more worlds could come from

Surveyed on 5 November 2026, for growing Explore from a few hundred worlds towards many thousands.
Counts are each source's own on that day. Ranked by how many good worlds each could give:

1. **Slop Cities** (github.com/zz85/slop-cities): Slop New York (mrdoob, MIT, plain ES modules,
   no build) remixed into other real cities. `cities.yml` lists 83 live addresses; 66 frame; 29
   cities are outside Europe and Japan (Abuja, Kaduna, Nairobi, Bangkok, Dubai, Hong Kong,
   Riyadh, Seoul, Shanghai, Singapore, Taipei, Buenos Aires, Uruapan…). Most forks keep the MIT
   licence, so Orb can host them. Map data is OpenStreetMap or city open data, which wants
   credit. Quality goes with each city's data and its author's care, so look at each; the
   repository's `screenshots/` folder makes the first pass quick. Slop New York and Riyadh 360
   went in on 6 November.
2. **SuperSplat** (superspl.at, by PlayCanvas): 17,660 public Gaussian-splat scenes, 1,730 of
   them walkable, listed by an open JSON API
   (`playcanvas.com/api/splats/explore?sort=views&order=-1&limit=100&skip=N`, plus `&search=`
   and `&features=walkable`) with views, likes, size, licence and thumbnails. The player frames
   fine. Only about a third of even the most viewed are places (the rest are objects, food and
   test scans), so pick by hand from the top of the walkable list, preferring scenes under about
   300 MB. Of the 688 most seen, 505 have no licence (embed them) and 145 are CC BY. Makers worth
   following for places: flyoverzone, sa3d, schindelar3d, tosolini, azadbal, wu3d, misha_m, vwoo
   and project_eternal.
3. **Vibe Jam** (vibejam.com/api: every entry of @levelsio's AI game jam as one JSON document,
   no key): 2,028 games, 1,458 still up, 1,250 made with three.js. Its rules mean free, no login
   and an instant start; the winners and the most played are a ready shortlist (A Game About
   Capybaras Delivering Food, the 2026 winner, went in). Few have public code, so they are embeds.
4. **AI Games Feed** (games.omgithub.com/catalog.json, refreshed daily): 846 AI-made games with
   X likes, a 1–10 polish score, a reachability check, a poster and a 30-second clip. Without its
   fan games (about 125), itch.io pages (107) and what Orb has, roughly 80–100 working entries
   score 8 or more. Most have no public code. Velven, the best hand-picked catalogue until now,
   has answered HTTP 402 since 4 November.
5. **awesome-opus-5.5-games** (AgentsLoop's list, kept alive in the fork
   gamingnews5/awesome-opus-5.5-games: `games.json`): 3,581 games, each with its GitHub
   repository, 1,560 with a live demo (339 three.js). Mostly jam quality (about 1 in 10 of the
   rated ones is good enough), but it is the one big list where every world has code, about half
   of it MIT: the place to mine for hostable, remixable worlds (Furkiozknn's no-build series of
   Turkish places, Çay Ocağı among them, is a seam of about ten).
6. **Playground Arcade** (playgroundarcade.com/games.js): 2,627 games, about 100 more a day,
   tagged by genre (114 sports, many learning games); 1,501 are itch.io pages Orb can't frame and
   only 232 link source. Best for niches Explore lacks.
7. **Sketchfab** (`api.sketchfab.com/v3/search?type=models&categories=places-travel`, no key):
   millions of models whose embeds frame, but mostly objects to orbit. The real places sit with a
   few accounts: Global Digital Heritage (600+), CyArk (219), the Zamani Project (158, African
   heritage), RaizVR (146) and the Hallwyl Museum. Licences are per model.
8. **CyArk Tapestry** (tapestry.cyark.org/library): 77 narrated 3D tours of heritage sites (Petra,
   Great Zimbabwe, Djenné, Wat Arun, Rapa Nui, Chan Chan…), which frame and run on phones. Their
   policy allows free embedding only on non-commercial sites, and Orb sells plans: they need
   CyArk's written permission first (info@cyark.org).
9. **Smaller, steady streams**: threejs.org's featured grid (75 projects, about 30 added since
   September, nearly all worth a look; `api.fxtwitter.com/status/<id>` gives each post's numbers),
   PlayCanvas's published apps (`playcanvas.com/api/apps?sort=-plays`: about 60,000, all frame,
   but only 20–40 good), Babylon.js's demo and game pages (5–10), Awwwards' Games category (two
   or three a month among adverts), studios with many games on their own site (meticulai.com/games:
   16), js13kGames (each year's ranked entries; play.js13kgames.com refuses a frame, but many
   makers host a copy that frames, and their licences vary), Arrival Space (walkable scans
   with visit counts; not checked in a browser yet), and lists of one model's best work
   (fengyiqicoder/awesome-fable-5.2: 57 live pieces with their posts' likes; Portals and Indiranagar came from it;
   Fable52.games: about 110 games by 21 November, from Fable 5.2 and other models, whose play pages frame their
   makers' own sites and link their code; vibegamer.io, from ummydev/awesome-ai-games: vibe-coded games with play
   links, makers and models, not looked through yet).

Not sources: itch.io (answers a frame with a "hotlinked" page), Polycam, Scaniverse, KIRI Engine
and Google Arts & Culture (refuse frames), Luma (its gallery is gone), Spline (25,000 CC BY scenes,
but design pieces, and a scene can only be framed once its maker publishes it from an account),
Shadertoy (a Cloudflare challenge, a non-commercial licence, and its best-known artist forbids
showing his work elsewhere), wasmga.me (refuses frames; large GPL ports) and Teleport by Varjo
(splat captures with almost no audience).

To reach thousands, the step after this is a scout job that reads these listings every day,
drops what refuses a frame, is unreachable or is already in Explore, screenshots the rest and
queues them for a look, hosting whatever has code and a licence.
