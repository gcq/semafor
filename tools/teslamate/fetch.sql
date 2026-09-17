-- Dump TeslaMate GPS fixes for Onda's timing inference.
--
-- TeslaMate stores per-drive GPS in `positions` (speed in km/h, date is UTC).
-- We only need time, lat/lon and speed. Narrow to a bounding box around the
-- intersections you care about so the export stays small (edit the bounds, or
-- delete the WHERE to dump everything).
--
-- Produce NDJSON (one JSON object per line — what infer.js reads by default):
--
--   docker run --rm --network host -e PGPASSWORD=<pw> postgres:16 \
--     psql -h <host> -U teslamate -d teslamate -t -A \
--     -f tools/teslamate/fetch.sql > positions.ndjson
--
-- (-t -A = tuples only, unaligned, so each row is exactly the JSON string.)

SELECT json_build_object(
  'date',  to_char(date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'lat',   latitude,
  'lon',   longitude,
  'speed', speed            -- km/h; NULL is fine (infer.js derives it)
)
FROM positions
WHERE speed IS NOT NULL
  -- Optional bounding box (Madrid example — replace with yours):
  -- AND latitude  BETWEEN 40.40 AND 40.46
  -- AND longitude BETWEEN -3.72 AND -3.66
ORDER BY date;
