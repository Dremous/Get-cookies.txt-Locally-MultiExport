import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(
  new URL('../src/popup.html', import.meta.url),
  'utf8',
);
const popupCss = readFileSync(
  new URL('../src/popup.css', import.meta.url),
  'utf8',
);
const batchCss = readFileSync(
  new URL('../src/popup-batch.css', import.meta.url),
  'utf8',
);
const popupJs = readFileSync(
  new URL('../src/popup.mjs', import.meta.url),
  'utf8',
);

test('popup document declares language, title, and color scheme', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Get cookies\.txt LOCALLY<\/title>/);
  assert.match(html, /name="color-scheme" content="light dark"/);
  assert.match(popupCss, /:root\s*\{[^}]*color-scheme: light dark/s);
});

test('tabs expose the ARIA tab pattern and roving tabindex', () => {
  assert.match(html, /role="tablist" aria-label="Popup sections"/);
  assert.match(html, /id="tabSingle"[\s\S]*?tabindex="0"/);
  assert.match(html, /id="tabMulti"[\s\S]*?tabindex="-1"/);
  assert.match(html, /aria-labelledby="tabSingle"/);
  assert.match(html, /aria-labelledby="tabMulti"/);
  assert.match(html, /role="tabpanel"[\s\S]*?tabindex="0"/);
});

test('search, table, and icons have accessible names', () => {
  assert.match(html, /aria-label="Filter sites"/);
  assert.match(html, /<caption class="visually-hidden">/);
  assert.equal((html.match(/<th scope="col">/g) || []).length, 7);
  assert.equal(
    (html.match(/class="material-symbols-outlined" aria-hidden="true"/g) || [])
      .length,
    9,
  );
});

test('popup CSS avoids CSS nesting and keeps a visible status region', () => {
  assert.match(popupCss, /\.export-btn\.copy \.default-copy-text\s*\{/);
  assert.match(popupCss, /\.export-btn\.copy\.copied \.default-copy-text\s*\{/);
  assert.doesNotMatch(
    popupCss,
    /\.export-btn\.copy\s*\{\s*\n\s*\.default-copy-text/,
  );
  assert.doesNotMatch(batchCss, /#singleStatus:empty/);
});

test('interactive controls have visible focus and minimum target sizes', () => {
  assert.match(batchCss, /\.tab:focus-visible\s*\{/);
  assert.match(batchCss, /\.tool-btn:focus-visible\s*\{/);
  assert.match(batchCss, /\.site-search:focus-within\s*\{/);
  assert.match(batchCss, /\.tab\s*\{[^}]*min-height: 24px/s);
  assert.match(batchCss, /\.tool-btn\s*\{[^}]*min-height: 24px/s);
  assert.match(batchCss, /\.site-item\s*\{[^}]*min-height: 24px/s);
});

test('single-site initialization surfaces errors instead of swallowing them', () => {
  assert.match(popupJs, /initializeSingleSite\(\)\.catch\(/);
  assert.match(popupJs, /Could not read cookies: \$\{error\.message\}/);
  assert.doesNotMatch(
    popupJs,
    /getAllCookies\(details\)\.catch\(\(\) => \[\]\)/,
  );
});
