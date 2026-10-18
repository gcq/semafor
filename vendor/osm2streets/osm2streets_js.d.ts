/* tslint:disable */
/* eslint-disable */
export class JsDebugStreets {
  private constructor();
  free(): void;
  getNetwork(): any;
  toDebugGeojson(): string | undefined;
  getLabel(): string;
}
export class JsStreetNetwork {
  free(): void;
  findBlock(road: number, left: boolean, sidewalks: boolean): string;
  /**
   * Returns the XML string representing a way. Any OSM tags changed via
   * `overwrite_osm_tags_for_way` are reflected.
   */
  wayToXml(id: bigint): string;
  findAllBlocks(sidewalks: boolean): string;
  getDebugSteps(): any[];
  toGeojsonPlain(): string;
  /**
   * Returns a GeoJSON Polygon showing a wide buffer around the way's original geometry
   */
  getGeometryForWay(id: bigint): string;
  getOsmTagsForWay(id: bigint): string;
  toLaneMarkingsGeojson(): string;
  toLanePolygonsGeojson(): string;
  debugClockwiseOrderingGeojson(): string;
  toIntersectionMarkingsGeojson(): string;
  debugMovementsFromLaneGeojson(road: number, index: number): string;
  constructor(osm_input: Uint8Array, clip_pts_geojson: string, input: any);
  debugRoadsConnectedToIntersectionGeojson(i: number): string;
  debugClockwiseOrderingForIntersectionGeojson(intersection: number): string;
  /**
   * Returns the entire StreetNetwork as JSON. The API doesn't have guarantees about backwards
   * compatibility.
   */
  toJson(): string;
  zipSidepath(road: number): void;
  collapseShortRoad(road: number): void;
  collapseIntersection(intersection: number): void;
  /**
   * Modifies all affected roads
   */
  overwriteOsmTagsForWay(id: bigint, tags: string): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_jsdebugstreets_free: (a: number, b: number) => void;
  readonly __wbg_jsstreetnetwork_free: (a: number, b: number) => void;
  readonly jsdebugstreets_getLabel: (a: number) => [number, number];
  readonly jsdebugstreets_getNetwork: (a: number) => any;
  readonly jsdebugstreets_toDebugGeojson: (a: number) => [number, number];
  readonly jsstreetnetwork_collapseIntersection: (a: number, b: number) => void;
  readonly jsstreetnetwork_collapseShortRoad: (a: number, b: number) => void;
  readonly jsstreetnetwork_debugClockwiseOrderingForIntersectionGeojson: (a: number, b: number) => [number, number];
  readonly jsstreetnetwork_debugClockwiseOrderingGeojson: (a: number) => [number, number];
  readonly jsstreetnetwork_debugMovementsFromLaneGeojson: (a: number, b: number, c: number) => [number, number];
  readonly jsstreetnetwork_debugRoadsConnectedToIntersectionGeojson: (a: number, b: number) => [number, number];
  readonly jsstreetnetwork_findAllBlocks: (a: number, b: number) => [number, number];
  readonly jsstreetnetwork_findBlock: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly jsstreetnetwork_getDebugSteps: (a: number) => [number, number];
  readonly jsstreetnetwork_getGeometryForWay: (a: number, b: bigint) => [number, number];
  readonly jsstreetnetwork_getOsmTagsForWay: (a: number, b: bigint) => [number, number, number, number];
  readonly jsstreetnetwork_new: (a: number, b: number, c: number, d: number, e: any) => [number, number, number];
  readonly jsstreetnetwork_overwriteOsmTagsForWay: (a: number, b: bigint, c: number, d: number) => void;
  readonly jsstreetnetwork_toGeojsonPlain: (a: number) => [number, number];
  readonly jsstreetnetwork_toIntersectionMarkingsGeojson: (a: number) => [number, number];
  readonly jsstreetnetwork_toJson: (a: number) => [number, number];
  readonly jsstreetnetwork_toLaneMarkingsGeojson: (a: number) => [number, number];
  readonly jsstreetnetwork_toLanePolygonsGeojson: (a: number) => [number, number];
  readonly jsstreetnetwork_wayToXml: (a: number, b: bigint) => [number, number, number, number];
  readonly jsstreetnetwork_zipSidepath: (a: number, b: number) => void;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_2: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __externref_drop_slice: (a: number, b: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
