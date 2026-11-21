import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../scripts/firefox-e2e.mjs', import.meta.url),
  'utf8',
);

test('Firefox E2E enforces the 140+ desktop minimum', () => {
  assert.match(source, /Firefox 140\+/);
  assert.match(source, /const MIN_FIREFOX_VERSION = 140;/);
  assert.match(source, /readFirefoxVersion\(firefoxBinary\)/);
  assert.match(source, /firefoxVersion\.major < MIN_FIREFOX_VERSION/);
  assert.doesNotMatch(source, /Firefox 115\+/);
});

test('Firefox E2E uses distinct cookies for each test site', () => {
  assert.match(source, /const SITE_COOKIE_VALUES = \{/);
  assert.match(source, /'127\.0\.0\.1': 'abc123'/);
  assert.match(source, /'127\.0\.0\.2': 'def456'/);
  assert.match(source, /req\.headers\.host/);
  assert.match(source, /Single-site export leaked the other site cookie/);
});

test('Firefox E2E does not fall back to tab index zero', () => {
  assert.doesNotMatch(source, /tab\.index === 0/);
  assert.match(source, /No site tab URL matching/);
  assert.match(source, /Activated tab does not match/);
});
