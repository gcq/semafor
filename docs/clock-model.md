# Clock model (v2): stateless timing from taps

Taps and the map are the only facts. Everything about timing — cycle, plans,
corridors, actuated lights, outliers — is recomputed from them by one pure,
deterministic function. A cache may hold the result, keyed by a hash of its
inputs; it is never edited and never authoritative.

## Inputs

- `observations`: the tap log (`src/domain/model.js` Observation). Only
  `kind: 'onset'` taps with `headId`, `aspect`, finite `t` count. A tap means
  "this light just changed to this colour". Others are reported as dropped.
- `intersections`: the map. Only `id`, `name`, `heads[]` are used. Stored
  `plans` / `headPositions` on intersections are legacy and IGNORED.

Vocabulary: a **light** is a head (`headId`). A **mark** is a light+colour
transition, key `"<headId>|<aspect>"`, e.g. "Pont turns green". A light tapped
only on green has one mark, and that is enough to predict its next green.

## Tap error model

A tap is never before the change: `tap = change + lag`, `lag >= MIN_LAG (0.2 s)`.
The lag's spread is LEARNED from the data (residuals above each mark's
earliest-consistent position within sittings), not hard-coded. Expected about
0.2 s typical, 90% < ~1 s. Fit with a one-sided loss (e.g. shifted exponential).

## Pipeline — `computeModel({ observations, intersections }) -> Model`

1. **Clean**: drop non-onset / unknown-light / old-format taps, and a repeat of
   the same mark within 20 s (double tap). Report each with a reason.
2. **Sittings**: taps across ALL intersections, split where the gap > 3 min.
3. **Cycle per sitting**: same-mark gaps / round(gap / C) — local estimate.
4. **Plans** per intersection: sittings grouped by cycle length (agree within
   ~2 s) and time of day. A plan = time windows + cycle. Taps only inform their
   own plan. Sittings without a cycle estimate attach to the plan nearest in
   time of day.
5. **Clock fit** per group (initially an intersection's plan): unknowns are the
   cycle C, each mark's position `posSec`, and one offset per **day**
   (day key = local date of `t - 4 h`). Three hypotheses, chosen by
   leave-one-day-out prediction error (NOT by in-sample fit):
   - `steady`: all day offsets 0.
   - `nudged`: day offsets ~ N(0, σ²), σ learned.
   - `independent`: days unrelated (σ = ∞) — no prediction without a tap that day.
   Needs taps on >= 3 distinct days to claim `steady`/`nudged`; else `independent`.
   Gaps inside a sitting always inform C; links across days inform C only under
   `steady`/`nudged`. Fractional cycles are allowed (no integer prior).
   Within-day drift (`driftSecPerHour`) is fitted only if some day has sittings
   >= 2 h apart; otherwise null ("unknown").
6. **Corridors**: two intersections' plans merge into one group when their cycles
   agree and their same-day phase difference repeats (within ~1.5 s) on >= 2
   days. A group shares one day offset per day: a tap at any member anchors all.
7. **Actuated**, per mark: its position wanders within sittings by more than the
   lag model explains (e.g. spread > 3 s, or a duration varying > 7 s inside
   one sitting AFTER accounting for missed taps: a gap of ~k cycles + d is a
   missed tap, not a sensor). Always recomputed; reversible.
8. **Influence**: leave out each sitting (and each tap in a suspicious sitting):
   - disagrees with its own sitting -> `outliers[]` `{kind:'slip', gainSec}`;
     excluded from the fit.
   - disagrees only with other days -> a day nudge; recorded in
     `clock.dayOffsets`, never excluded.
   Also produce `usefulTaps[]`: the single tap that would most improve a fix.

Determinism: no randomness, stable sorts (by `t` then `id`), fixed grids.
Must run in a Web Worker and in Node (no DOM, no storage).

## Model (output)

```js
{
  algoVersion: 'clock-2',
  computedAt: number,                 // ms; informational only
  lag: { minSec: 0.2, medianSec, p90Sec },
  sittings: [{ id, t0, t1, intersectionIds: [], tapIds: [] }],
  dropped:  [{ tapId, reason }],      // clean step
  outliers: [{ tapId, sittingId, kind: 'slip', gainSec }],
  groups: [{
    id, intersectionIds: [], headIds: [], corridor: boolean,
    plans: [{
      id,
      windows: [{ fromMin, toMin }],  // local minutes of day; may wrap
      dayClass: 'all' | 'weekday' | 'weekend',
      cycleSec, cycleSigmaSec,
      marks: { '<headId>|<aspect>': { posSec, spreadSec, n, actuated } },
      clock: {
        hypothesis: 'steady' | 'nudged' | 'independent',
        epochMs,                      // cycle start reference
        nudgeSigmaSec: number|null,
        driftSecPerHour: number|null,
        dayOffsets: { '<YYYY-MM-DD>': sec },
        heldOutErrSec: number|null,   // median |error| predicting held-out days
        days: number,
      },
      sittingIds: [],
    }],
  }],
  lights: { '<headId>': { intersectionId, groupId, aspects: [], actuated: [] } },
  usefulTaps: [{ headId, aspect, why, gainSec }],
}
```

Predicted change time of mark k on day d (no drift):
`epochMs + 1000 * (dayOffsets[d] ?? 0) + 1000 * posSec + n * 1000 * cycleSec`.

## Prediction — `src/predict/next.js` (pure)

- `nextOnset(model, headId, aspect = 'green', now)` ->
  `{ inSec, plusMinus, basis, planId }` or `{ unpredictable: true, reason }`.
  - plan in force at `now` for the light's group (by window / dayClass).
  - today's offset known (any tap today in the group's plan) -> `plusMinus` from
    lag (+ drift since that tap); basis like `'tap 4 min ago at <intersection>'`.
  - else `steady`/`nudged` -> offset 0, `plusMinus` includes σ; basis
    `'clock from N days'`. `independent` -> a **guess** (`guess: true`, basis
    `'guess · no tap today'`): circular mean of the past days' offsets for the
    mark's component, `plusMinus` = √(circular SD² + spread² + lag SD²) capped
    at C/2 (offset 0 and C/2 with no past days). Actuated mark -> unpredictable
    `'actuated'` (deliberately not predicted).
  - no plan in force at `now`, or none with this mark -> the nearest plan by
    window that has the mark, same logic, always `guess: true`, basis
    `'guess · other time of day'`. Still unpredictable: no taps for the light,
    no tap of that aspect in any plan.
