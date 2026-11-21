import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

test('release bundles include the third-party notices and MPL license', () => {
  const buildScript = readFileSync(
    new URL('../scripts/build.js', import.meta.url),
    'utf8',
  );
  assert.match(buildScript, /THIRD_PARTY_NOTICES\.md/);
  assert.match(buildScript, /LICENSES\/MPL-2\.0\.txt/);
  assert.ok(existsSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url)));
  assert.ok(existsSync(new URL('../LICENSES/MPL-2.0.txt', import.meta.url)));
});
