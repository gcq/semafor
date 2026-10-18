# osm2streets (browser build)

- Source: https://github.com/a-b-street/osm2streets, commit `fc119c47dac567d030c6ce7c24a48896f58ed906` (main, 2025-10-02), crate `osm2streets-js` 0.1.4 (the same commit the live Street Explorer was deployed from).
- Licence: Apache-2.0 (`LICENSE`).
- Build (Docker, rust:latest, wasm-pack installer): `cd osm2streets-js && wasm-pack build --release --target web`.
- Size: wasm 2,821,745 B raw, ~1,018,000 B gzip; glue JS 27 KB.

## API
```js
import init, { JsStreetNetwork } from './osm2streets_js.js';
await init();                       // fetches osm2streets_js_bg.wasm next to the glue (also works in a module Worker)
const net = new JsStreetNetwork(osmXmlBytes /* Uint8Array, NOT a string */, clipGeojson /* one-Polygon FeatureCollection or '' */, opts);
net.toLanePolygonsGeojson(); net.toLaneMarkingsGeojson(); net.toIntersectionMarkingsGeojson(); net.toGeojsonPlain(); net.free();
```
Options (all required): `{debug_each_step:false, dual_carriageway_experiment:true, sidepath_zipping_experiment:false, inferred_sidewalks:false, inferred_kerbs:true, date_time:null, override_driving_side:'Right'}`.
(`osm2lanes` option no longer exists.)

**`inferred_sidewalks` must be `false`** to get crosswalks: when true, separately mapped footways and `footway=crossing` ways are dropped, so no zebras. Zebras come out of `toIntersectionMarkingsGeojson()` as `marked crossing line` stripes (Signalized/Marked crossing intersections) and `unmarked crossing outline`.