- `currentAspect(model, headId, now)` -> aspect, or `null` when the light has
  fewer than 2 tapped colours (then the UI shows only the countdown) or a mark
  is unpredictable (guessed heads do get a colour).
- `phaseTable(model, intersectionId, now)` -> a legacy `TimingPlan`
  (`stages`, `epoch`, `cycleLengthMs`) built from mark positions, for the
  scene and editor preview; null if nothing is known.
- `withTap(model, tap)` -> a cheap copy with today's day offset re-anchored on
  that tap (instant UI response before the full recompute lands).
  `phaseTable` uses the same estimated offset when today's key is missing.
- `guardAspect(prev, modelAspect, now, known)` (`src/predict/sequence.js`) — the
  display guard: a head's shown colour only goes green→amber→red→green (over
  the aspects it has). A model colour that is not the shown one's successor is
  held; after 3 s of mismatch it steps one legal step (each stepped colour
  shows ≥ 1 s first), so it converges in ≤ 2 steps. `off`/`flash-amber` pass
  through; a user tap sets the shown colour at once. Live (scene + countdown)
  goes through it via `aspectNow`; Analyze/editor previews don't.
- Live shows a guess in dimmed italics with `±N s · guess · …` as caption.

## Running it (UI)

- Cache: IndexedDB `{ key, model }`, `key = hash(sorted tap ids+t, map heads,
  algoVersion)`. Boot: key matches -> "up to date"; else show cached model as
  "recomputing…" and compute in `src/inference/worker.js`, then swap.
- On each tap: `withTap` immediately, then full recompute in the worker
  (debounced ~1 s).
- Live: "Green in 23 s ±2" + basis + up-to-date/recomputing indicator.
  Current colour only when `currentAspect` is non-null.
- Analyze: per group — plans/windows, cycle, hypothesis and σ, drift, corridor
  members, actuated marks, outliers with gain, useful next tap.

## Privacy

The repo is public. Real tap data (even without GPS) never goes in it. Real-data
replay tests read `out/fixtures/real-taps.json` (gitignored) and skip if absent.
