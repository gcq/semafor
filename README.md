# Onda

A self-contained web app that shows the **current state of the traffic lights on your drive** — no server, no API, no account. It runs from a phone or the Tesla browser, works offline, and installs as a PWA.

The twist: Onda doesn't fetch signal state from anywhere (no such free feed exists). Instead it **characterizes each intersection from observation alone** — you tap a button when a light changes, and Onda learns the cycle. Once an intersection is characterized, its state at any instant is a *pure function of the wall clock*, so no live connection is ever needed.

## The core idea

A traffic signal is a timed state machine. Its transitions are either:

- **fixed** — fire at a fixed offset within a repeating cycle. Fully predictable from three numbers: **cycle length**, each stage's **split**, and an **epoch** anchoring the cycle to real time.
- **actuated** — fire on a sensor (a car on a loop, a ped button). *Not* deterministically predictable; Onda reports a **range**, never a false certainty.

This single distinction drives everything:

- **Fixed-time signals** → exact countdown to the next change.
- **Actuated signals** → honest "green for ~8–45s" ranges, clearly flagged.
- **Linkage between intersections** → falls out automatically: two intersections are *coordinated* (a green wave) when they share a cycle length and a **stable offset** between their clocks. A wandering offset means they're independent / free-running. You never draw these links by hand — the tool infers them.

Prior art that validates the approach: MIT/Princeton's [SignalGuru](https://mrmgroup.cs.princeton.edu/papers/Koukoumidis_SignalGuru_MobiSys_2011.pdf) (same idea, 2011: ~0.66s prediction error for pretimed, ~2.45s for actuated), the [Open Traffic Lights](https://brechtvdv.github.io/Article-Open-Traffic-Lights/) SPaT/MAP ontology, and the dormant [OSM Traffic Signal Timings](https://wiki.openstreetmap.org/wiki/Proposed_features/Traffic_Signal_Timings) tagging proposal (a future export target).

## Vocabulary (SPaT / MAP aligned)

Terms follow SAE J2735 so exports can interoperate, but the model shape is our own:

| Onda term | Meaning | SPaT/MAP analog |
|---|---|---|
| **Indication** | what a driver sees (red / green / yellow / flashing…) | `MovementPhaseState` |
| **Signal group** | controller entity whose state is displayed | signal group |
| **Movement** | a maneuver (through/left/right) tied to a signal group | movement / connection |
| **Approach** | direction you're *travelling* as you arrive (a bearing) | ingress |
| **Stage** | one step of the cycle: states held for a duration | phase interval |
| **Timing plan** | cycle behaviour for a time window (rush/off-peak/night) | signal timing plan |
| **Corridor** | inferred set of coordinated intersections | — |

The source of truth is the **controller cycle**, not the individual light. Each signal group's timeline is *derived* from the ordered stages — so lights within an intersection are correlated for free, and cross-intersection linkage is just an offset between two controller clocks.

## Architecture

Zero dependencies, no build step. Pure ES modules; the intelligent core never touches the DOM or storage, so it's fully unit-testable in Node.

```
index.html            app shell (dark/light follows the browser)
manifest.webmanifest  PWA install
sw.js                 offline cache (cache-first, own-origin)
data/sample.json      demo intersections (a Buenos Aires corridor)
src/
  domain/
    indications.js    the driver-facing states + SPaT names + colors
    model.js          types, constructors, validation
  predict/
    state.js          clock -> current indication + countdown  (pure)
  nav/
    proximity.js      GPS -> forward-cone -> ETA ranking        (pure)
  inference/
    cycle.js          observations -> cycle/splits, fixed-vs-actuated (pure)
    linkage.js        cross-intersection coordination detection  (pure)
  store/
    db.js             IndexedDB (intersections + observation log) + JSON import/export
  ui/
    app.js            thin glue: reads the core, paints the DOM on a timer
test/
    core.test.js      predictor + inference + nav
    linkage.test.js   coordination detection
```

Two UI modes, matching the two contexts:

- **Live** — big colored disc + countdown for the next intersection GPS says you're approaching (heading also auto-picks your approach). Shows confidence and flags actuated estimates. Falls back to a tap-list when GPS is unavailable.
- **Capture** — three giant R/G/Y buttons. Tap when the light changes; timestamp + GPS are stamped automatically. This is the only thing you ever do from the car; characterization happens later.

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
docker run --rm -v "$PWD":/app -w /app node:22-alpine node --test
```

## Roadmap

1. ✅ Pure core: predictor, cycle inference (fixed/actuated), proximity, linkage — all tested.
2. ✅ Runnable shell: Live + Capture, IndexedDB, import/export, PWA/offline, sample data.
3. ✅ Characterization in the UI (Analyze tab): observation log → draft plan with "N cycles, confidence" + per-stage fixed/sensor tags; accept as active plan.
4. ✅ Timeline editor (Edit tab): full CRUD on signal groups, approaches, and stages (duration, per-group indication, fixed/actuated), plus "start now" to pin the cycle to real time.
5. ✅ Coordination detection surfaced (Analyze tab): corridors + pairwise linked/independent verdicts with confidence.
6. Time-of-day plans (rush/off-peak/night-flash) — model supports multiple plans + schedules; editor currently edits the active plan only.
7. Green-wave visualization (time-space diagram) — needs visual iteration.
8. (Later, explicitly deferred) Interoperable export — SPaT/MAP JSON, GeoJSON, OSM timing relations. Not now.

## Safety

Onda is glance-oriented and always honest about uncertainty. It shows state and countdowns; it never tells you to go, and never implies precision it doesn't have. Don't stare at it while moving.
