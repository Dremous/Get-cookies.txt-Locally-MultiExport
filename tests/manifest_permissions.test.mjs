import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readJson = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

test('base manifest grants clipboardWrite for Copy buttons', () => {
  const manifest = readJson('../src/manifest.json');
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(manifest.permissions.includes('clipboardWrite'));
  assert.ok(manifest.permissions.includes('cookies'));
  assert.ok(manifest.permissions.includes('downloads'));
  assert.ok(manifest.permissions.includes('notifications'));
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
});

test('Firefox manifest only overlays Firefox-specific fields', () => {
  const firefoxManifest = readJson('../src/manifest-firefox.json');
  assert.equal(firefoxManifest.permissions, undefined);
  assert.equal(firefoxManifest.incognito, 'spanning');
  assert.equal(
    firefoxManifest.browser_specific_settings.gecko.id,
    '{2d467287-f51a-4e53-a13c-0855efcd6975}',
  );
});
