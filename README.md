# Onda

A self-contained web app that shows the **current state of the traffic lights on your drive** — no server, no API, no account. It runs from a phone or the Tesla browser, works offline, and installs as a PWA.

The twist: Onda doesn't fetch signal state from anywhere (no such free feed exists). Instead it **learns each light from your taps alone** — you tap a button when a light changes, and Onda works out the cycle. Once a light is learned, its state at any instant is a *pure function of the wall clock*, so no live connection is ever needed.

## The core idea

A traffic signal is a timed state machine. Its transitions are either:

- **fixed** — fire at a fixed offset within a repeating cycle, so the next change is predictable from the **cycle length**, the **position** of each color in it, and a clock anchor.
- **actuated** — fire on a sensor (a car on a loop, a ped button). *Not* predictable; Onda says so instead of guessing.

How timing is learned: nothing is stored about timing, only taps. Every time, the whole model is **recomputed from the taps alone** — cycles per sitting, time-of-day plans, corridors of junctions that share a clock, and whether the clock repeats day to day or needs a fresh tap today. A tap today re-anchors the countdown; with no tap, Onda gives an honest "needs a tap" rather than a false certainty. The full spec is in [`docs/clock-model.md`](docs/clock-model.md).

Prior art that validates the approach: MIT/Princeton's [SignalGuru](https://mrmgroup.cs.princeton.edu/papers/Koukoumidis_SignalGuru_MobiSys_2011.pdf) (same idea, 2011), the [Open Traffic Lights](https://brechtvdv.github.io/Article-Open-Traffic-Lights/) SPaT/MAP ontology, and the dormant [OSM Traffic Signal Timings](https://wiki.openstreetmap.org/wiki/Proposed_features/Traffic_Signal_Timings) proposal.

## Vocabulary

| Onda term | Meaning |
|---|---|
| **Head** | one logical light (what you tap); sits on one or more **masts** (poles) |
| **Movement** | a maneuver from one road to another, controlled by one head |
| **Aspect** | what a head shows: green / amber / flashing amber / red / off |
| **Tap** | an observation: head X turned `aspect` at time `t` |
| **Plan** | a cycle for a time-of-day window (rush / off-peak / night) |
| **Corridor** | junctions whose plans share one clock |

## Architecture

Zero dependencies, no build step. Pure ES modules; the core never touches the DOM or storage, so it is fully unit-testable in Node.

```
index.html            app shell (dark/light follows the browser)
manifest.webmanifest  PWA install
sw.js                 offline cache
docs/clock-model.md   the timing model spec
src/
  domain/model.js     types, constructors, validation
  inference/
    clock.js          taps -> sittings, cycles, plans, corridors  (pure)
    worker.js         runs clock.js off the main thread
    heads.js          heads/masts/movements bookkeeping
  predict/next.js     model + now -> countdown, current aspect    (pure)
  nav/proximity.js    GPS -> forward cone -> ETA ranking          (pure)
  store/db.js         IndexedDB (intersections, taps, model cache) + JSON import/export
  sync/
    merge.js          reconcile two bundles (newest edit wins, taps union)
    net.js            encrypted peer sync over a public relay
  ui/                 app (glue), live-scene, editor, analyze, sync
tools/teslamate/      optional: infer taps from GPS history
test/                 node --test suites (clock, sync, nav, heads, ...)
```

Two UI modes, matching the two contexts:

- **Live** — a countdown for the next intersection GPS says you're approaching (heading also auto-picks your approach), with how it knows. Falls back to a tap-list when GPS is unavailable.
- **Capture** — three giant R/G/Y buttons. Tap when the light changes; timestamp + GPS are stamped automatically. This is the only thing you ever do from the car; the model is recomputed from the taps afterwards.

## Run it

The app is just static files. Because geolocation needs a secure context, serve it over `localhost` or HTTPS (not `file://`).

```sh
# any static server works; example with Python:
cd onda && python3 -m http.server 8080
# then open http://localhost:8080
```

For the car: host the folder anywhere that serves HTTPS (or add it to the home screen once loaded — the service worker keeps it working offline).

### Tests

No Node on this machine, so tests run in a throwaway container (folder-scoped, no global install):

```sh
docker run --rm -e TZ=Europe/Madrid -v "$PWD":/app -w /app node:22-alpine node --test test/*.test.js
```

## Roadmap

1. ✅ Pure core: clock model (cycles, plans, corridors, day-to-day hypotheses), prediction, proximity — all tested. Actuated lights are detected but deliberately not predicted.
2. ✅ Runnable shell: Live + Capture, Edit (poles and lights), Analyze, encrypted peer Sync, PWA/offline.
3. Green-wave visualization (time-space diagram) — needs visual iteration.
4. (Later, explicitly deferred) Interoperable export — SPaT/MAP JSON, GeoJSON, OSM timing relations. Not now.

## Safety

Onda is glance-oriented and always honest about uncertainty. It shows state and countdowns; it never tells you to go, and never implies precision it doesn't have. Don't stare at it while moving.
