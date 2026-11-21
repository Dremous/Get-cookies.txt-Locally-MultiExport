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
const darkCss = readFileSync(
  new URL('../src/popup.dark.css', import.meta.url),
  'utf8',
);
const donationCss = readFileSync(
  new URL('../src/donation.css', import.meta.url),
  'utf8',
);
const popupJs = readFileSync(
  new URL('../src/popup.mjs', import.meta.url),
  'utf8',
);
const popupOptionsCss = readFileSync(
  new URL('../src/popup-options.css', import.meta.url),
  'utf8',
);
const nowrapJs = readFileSync(
  new URL('../src/table-nowrap.js', import.meta.url),
  'utf8',
);

const relativeLuminance = (hex) => {
  const channels = hex
    .replace('#', '')
    .match(/.{2}/g)
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

const contrastRatio = (foreground, background) => {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (lighter + 0.05) / (darker + 0.05);
};

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
  for (const panelId of ['singlePanel', 'multiPanel']) {
    const openingTag = html.match(
      new RegExp(`<section\\s+id="${panelId}"[^>]*>`),
    )?.[0];
    assert.ok(openingTag);
    assert.doesNotMatch(openingTag, /tabindex=/);
  }
});

test('search, table, and icons have accessible names', () => {
  assert.match(html, /aria-label="Filter sites"/);
  assert.match(html, /id="cookiesTableCaption" class="visually-hidden"/);
  assert.match(
    html,
    /class="table-container"[\s\S]*?tabindex="0"[\s\S]*?role="region"[\s\S]*?aria-labelledby="cookiesTableCaption"/,
  );
  assert.equal((html.match(/<th scope="col">/g) || []).length, 7);
  assert.equal(
    (html.match(/class="material-symbols-outlined" aria-hidden="true"/g) || [])
      .length,
    9,
  );
});

