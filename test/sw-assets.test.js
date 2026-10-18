// The service worker precaches ASSETS at install; any module missing from it
// breaks offline boot after an update. Keep the list in sync with src/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const body = sw.match(/const ASSETS\s*=\s*\[([\s\S]*?)\];/)?.[1];
const assets = [...(body ?? '').matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]);
}

test('sw.js ASSETS is parseable', () => {
  assert.ok(body, 'ASSETS array literal not found in sw.js');
  assert.ok(assets.length > 0);
});

test('every .js file under src/ is precached', () => {
  const listed = new Set(assets);
  const missing = walk(join(root, 'src'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => relative(root, f).split('\\').join('/'))
    .filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `not in sw.js ASSETS: ${missing.join(', ')}`);
});

test('vendored osm2streets files the app loads (.js, .wasm) are precached', () => {
  const listed = new Set(assets);
  const loaded = walk(join(root, 'vendor', 'osm2streets'))
    .filter((f) => f.endsWith('.js') || f.endsWith('.wasm'))
    .map((f) => relative(root, f).split('\\').join('/'));
  assert.ok(loaded.some((f) => f.endsWith('.wasm')), 'osm2streets wasm not found');
  const missing = loaded.filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `not in sw.js ASSETS: ${missing.join(', ')}`);
});

test('Overpass is never cached: the fetch handler only touches our origin and the CDN libs', () => {
  assert.ok(!/overpass/i.test(sw), 'sw.js must not mention Overpass');
  assert.match(sw, /if \(!ours && !cdnLib\) return;/);
});

test('every local ASSETS entry exists on disk', () => {
  const stale = assets.filter((a) => !existsSync(join(root, a)));
  assert.deepEqual(stale, [], `stale ASSETS entries: ${stale.join(', ')}`);
});
