// Every source file must parse as an ES module. The UI modules aren't imported
// by any other test (they need a DOM), so a syntax slip there used to pass the
// suite and then blank the whole app in the browser. Note `node --check` alone
// does NOT catch these (it exits 0 on some module syntax errors).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
});

for (const file of [...walk('src'), 'sw.js']) {
  test(`parses as an ES module: ${file}`, () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: readFileSync(file) });
    assert.equal(r.status, 0, `${file}\n${r.stderr.toString().split('\n').slice(0, 6).join('\n')}`);
  });
}