test('single-site actions start disabled and the table container can take focus', () => {
  for (const id of ['export', 'exportAs', 'copy']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*disabled`));
  }
  const exportAllTag = html.match(/<button\s+id="exportAll"[\s\S]*?>/)?.[0];
  assert.ok(exportAllTag);
  assert.match(exportAllTag, /aria-disabled="true"/);
  assert.doesNotMatch(exportAllTag, /\sdisabled(?=\s|>)/);
  assert.match(popupCss, /\.table-container:focus-visible\s*\{/);
  assert.match(darkCss, /\.table-container:focus-visible\s*\{/);
  assert.match(popupJs, /const updateSingleActionState = \(\) =>/);
  assert.match(popupJs, /el\.copyButton\.disabled = blocked;/);
  assert.match(
    popupJs,
    /el\.exportAllButton\.setAttribute\(\s*'aria-disabled',\s*String\(Boolean\(exportAllReason\) \|\| exportGuard\.busy\),\s*\)/s,
  );
  assert.match(
    popupJs,
    /const blocked = !singleSiteReady \|\| exportGuard\.busy;/,
  );
});

test('single and batch actions share one re-entrancy guard', () => {
  assert.match(popupJs, /const beginExclusiveAction = \(\) =>/);
  assert.match(popupJs, /const endExclusiveAction = \(\) =>/);
  assert.equal(
    (popupJs.match(/if \(!beginExclusiveAction\(\)\) return;/g) || []).length,
    6,
  );
  for (const id of ['export', 'exportAs', 'copy', 'exportAll']) {
    const start = popupJs.indexOf(
      `document.querySelector('#${id}').addEventListener`,
    );
    const end = popupJs.indexOf('});', start);
    const block = popupJs.slice(start, end);
    assert.match(block, /if \(!beginExclusiveAction\(\)\) return;/);
    assert.match(block, /finally \{\s*endExclusiveAction\(\);/s);
  }
  const batchStart = popupJs.indexOf('el.batchCopy.addEventListener');
  const batchEnd = popupJs.indexOf('});', batchStart);
  assert.match(
    popupJs.slice(batchStart, batchEnd),
    /if \(!beginExclusiveAction\(\)\) return;/,
  );
  assert.equal(
    (popupJs.match(/finally \{\s*endExclusiveAction\(\);/g) || []).length,
    6,
  );
  assert.match(popupJs, /exportGuard\.busy \|\|\s*!hasSites/);
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
  assert.match(popupOptionsCss, /select\s*\{[^}]*min-block-size: 24px/s);
  assert.match(
    popupOptionsCss,
    /\.nowrap-option input\[type="checkbox"\]\s*\{[^}]*inline-size: 24px;[^}]*block-size: 24px;/s,
  );
  assert.match(
    batchCss,
    /\.export-btn\[aria-disabled="true"\]\s*\{[^}]*cursor: not-allowed;/s,
  );
});

test('single-site initialization surfaces errors instead of swallowing them', () => {
  assert.match(popupJs, /const handleSingleSiteError = \(error\) =>/);
  assert.match(popupJs, /\.catch\(handleSingleSiteError\)/);
  assert.match(popupJs, /Could not read cookies: \$\{error\.message\}/);
  assert.doesNotMatch(
    popupJs,
    /getAllCookies\(details\)\.catch\(\(\) => \[\]\)/,
  );
});

test('copy and dark error colors meet WCAG AA contrast', () => {
  assert.ok(contrastRatio('#2b6f9e', '#ffffff') >= 4.5);
  assert.ok(contrastRatio('#ff8a80', '#2a2a2a') >= 4.5);
  assert.ok(contrastRatio('#8a4b00', '#fdfbff') >= 4.5);
  assert.ok(contrastRatio('#ffb86b', '#2a2a2a') >= 4.5);
  assert.ok(contrastRatio('#8a8a8a', '#3a3a3a') >= 3);
  assert.ok(contrastRatio('#e09200', '#2a2a2a') >= 3);
  assert.ok(contrastRatio('#8a8a8a', '#1e1e1e') >= 3);
  assert.ok(contrastRatio('#8a8a8a', '#2a2a2a') >= 3);
  assert.match(popupCss, /background-color: #2b6f9e;/);
  assert.match(batchCss, /color: #ff8a80;/);
  assert.match(batchCss, /border-color: #8a8a8a;/);
  assert.match(batchCss, /\.site-list \{\s*border-color: #8a8a8a;/);
  assert.match(batchCss, /\.site-item \{\s*border-bottom-color: #8a8a8a;/);
  assert.match(darkCss, /border: solid 1px #8a8a8a;/);
  assert.match(
    darkCss,
    /\.netscape-table th,\s*\.netscape-table td \{\s*border: solid 1px #8a8a8a;/,
  );
  assert.match(donationCss, /outline-color: #e09200;/);
});

test('active-tab refresh shares one snapshot across panels', () => {
  const start = popupJs.indexOf('const refreshActiveTab =');
  const end = popupJs.indexOf('refreshActiveTab();', start);
  const block = popupJs.slice(start, end);
  assert.match(block, /const snapshot = await getActiveTabSnapshot\(\);/);
  assert.match(
    block,
    /const batchPermissionMissing = !\(await hasHostPermission\(\)\);/,
  );
  assert.match(block, /refreshSingleSite\(snapshot\)/);
  assert.match(block, /loadSites\(snapshot, batchPermissionMissing\)/);
});

test('active-tab refresh reacts to URL and permission changes', () => {
  assert.match(popupJs, /chrome\.tabs\.onActivated\.addListener/);
  assert.match(popupJs, /chrome\.tabs\.onUpdated\.addListener/);
  assert.match(popupJs, /changeInfo\.url/);
  assert.match(popupJs, /chrome\.permissions\?\.onAdded\?\.addListener/);
  assert.match(popupJs, /chrome\.permissions\?\.onRemoved\?\.addListener/);
});

test('host permission is checked for every browser', () => {
  assert.doesNotMatch(popupJs, /if \(!isFirefox\(\)\) return true;/);
  assert.match(popupJs, /return await chrome\.permissions\.contains/);
});

test('active-tab refresh failure enters an error state and disables actions', () => {
  const start = popupJs.indexOf('const handleRefreshError =');
  const end = popupJs.indexOf('let singleSiteRefresh', start);
  const block = popupJs.slice(start, end);
  assert.match(block, /singleSiteReady = false;/);
  assert.match(block, /sitesReady = false;/);
  assert.match(block, /currentSiteKey = '';/);
  assert.match(block, /selectedSites\.clear\(\);/);
  assert.match(block, /clearLocation\(\);/);
  assert.match(block, /updateSingleActionState\(\);/);
  assert.match(block, /setSingleStatus/);
  assert.match(block, /setBatchStatus/);

  const refreshStart = popupJs.indexOf('const refreshActiveTab =');
  const refreshEnd = popupJs.indexOf('refreshActiveTab();', refreshStart);
  assert.match(
    popupJs.slice(refreshStart, refreshEnd),
    /handleRefreshError\(error, batchPermissionMissing\)/,
  );
});

test('refresh success clears old status and gates batch actions', () => {
  assert.match(popupJs, /const hasSites = sitesReady && sites\.length > 0;/);
  assert.match(popupJs, /!hasSites/);
  assert.match(popupJs, /setSingleStatus\(''\)/);
  assert.match(popupJs, /setBatchStatus\(''\)/);
});

test('batch selection drops sites that disappeared after a refresh', () => {
  assert.match(popupJs, /for \(const site of \[\.\.\.selectedSites\]\)/);
  assert.match(popupJs, /selectedSites\.delete\(site\)/);
});

test('batch selection falls back to the current site when stored sites are gone', () => {
  const start = popupJs.indexOf('const loadSites =');
  const end = popupJs.indexOf('persistSelection();', start);
  const block = popupJs.slice(start, end);
  assert.match(block, /selectedSites\.clear\(\);/);
  assert.match(
    block,
    /stored\.length > 0 &&\s*selectedSites\.size === 0 &&\s*currentSiteKey &&\s*sites\.some\(\(entry\) => entry\.site === currentSiteKey\)/s,
  );
  assert.match(block, /selectedSites\.add\(currentSiteKey\)/);
});

test('starting a new site refresh clears stale rows and disables actions', () => {
  const start = popupJs.indexOf('const initializeSingleSite =');
  const end = popupJs.indexOf('const handleSingleSiteError', start);
  const block = popupJs.slice(start, end);
  assert.ok(
    block.indexOf('singleSiteReady = false') <
      block.indexOf('await getActiveTabSnapshot'),
  );
  assert.match(block, /#netscapeTable tbody'\)\.replaceChildren\(\)/);
  assert.match(block, /setSingleStatus\('Reading cookies…'\)/);
  assert.match(block, /setLocation\(url\)/);
});

test('current-site access does not require the all-sites host grant', () => {
  const initStart = popupJs.indexOf('const initializeSingleSite =');
  const initEnd = popupJs.indexOf('const handleSingleSiteError', initStart);
  const initBlock = popupJs.slice(initStart, initEnd);
  assert.doesNotMatch(initBlock, /batchHostPermissionMissing/);
  assert.doesNotMatch(initBlock, /hasHostPermission/);
  assert.match(initBlock, /getAllCookies\(details/);

  const loadStart = popupJs.indexOf('const loadSites =');
  const loadEnd = popupJs.indexOf('const initializeSingleSite', loadStart);
  assert.doesNotMatch(popupJs.slice(loadStart, loadEnd), /clearLocation\(\)/);
  assert.match(popupJs, /singleSiteHostPermissionMessage/);
});

test('batch read failures do not clear the successfully read current site', () => {
  const loadStart = popupJs.indexOf('const loadSites =');
  const loadEnd = popupJs.indexOf('const initializeSingleSite', loadStart);
  const block = popupJs.slice(loadStart, loadEnd);
  assert.match(block, /try \{[\s\S]*?getAllCookiesForBatch/);
  assert.match(block, /catch \(error\) \{/);
  assert.match(block, /sitesLoading = false;/);
  assert.match(
    block,
    /sitesLoadError = `Could not read cookies: \$\{error\.message\}`/,
  );
  assert.doesNotMatch(block, /singleSiteReady = false/);
  assert.doesNotMatch(block, /currentSiteSnapshot = null/);
  assert.doesNotMatch(block, /clearLocation\(\)/);
  assert.doesNotMatch(block, /handleRefreshError/);
});

test('table header stays visible while scrolling', () => {
  assert.match(popupCss, /\.table-container \{\s*[^}]*overflow: auto;/s);
  assert.match(
    popupCss,
    /\.netscape-table \{\s*border-collapse: separate;\s*border-spacing: 0;/s,
  );
  assert.match(popupCss, /\.netscape-table thead \{\s*position: sticky;/s);
});

test('Firefox host-permission guidance and partition warnings are visible', () => {
  assert.match(popupJs, /hasHostPermission/);
  assert.match(popupJs, /chrome\.permissions\.contains/);
  assert.match(popupJs, /isHostPermissionError/);
  assert.match(popupJs, /singleSiteHostPermissionMessage/);
  assert.match(popupJs, /about:addons/);
  assert.match(popupJs, /onPartitionError/);
  assert.match(popupJs, /Some partitioned cookies could not be read/);
  assert.match(batchCss, /\[data-kind="warning"\]/);
  assert.match(
    popupJs,
    /catch \(error\) \{\s*console\.warn\('\[permissions\] host permission check failed', error\);\s*return false;/,
  );
});

test('table-nowrap uses the checkbox state as the explicit class target', () => {
  assert.match(nowrapJs, /classList\.toggle\('nowrap', e\.target\.checked\)/);
});

test('Export All stays focusable and exposes a non-live disabled reason', () => {
  const exportAllTag = html.match(/<button\s+id="exportAll"[\s\S]*?>/)?.[0];
  assert.ok(exportAllTag);
  assert.match(exportAllTag, /aria-describedby="exportAllHint"/);
  assert.match(exportAllTag, /aria-disabled="true"/);
  assert.doesNotMatch(exportAllTag, /\sdisabled(?=\s|>)/);
  const hintTag = html.match(/<p\s+id="exportAllHint"[\s\S]*?>/)?.[0];
  assert.ok(hintTag);
  assert.doesNotMatch(hintTag, /role="status"/);
  assert.doesNotMatch(hintTag, /aria-live=/);
  assert.doesNotMatch(hintTag, /aria-atomic=/);
  assert.match(
    html,
    /<p id="singleStatus" class="batch-status" role="status"><\/p>/,
  );
  assert.match(popupJs, /const exportAllBlockedReason = \(\) =>/);
  assert.match(popupJs, /if \(sitesLoading\) return 'Reading cookies…';/);
  assert.match(
    popupJs,
    /Header String is single-site only\. Choose Netscape or JSON for Export All Cookies\./,
  );
  assert.match(popupJs, /el\.exportAllHint\.textContent = exportAllReason;/);
  assert.match(
    popupJs,
    /document\.querySelector\('#exportAll'\)\.addEventListener\('click', async \(\) => \{\s*const blockedReason = exportAllBlockedReason\(\);\s*if \(blockedReason\) \{\s*setSingleStatus\(blockedReason, 'warning'\);\s*return;/s,
  );
  assert.match(
    popupJs,
    /el\.format\.addEventListener\('change',[\s\S]*?updateSingleActionState\(\)/,
  );
  assert.match(batchCss, /\.export-hint\s*\{[^}]*color: #8a4b00;/s);
  assert.match(batchCss, /\.export-hint\[hidden\]\s*\{[^}]*display: none;/s);
});

test('the active-site link opens in a new tab without opener access', () => {
  assert.match(
    html,
    /<a id="location" target="_blank" rel="noopener noreferrer"><\/a>/,
  );
});

test('current-site actions use the snapshot that produced the table', () => {
  const start = popupJs.indexOf('const getCurrentSiteDetails =');
  const end = popupJs.indexOf("document.querySelector('#export')", start);
  const block = popupJs.slice(start, end);
  assert.match(block, /const snapshot = currentSiteSnapshot;/);
  assert.doesNotMatch(block, /getActiveTabSnapshot/);

  const refreshStart = popupJs.indexOf('const refreshActiveTab =');
  const refreshEnd = popupJs.indexOf('refreshActiveTab();', refreshStart);
  const refreshBlock = popupJs.slice(refreshStart, refreshEnd);
  assert.ok(
    refreshBlock.indexOf('singleSiteReady = false') <
      refreshBlock.indexOf('await getActiveTabSnapshot'),
  );
  assert.match(refreshBlock, /currentSiteSnapshot = null/);
  assert.match(refreshBlock, /lastActiveSnapshot = snapshot/);

  const allStart = popupJs.indexOf(
    "document.querySelector('#exportAll').addEventListener",
  );
  const allEnd = popupJs.indexOf('});', allStart);
  const allBlock = popupJs.slice(allStart, allEnd);
  assert.doesNotMatch(
    allBlock,
    /const snapshot = await getActiveTabSnapshot\(\)/,
  );
  assert.match(allBlock, /lastActiveSnapshot/);
});
