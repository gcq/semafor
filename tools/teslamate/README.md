# Infer traffic-light timings from TeslaMate

A reusable, zero-dependency script that reads an **Onda export** (your defined
intersections) plus a **TeslaMate GPS dump** and reconstructs, per defined head,
a cycle length and green/red split — from your own months of driving.

## How it works (and what it can't do)

Your car is a moving probe. The clean signal a GPS trace gives is a **queue
departure**: when a car that was stopped at a light starts moving, that
approach's head just turned green. That's a real "green onset" — the same event
Onda normally reconstructs phasing from, only *sensed* instead of tapped. Two
weaker signals help: the car was **stopped** (red was present) and it **drove
through** without stopping (green was present).

From many of these over months, per head:

- **cycle length** — fold all onset times over candidate periods; the true cycle
  is the longest period they concentrate at (well supported → high confidence).
- **green-onset phase** + its spread — tight spread ⇒ fixed-time, wide ⇒ actuated.
- **green/red split** — bracketed by how far into the cycle you still drove
  through vs. the earliest you had to stop. This is an *estimate with a range*.

**Queues (ego isn't first in line):** a departure lags the real onset by the
queue-discharge time (~2s startup + ~2s per car ahead), which pushes the *mean*
departure late and inflates its spread. The script anchors the onset on the
**early edge** of the departures (the trips you were at/near the front) instead
of the mean, and judges fixed-vs-actuated from the **front-of-queue** spread only
— so heavy but consistent queues don't get misread as an actuated signal. The
report prints the **mean queue lag** (roughly proportional to your typical queue
length). Residual limit: if you're *always* deep in the queue at a light, even
the early edge is lagged and the onset reads a bit late — GPS can't count the
cars ahead to fully undo it.

**Other limits, honestly:**
- GPS cannot see **amber** — splits are green-vs-red only.
- Even at the front, the detected onset lags a few seconds (a departing car
  accelerates gradually and GPS is coarse), so green reads a touch short.
- **Head identification needs arm positions** in your export: the approach and
  departure bearings pick the from/to arm → movement → head. Place your arms on
  the map in the Edit tab. Without them the script says so and skips the head.
- Actuated (sensor) signals won't yield a clean cycle — they're reported as such.

## 1. Export your intersections

In the app's **Sync** tab → **Export** → save `onda-export.json`.

## 2. Dump TeslaMate positions

**Let the tool write the query for you** — it reads your export and bounds the
box to your intersections automatically (no manual editing):

```sh
docker run --rm -v "$PWD":/app -w /app node:22-alpine \
  node tools/teslamate/infer.js --export onda-export.json --emit-sql fetch.local.sql [--pad 350]
```

That writes `fetch.local.sql` (gitignored — keeps your location out of the public
repo). Its header has the exact run command. Then dump via `psql` in Docker
(nothing installed). If TeslaMate runs via docker-compose on this machine:

```sh
docker compose exec -T database \
  psql -U teslamate -d teslamate -t -A < fetch.local.sql > positions.ndjson
```

or against a reachable host:

```sh
docker run --rm --network host -e PGPASSWORD='<pw>' postgres:16 \
  psql -h <host> -U teslamate -d teslamate -t -A -f - < fetch.local.sql > positions.ndjson
```

`fetch.sql` is the un-tailored template if you'd rather edit the box by hand. CSV
and a JSON array are also accepted as input; recognised fields are `date`/`t`,
`latitude`/`lat`, `longitude`/`lon`, `speed` (km/h, optional).

## 3. Run the inference

No Node on this machine → use the same Docker image the tests use:

```sh
docker run --rm -v "$PWD":/app -w /app node:22-alpine \
  node tools/teslamate/infer.js \
    --export onda-export.json \
    --positions positions.ndjson \
    --out out [--radius 70] [--verbose]
```

Outputs in `out/`:

- **`report.md`** — the readable result, per intersection and head.
- **`inferred-plans-export.json`** — your export with a GPS-derived plan attached
  to each intersection (`rev` bumped). Import it in the **Sync** tab to preview
  live predictions. It touches only `plans`; your structure is untouched.
- **`inferred-observations.json`** — the synthesized green-onset observations
  (tagged `source: "teslamate"`), kept for the record / future in-app use.

## Tuning

Flags/defaults live in `DEFAULTS` in `gps.js` (association radius, stop/go speed
thresholds, cycle scan range, fixed-vs-actuated spread). `--radius` overrides the
association radius from the CLI. Add `--verbose` to also write `detail.json` with
every per-head sample count and bracket.

## Tests

```sh
docker run --rm -v "$PWD":/app -w /app node:22-alpine node --test test/gps.test.js
```
