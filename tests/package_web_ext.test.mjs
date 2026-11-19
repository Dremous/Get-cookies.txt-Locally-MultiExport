import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('web-ext is a pinned devDependency used by the AMO workflow', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const lock = JSON.parse(
    readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'),
  );

  assert.equal(pkg.devDependencies['web-ext'], '10.8.0');
  assert.equal(lock.packages['node_modules/web-ext'].version, '10.8.0');
});
