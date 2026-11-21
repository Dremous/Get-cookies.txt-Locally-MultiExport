import { bytesToBase64 } from './modules/base64.mjs';
import {
  buildBatchExport,
  serializeCombined,
  siteCookieBaseName,
} from './modules/batch_export.mjs';
import { writeClipboard } from './modules/clipboard.mjs';
import { formatMap, jsonToNetscapeMapper } from './modules/cookie_format.mjs';
import { createCopyFeedback } from './modules/copy_feedback.mjs';
import { createExportGuard } from './modules/export_guard.mjs';
import getAllCookies, {
  getAllCookiesForBatch,
  getCookieStoreId,
  getTabPartitionKey,
} from './modules/get_all_cookies.mjs';
import _saveToFile from './modules/save_to_file.mjs';
import {
  getSiteKey,
  groupCookiesBySite,
  toSiteList,
} from './modules/site_group.mjs';

/**
 * Read the active tab, its URL, partition key and cookie store from one tab
 * snapshot. Keeping these values together prevents an export from mixing a
 * stale URL with state taken from a different tab.
 * @returns {Promise<{
 *   tab: chrome.tabs.Tab | null,
 *   url: URL | null,
 *   partitionKey: chrome.cookies.CookiePartitionKey | null,
 *   storeId: string | undefined,
 * }>}
 */
const getActiveTabSnapshot = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    return { tab: null, url: null, partitionKey: null, storeId: undefined };
  }

  let url = null;
  try {
    url = tab.url ? new URL(tab.url) : null;
  } catch {
    url = null;
  }

  const [partitionKey, storeId] = await Promise.all([
    getTabPartitionKey(tab),
    getCookieStoreId(tab),
  ]);

  return { tab, url, partitionKey, storeId };
};

const STORAGE_FORMAT = 'selectedFormat';
const STORAGE_BATCH_FORMAT = 'batchFormat';
const STORAGE_BATCH_MODE = 'batchModeV2';
const STORAGE_BATCH_SELECTION = 'batchSelection';

const isFirefox = () =>
  chrome.runtime.getManifest().browser_specific_settings !== undefined;

/**
 * Batch export needs access to every origin in the cookie store, so it still
 * requires the full `<all_urls>` grant. The current-site path deliberately
 * does not use this check: it attempts the read directly, which also covers
 * `activeTab` temporary access and site-specific host grants.
 * @returns {Promise<boolean>}
 */
const hasHostPermission = async () => {
  try {
    if (typeof chrome.permissions?.contains !== 'function') return false;
    return await chrome.permissions.contains({ origins: ['<all_urls>'] });
  } catch (error) {
    console.warn('[permissions] host permission check failed', error);
    return false;
  }
};

const batchHostPermissionMessage = () =>
  isFirefox()
    ? 'Firefox host permission is required. Open about:addons, open Permissions, and enable "Access your data for all websites", then reopen this popup.'
    : 'Host permission is required. Open the extension settings and allow access to all websites, then reopen this popup.';

const singleSiteHostPermissionMessage = () =>
  isFirefox()
    ? 'Firefox host permission is required for this site. Open about:addons, open Permissions, and allow this site or all websites, then reopen this popup.'
    : 'Host permission is required for this site. Open the extension settings and allow this site or all websites, then reopen this popup.';

/** @param {unknown} error */
const isHostPermissionError = (error) =>
  /host permission|permission denied|missing permission/i.test(
    String(error instanceof Error ? error.message : error),
  );

/** @param {string} formatKey */
const getFormat = (formatKey) =>
  Object.hasOwn(formatMap, formatKey) ? formatMap[formatKey] : undefined;

// ----------------------------------------------
// State
// ----------------------------------------------

/** @type {Array<{ site: string, cookies: chrome.cookies.Cookie[], cookieCount: number, domainCount: number }>} */
let sites = [];
/** @type {Set<string>} */
const selectedSites = new Set();
/** @type {string} */
let currentSiteKey = '';
/** @type {boolean} */
let batchHostPermissionMissing = false;
/** @type {boolean} */
let singleSiteReady = false;
/** @type {Awaited<ReturnType<typeof getActiveTabSnapshot>> | null} */
let lastActiveSnapshot = null;
/** @type {Awaited<ReturnType<typeof getActiveTabSnapshot>> | null} */
let currentSiteSnapshot = null;
/** @type {boolean} */
let sitesReady = false;
/** @type {boolean} */
let sitesLoading = true;
/** @type {string | null} */
let sitesLoadError = null;
/** @type {number} */
let activeTabRefreshGeneration = 0;
const exportGuard = createExportGuard();
const copyFeedback = createCopyFeedback();

// ----------------------------------------------
// DOM
// ----------------------------------------------

const el = {
  location: document.querySelector('#location'),
  format: document.querySelector('#format'),
  batchFormat: document.querySelector('#batchFormat'),
  batchMode: document.querySelector('#batchMode'),
  siteSearch: document.querySelector('#siteSearch'),
  siteList: document.querySelector('#siteList'),
  selectionText: document.querySelector('#selectionText'),
  cookieCountText: document.querySelector('#cookieCountText'),
  siteCountBadge: document.querySelector('#siteCountBadge'),
  batchExport: document.querySelector('#batchExport'),
  batchExportLabel: document.querySelector('#batchExportLabel'),
  batchCopy: document.querySelector('#batchCopy'),
  batchStatus: document.querySelector('#batchStatus'),
  singleStatus: document.querySelector('#singleStatus'),
  tabSingle: document.querySelector('#tabSingle'),
  tabMulti: document.querySelector('#tabMulti'),
  panelSingle: document.querySelector('#singlePanel'),
  panelMulti: document.querySelector('#multiPanel'),
  copyButton: document.querySelector('#copy'),
  exportButton: document.querySelector('#export'),
  exportAsButton: document.querySelector('#exportAs'),
  exportAllButton: document.querySelector('#exportAll'),
  exportAllHint: document.querySelector('#exportAllHint'),
};

// ----------------------------------------------
// Functions
// ----------------------------------------------

/**
 * Get Stringified Cookies Text and Format Data
 * @param {chrome.cookies.GetAllDetails} details
 * @param {string} formatKey
 * @param {chrome.tabs.Tab | null} [activeTab]
 * @returns {Promise<{ text: string, format: Format, warnings: unknown[] }>}
 */
const getCookieText = async (details, formatKey, activeTab) => {
  const warnings = [];
  const cookies = await getAllCookies(details, {
    onPartitionError: (error) => warnings.push(error),
    activeTab,
  });
  const format = getFormat(formatKey);
  if (!format) throw new Error('Invalid format');
  const text = format.serializer(cookies);
  return { text, format, warnings };
};

/**
 * The warning shown after an export/copy when a partitioned query failed.
 * @param {unknown[]} warnings
 */
const partitionWarningText = (warnings) =>
  warnings.length ? ' Some partitioned cookies could not be read.' : '';

/**
 * Save text or binary data as a file
 * Firefox cannot use saveAs in a popup, so the background script handles it.
 * @param {string | Uint8Array} data
 * @param {string} name
 * @param {{ ext: string, mimeType: string }} format
 * @param {boolean} saveAs
 */
const saveToFile = async (data, name, format, saveAs = false) => {
  if (isFirefox()) {
    const payload = {
      name,
      format: { ext: format.ext, mimeType: format.mimeType },
      saveAs,
    };
    if (data instanceof Uint8Array) payload.base64 = bytesToBase64(data);
    else payload.text = data;
    const response = await chrome.runtime.sendMessage({
      type: 'save',
      target: 'background',
      data: payload,
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'Background save failed');
    }
  } else {
    await _saveToFile(data, name, format, saveAs);
  }
};

/**
 * Split "name.ext" into a base name and an extension.
 * @param {string} fileName
 * @returns {{ base: string, ext: string }}
 */
const splitFileName = (fileName) => {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return { base: fileName, ext: '' };
  return { base: fileName.slice(0, dot), ext: fileName.slice(dot) };
};

/**
 * Copy text data to the clipboard.
 * @param {string} text
 * @param {HTMLElement} [button]
 */
const setClipboard = async (text, button = document.querySelector('#copy')) => {
  await writeClipboard(text);
  copyFeedback.show(button);
};

/** @param {string} message @param {'info' | 'error' | 'warning'} [kind] */
const setBatchStatus = (message, kind = 'info') => {
  el.batchStatus.textContent = message;
  el.batchStatus.dataset.kind = kind;
};

/** @param {string} message @param {'info' | 'error' | 'warning'} [kind] */
const setSingleStatus = (message, kind = 'info') => {
  el.singleStatus.textContent = message;
  el.singleStatus.dataset.kind = kind;
};

/**
 * Clear the active-page link when the popup no longer has a trustworthy URL
 * (for example after losing host permission or after a refresh error).
 */
const clearLocation = () => {
  el.location.textContent = '';
  el.location.removeAttribute('href');
};

/** @param {URL | null} url */
const setLocation = (url) => {
  el.location.textContent = url?.href ?? 'this page';
  if (url) el.location.href = url.href;
  else el.location.removeAttribute('href');
};

/**
 * Explain why Export All Cookies is unavailable. Batch permission failures
 * used to be reported only in the multi-site panel, so the single-site panel
 * showed a disabled button with no visible reason.
 * @returns {string}
 */
const exportAllBlockedReason = () => {
  if (batchHostPermissionMissing) return batchHostPermissionMessage();
  if (sitesLoading) return 'Reading cookies…';
  if (sitesLoadError) return sitesLoadError;
  if (!sitesReady) return 'Cookie list is unavailable.';
  if (sites.length === 0) return 'No cookies found in this cookie store.';
  if (el.format.value === 'header' && sites.length > 1) {
    return 'Header String is single-site only. Choose Netscape or JSON for Export All Cookies.';
  }
  return '';
};

/**
 * Disable actions that cannot run without a resolved active site. The current
 * site buttons depend only on a successful current-site read; export all still
 * needs the full `<all_urls>` grant because it enumerates the whole store.
 */
const updateSingleActionState = () => {
  const blocked = !singleSiteReady || exportGuard.busy;
  el.copyButton.disabled = blocked;
  el.exportButton.disabled = blocked;
  el.exportAsButton.disabled = blocked;
  const exportAllReason = exportAllBlockedReason();
  el.exportAllButton.setAttribute(
    'aria-disabled',
    String(Boolean(exportAllReason) || exportGuard.busy),
  );
  el.exportAllHint.textContent = exportAllReason;
  el.exportAllHint.hidden = exportAllReason === '';
};

const persistSelection = () => {
  localStorage.setItem(
    STORAGE_BATCH_SELECTION,
    JSON.stringify([...selectedSites]),
  );
};

const selectedCookieCount = () =>
  sites
    .filter((entry) => selectedSites.has(entry.site))
    .reduce((sum, entry) => sum + entry.cookieCount, 0);

const updateSummary = () => {
  const visibleSites = sites.filter((entry) => {
    const query = el.siteSearch.value.trim().toLowerCase();
    return !query || entry.site.toLowerCase().includes(query);
  });
  const selectedVisible = visibleSites.filter((entry) =>
    selectedSites.has(entry.site),
  ).length;
  const hasSites = sitesReady && sites.length > 0;
  el.selectionText.textContent = hasSites
    ? `${selectedSites.size} of ${sites.length} sites selected${
        visibleSites.length !== sites.length
          ? ` (${selectedVisible} of ${visibleSites.length} shown)`
          : ''
      }`
    : '0 of 0 sites selected';
  el.cookieCountText.textContent = sitesReady
    ? `${selectedCookieCount()} cookies`
    : '0 cookies';
  el.siteCountBadge.textContent = `(${sites.length})`;
  el.batchExport.disabled =
    exportGuard.busy ||
    !hasSites ||
    selectedSites.size === 0 ||
    batchHostPermissionMissing;
  el.batchCopy.disabled =
    exportGuard.busy ||
    !hasSites ||
    selectedSites.size === 0 ||
    batchHostPermissionMissing;
};

/**
 * Start an action that must not overlap another download or clipboard write.
 * The guard is shared with the batch actions, so a single-site export cannot
 * race a batch export (or a rapid double-click of the same button).
 */
const beginExclusiveAction = () => {
  if (!exportGuard.begin()) return false;
  updateSingleActionState();
  updateSummary();
  return true;
};

const endExclusiveAction = () => {
  exportGuard.end();
  updateSingleActionState();
  updateSummary();
};

const renderSiteList = () => {
  const query = el.siteSearch.value.trim().toLowerCase();
  const visible = sites.filter(
    (entry) => !query || entry.site.toLowerCase().includes(query),
  );

  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'site-empty';
    if (query) {
      empty.textContent = 'No site matches this filter.';
    } else if (batchHostPermissionMissing) {
      empty.textContent = batchHostPermissionMessage();
    } else if (sitesLoading) {
      empty.textContent = 'Reading cookies…';
    } else if (sitesLoadError) {
      empty.textContent = sitesLoadError;
    } else {
      empty.textContent = 'No cookies found in this cookie store.';
    }
    el.siteList.replaceChildren(empty);
    updateSummary();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const entry of visible) {
    const label = document.createElement('label');
    label.className = 'site-item';
    label.title = `${entry.cookieCount} cookies from ${entry.domainCount} domain(s)`;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'site-checkbox';
    checkbox.checked = selectedSites.has(entry.site);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedSites.add(entry.site);
      else selectedSites.delete(entry.site);
      persistSelection();
      updateSummary();
    });

    const name = document.createElement('span');
    name.className = 'site-name';
    name.textContent = entry.site;

    const meta = document.createElement('span');
    meta.className = 'site-meta';
    meta.textContent = `${entry.cookieCount}`;

    label.append(checkbox, name);
    if (entry.site === currentSiteKey) {
      const badge = document.createElement('span');
      badge.className = 'site-current';
      badge.textContent = '(current)';
      label.append(badge);
    }
    label.append(meta);
    fragment.append(label);
  }
  el.siteList.replaceChildren(fragment);
  updateSummary();
};

/**
 * Load all cookies of this store and build the site list. Batch export needs
 * the full `<all_urls>` grant; a missing grant must not clear the current-site
 * panel, which may still be readable through `activeTab` or a site-specific
 * host grant.
 * @param {Awaited<ReturnType<typeof getActiveTabSnapshot>>} [snapshot]
 * @param {boolean} [permissionMissing]
 * @param {number} [generation]
 */
const loadSites = async (
  snapshot,
  permissionMissing,
  generation = activeTabRefreshGeneration,
) => {
  if (generation !== activeTabRefreshGeneration) return;
  const permissionMissingNow =
    permissionMissing ?? !(await hasHostPermission());
  if (generation !== activeTabRefreshGeneration) return;
  batchHostPermissionMissing = permissionMissingNow;
  sitesReady = false;
  sitesLoading = true;
  sites = [];
  sitesLoadError = null;
  selectedSites.clear();
  updateSingleActionState();
  updateSummary();
  if (batchHostPermissionMissing) {
    sitesLoading = false;
    currentSiteKey = '';
    renderSiteList();
    setBatchStatus(batchHostPermissionMessage(), 'warning');
    return;
  }

  renderSiteList();
  setBatchStatus('Reading cookies…');

  const activeSnapshot =
    snapshot === undefined ? await getActiveTabSnapshot() : snapshot;
  if (generation !== activeTabRefreshGeneration) return;
  currentSiteKey = activeSnapshot.url
    ? getSiteKey(activeSnapshot.url.hostname)
    : '';

  const warnings = [];
  try {
    const cookies = await getAllCookiesForBatch(activeSnapshot.tab, {
      storeId: activeSnapshot.storeId,
      onPartitionError: (error) => warnings.push(error),
    });
    if (generation !== activeTabRefreshGeneration) return;
    sites = toSiteList(groupCookiesBySite(cookies));
  } catch (error) {
    if (generation !== activeTabRefreshGeneration) return;
    // The current-site read may have succeeded even when the whole-store
    // batch read fails. Keep its snapshot, location, table and buttons intact;
    // only the batch list and batch actions depend on this query.
    sitesReady = false;
    sitesLoading = false;
    sites = [];
    selectedSites.clear();
    sitesLoadError = `Could not read cookies: ${error.message}`;
    const permissionError = isHostPermissionError(error);
    if (permissionError) batchHostPermissionMissing = true;
    updateSingleActionState();
    renderSiteList();
    setBatchStatus(
      permissionError ? batchHostPermissionMessage() : sitesLoadError,
      permissionError ? 'warning' : 'error',
    );
    return;
  }
  sitesLoading = false;
  sitesReady = true;
  sitesLoadError = null;
  // Alphabetical order, with the active site pinned to the top.
  sites.sort((a, b) => a.site.localeCompare(b.site));
  const currentIndex = sites.findIndex(
    (entry) => entry.site === currentSiteKey,
  );
  if (currentIndex > 0) {
    const [current] = sites.splice(currentIndex, 1);
    sites.unshift(current);
  }

  let stored = null;
  try {
    stored = JSON.parse(
      localStorage.getItem(STORAGE_BATCH_SELECTION) ?? 'null',
    );
  } catch {
    stored = null;
  }
  if (Array.isArray(stored)) {
    for (const site of stored) {
      if (sites.some((entry) => entry.site === site)) selectedSites.add(site);
    }
    // The previous tab's selection may only contain sites that no longer
    // exist here. If there is a usable stored list but nothing survived,
    // fall back to the current site instead of leaving batch export disabled.
    if (
      stored.length > 0 &&
      selectedSites.size === 0 &&
      currentSiteKey &&
      sites.some((entry) => entry.site === currentSiteKey)
    ) {
      selectedSites.add(currentSiteKey);
    }
  } else if (
    currentSiteKey &&
    sites.some((entry) => entry.site === currentSiteKey)
  ) {
    selectedSites.add(currentSiteKey);
  }
  // A selection from the previous tab may no longer exist in this tab's
  // cookie store; keeping it would make the batch count and export guard
  // disagree with the visible list.
  for (const site of [...selectedSites]) {
    if (!sites.some((entry) => entry.site === site)) selectedSites.delete(site);
  }
  persistSelection();
  updateSingleActionState();

  renderSiteList();
  setBatchStatus('');
  if (warnings.length) {
    setBatchStatus(
      'Some partitioned cookies could not be read; the site list may be incomplete.',
      'warning',
    );
  }
};

// ----------------------------------------------
// Actions after resolving the promise
// ----------------------------------------------

/**
 * Populate the header and single-site cookie table from one tab snapshot.
 * Do not gate on the full `<all_urls>` grant: `activeTab` and site-specific
 * host grants can legitimately expose only the current tab. The cookie query
 * itself is the source of truth for whether the current site is readable.
 * @param {Awaited<ReturnType<typeof getActiveTabSnapshot>>} [snapshot]
 * @param {number} [generation]
 */
const initializeSingleSite = async (
  snapshot,
  generation = activeTabRefreshGeneration,
) => {
  if (generation !== activeTabRefreshGeneration) return;
  currentSiteSnapshot = null;
  singleSiteReady = false;
  updateSingleActionState();
  document.querySelector('#netscapeTable tbody').replaceChildren();
  setSingleStatus('Reading cookies…');

  const activeSnapshot =
    snapshot === undefined ? await getActiveTabSnapshot() : snapshot;
  if (generation !== activeTabRefreshGeneration) return;
  const { url, partitionKey, storeId } = activeSnapshot;
  setLocation(url);
  if (!url) {
    currentSiteKey = '';
    updateSingleActionState();
    setSingleStatus(
      activeSnapshot.tab
        ? singleSiteHostPermissionMessage()
        : 'No active page URL.',
      activeSnapshot.tab ? 'warning' : 'error',
    );
    return;
  }

  const warnings = [];
  const details = { url: url.href, storeId };
  if (partitionKey) details.partitionKey = partitionKey;
  const cookies = await getAllCookies(details, {
    onPartitionError: (error) => warnings.push(error),
    activeTab: activeSnapshot.tab,
  });
  if (generation !== activeTabRefreshGeneration) return;
  const netscape = jsonToNetscapeMapper(cookies);
  const tableRows = netscape.map((row) => {
    const tr = document.createElement('tr');
    tr.replaceChildren(
      ...row.map((v) => {
        const td = document.createElement('td');
        td.textContent = v;
        return td;
      }),
    );
    return tr;
  });
  document.querySelector('#netscapeTable tbody').replaceChildren(...tableRows);
  currentSiteSnapshot = activeSnapshot;
  singleSiteReady = true;
  updateSingleActionState();
  setSingleStatus('');
  if (warnings.length) {
    setSingleStatus(
      'Some partitioned cookies could not be read; the table may be incomplete.',
      'warning',
    );
  }
};

const handleSingleSiteError = (
  error,
  generation = activeTabRefreshGeneration,
) => {
  if (generation !== activeTabRefreshGeneration) return;
  currentSiteSnapshot = null;
  singleSiteReady = false;
  updateSingleActionState();
  document.querySelector('#netscapeTable tbody').replaceChildren();
  const permissionError = isHostPermissionError(error);
  setSingleStatus(
    permissionError
      ? singleSiteHostPermissionMessage()
      : `Could not read cookies: ${error.message}`,
    permissionError ? 'warning' : 'error',
  );
};

/**
 * @param {unknown} error
 * @param {boolean} [permissionMissing]
 */
const handleRefreshError = (
  error,
  permissionMissing = false,
  generation = activeTabRefreshGeneration,
) => {
  if (generation !== activeTabRefreshGeneration) return;
  currentSiteSnapshot = null;
  lastActiveSnapshot = null;
  singleSiteReady = false;
  sitesReady = false;
  sitesLoading = false;
  sites = [];
  sitesLoadError = `Could not read cookies: ${error.message}`;
  currentSiteKey = '';
  selectedSites.clear();
  batchHostPermissionMissing = permissionMissing;
  clearLocation();
  updateSingleActionState();
  document.querySelector('#netscapeTable tbody').replaceChildren();
  renderSiteList();
  const message = permissionMissing
    ? batchHostPermissionMessage()
    : `Could not read cookies: ${error.message}`;
  setSingleStatus(message, permissionMissing ? 'warning' : 'error');
  setBatchStatus(message, permissionMissing ? 'warning' : 'error');
};

let singleSiteRefresh = Promise.resolve();

const refreshSingleSite = (
  snapshot,
  generation = activeTabRefreshGeneration,
) => {
  // Serialize refreshes and verify the generation after every await, so a
  // slower earlier snapshot cannot overwrite the result of a newer active tab.
  if (generation !== activeTabRefreshGeneration) return Promise.resolve();
  singleSiteRefresh = singleSiteRefresh
    .then(() => initializeSingleSite(snapshot, generation))
    .catch((error) => handleSingleSiteError(error, generation));
  return singleSiteRefresh;
};

let activeTabRefresh = Promise.resolve();

const refreshActiveTab = () => {
  const generation = ++activeTabRefreshGeneration;
  // Invalidate current-site actions before awaiting anything. A click that
  // arrives while the new tab snapshot is still loading must not mix the old
  // table with cookies from the new tab.
  currentSiteSnapshot = null;
  singleSiteReady = false;
  sitesReady = false;
  sitesLoading = true;
  sitesLoadError = null;
  updateSingleActionState();
  updateSummary();
  // Serialize whole-popup refreshes and share one snapshot between the
  // current-site table and the batch site list.
  activeTabRefresh = activeTabRefresh
    .then(async () => {
      if (generation !== activeTabRefreshGeneration) return;
      const snapshot = await getActiveTabSnapshot();
      if (generation !== activeTabRefreshGeneration) return;
      lastActiveSnapshot = snapshot;
      const batchPermissionMissing = !(await hasHostPermission());
      if (generation !== activeTabRefreshGeneration) return;
      await refreshSingleSite(snapshot, generation);
      if (generation !== activeTabRefreshGeneration) return;
      await loadSites(snapshot, batchPermissionMissing, generation);
    })
    .catch(async (error) => {
      if (generation !== activeTabRefreshGeneration) return;
      // The failure may have happened before the permission check above, so
      // re-check here to keep the error message and action states accurate.
      const batchPermissionMissing = !(await hasHostPermission());
      if (generation !== activeTabRefreshGeneration) return;
      handleRefreshError(error, batchPermissionMissing, generation);
    });
};

refreshActiveTab();

// The tab snapshot can become stale if the user switches tabs or navigates
// while the popup is still open (notably in browser automation and
// keyboard-driven use).
chrome.tabs.onActivated.addListener(refreshActiveTab);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab && !tab.active) return;
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  refreshActiveTab();
});
chrome.permissions?.onAdded?.addListener(refreshActiveTab);
chrome.permissions?.onRemoved?.addListener(refreshActiveTab);

// ----------------------------------------------
// Tabs
// ----------------------------------------------

const activatePanel = (panelId, focus = true) => {
  const isSingle = panelId === 'singlePanel';
  el.tabSingle.classList.toggle('active', isSingle);
  el.tabMulti.classList.toggle('active', !isSingle);
  el.tabSingle.setAttribute('aria-selected', String(isSingle));
  el.tabMulti.setAttribute('aria-selected', String(!isSingle));
  el.tabSingle.tabIndex = isSingle ? 0 : -1;
  el.tabMulti.tabIndex = isSingle ? -1 : 0;
  el.panelSingle.hidden = !isSingle;
  el.panelMulti.hidden = isSingle;
  if (focus) {
    if (isSingle) el.tabSingle.focus();
    else el.tabMulti.focus();
  }
};

const handleTabKeydown = (event) => {
  const isSingle = el.tabSingle.getAttribute('aria-selected') === 'true';
  let nextPanel = null;

  if (event.key === 'ArrowLeft' || event.key === 'Home') {
    nextPanel = 'singlePanel';
  } else if (event.key === 'ArrowRight' || event.key === 'End') {
    nextPanel = 'multiPanel';
  }

  if (!nextPanel) return;
  if (nextPanel === 'singlePanel' && isSingle) return;
  if (nextPanel === 'multiPanel' && !isSingle) return;

  event.preventDefault();
  activatePanel(nextPanel);
};

el.tabSingle.addEventListener('click', () => activatePanel('singlePanel'));
el.tabMulti.addEventListener('click', () => activatePanel('multiPanel'));
el.tabSingle.addEventListener('keydown', handleTabKeydown);
el.tabMulti.addEventListener('keydown', handleTabKeydown);

// ----------------------------------------------
// Event Listeners — single site
// ----------------------------------------------

const getCurrentSiteDetails = async () => {
  // Bind actions to the exact snapshot that produced the visible table. Re-
  // reading the active tab here could mix an older table with a newer tab.
  const snapshot = currentSiteSnapshot;
  const { url, partitionKey, storeId, tab } = snapshot ?? {};
  if (!snapshot || !url) throw new Error('No active page URL');
  const details = { url: url.href, storeId };
  if (partitionKey) details.partitionKey = partitionKey;
  return { url, details, tab };
};

document.querySelector('#export').addEventListener('click', async () => {
  if (!beginExclusiveAction()) return;
  try {
    const { url, details, tab } = await getCurrentSiteDetails();
    const { text, format, warnings } = await getCookieText(
      details,
      el.format.value,
      tab,
    );
    const base = siteCookieBaseName(url.hostname);
    await saveToFile(text, base, format);
    setSingleStatus(
      `Started export of ${base}${format.ext}${partitionWarningText(warnings)}`,
      warnings.length ? 'warning' : 'info',
    );
  } catch (error) {
    setSingleStatus(`Export failed: ${error.message}`, 'error');
  } finally {
    endExclusiveAction();
  }
});

document.querySelector('#exportAs').addEventListener('click', async () => {
  if (!beginExclusiveAction()) return;
  try {
    const { url, details, tab } = await getCurrentSiteDetails();
    const { text, format, warnings } = await getCookieText(
      details,
      el.format.value,
      tab,
    );
    const base = siteCookieBaseName(url.hostname);
    await saveToFile(text, base, format, true);
    setSingleStatus(
      `Started export for ${base}${format.ext}${partitionWarningText(warnings)}`,
      warnings.length ? 'warning' : 'info',
    );
  } catch (error) {
    setSingleStatus(`Export failed: ${error.message}`, 'error');
  } finally {
    endExclusiveAction();
  }
});

document.querySelector('#copy').addEventListener('click', async () => {
  if (!beginExclusiveAction()) return;
  try {
    const { details, tab } = await getCurrentSiteDetails();
    const { text, warnings } = await getCookieText(
      details,
      el.format.value,
      tab,
    );
    await setClipboard(text, document.querySelector('#copy'));
    setSingleStatus(
      `Copied current site cookies.${partitionWarningText(warnings)}`,
      warnings.length ? 'warning' : 'info',
    );
  } catch (error) {
    setSingleStatus(`Copy failed: ${error.message}`, 'error');
  } finally {
    endExclusiveAction();
  }
});

document.querySelector('#exportAll').addEventListener('click', async () => {
  const blockedReason = exportAllBlockedReason();
  if (blockedReason) {
    setSingleStatus(blockedReason, 'warning');
    return;
  }
  if (!beginExclusiveAction()) return;
  try {
    // exportAllBlockedReason() already rejects Header String when the store
    // contains more than one site. A single site is a valid Header export, so
    // do not reject it again here.
    const snapshot = lastActiveSnapshot ?? (await getActiveTabSnapshot());
    lastActiveSnapshot = snapshot;
    const details = { storeId: snapshot.storeId };
    if (snapshot.partitionKey) details.partitionKey = snapshot.partitionKey;
    const { text, format, warnings } = await getCookieText(
      details,
      el.format.value,
      snapshot.tab,
    );
    await saveToFile(text, 'cookies', format);
    setSingleStatus(
      `Started export of cookies${format.ext}${partitionWarningText(warnings)}`,
      warnings.length ? 'warning' : 'info',
    );
  } catch (error) {
    setSingleStatus(`Export failed: ${error.message}`, 'error');
  } finally {
    endExclusiveAction();
  }
});

/** Set last used format value */
const selectedFormat = localStorage.getItem(STORAGE_FORMAT);
if (selectedFormat && getFormat(selectedFormat)) {
  el.format.value = selectedFormat;
}
el.format.addEventListener('change', () => {
  localStorage.setItem(STORAGE_FORMAT, el.format.value);
  const batchValue =
    el.format.value === 'header' ? 'netscape' : el.format.value;
  el.batchFormat.value = batchValue;
  localStorage.setItem(STORAGE_BATCH_FORMAT, batchValue);
  updateSingleActionState();
});

// ----------------------------------------------
// Event Listeners — multi site
// ----------------------------------------------

const savedBatchFormat = localStorage.getItem(STORAGE_BATCH_FORMAT);
if (
  savedBatchFormat &&
  savedBatchFormat !== 'header' &&
  getFormat(savedBatchFormat)
) {
  el.batchFormat.value = savedBatchFormat;
} else {
  el.batchFormat.value =
    el.format.value === 'header' ? 'netscape' : el.format.value;
}
el.batchFormat.addEventListener('change', () => {
  localStorage.setItem(STORAGE_BATCH_FORMAT, el.batchFormat.value);
  el.format.value = el.batchFormat.value;
  localStorage.setItem(STORAGE_FORMAT, el.batchFormat.value);
  updateSingleActionState();
});

const savedBatchMode = localStorage.getItem(STORAGE_BATCH_MODE);
if (['zip', 'combined', 'separate'].includes(savedBatchMode ?? '')) {
  el.batchMode.value = savedBatchMode;
}

const MODE_BUTTON_LABELS = {
  combined: 'Export merged file',
  zip: 'Export ZIP',
  separate: 'Export separate files',
};

const updateModeLabel = () => {
  el.batchExportLabel.textContent =
    MODE_BUTTON_LABELS[el.batchMode.value] ?? 'Export selected';
};
updateModeLabel();

el.batchMode.addEventListener('change', () => {
  localStorage.setItem(STORAGE_BATCH_MODE, el.batchMode.value);
  updateModeLabel();
});

el.siteSearch.addEventListener('input', renderSiteList);

document.querySelector('#selectAll').addEventListener('click', () => {
  for (const entry of sites) {
    if (
      entry.site
        .toLowerCase()
        .includes(el.siteSearch.value.trim().toLowerCase())
    ) {
      selectedSites.add(entry.site);
    }
  }
  persistSelection();
  renderSiteList();
});

document.querySelector('#selectNone').addEventListener('click', () => {
  const query = el.siteSearch.value.trim().toLowerCase();
  for (const entry of sites) {
    if (!entry.site.toLowerCase().includes(query)) continue;
    selectedSites.delete(entry.site);
  }
  persistSelection();
  renderSiteList();
});

document.querySelector('#selectInvert').addEventListener('click', () => {
  const query = el.siteSearch.value.trim().toLowerCase();
  for (const entry of sites) {
    if (!entry.site.toLowerCase().includes(query)) continue;
    if (selectedSites.has(entry.site)) selectedSites.delete(entry.site);
    else selectedSites.add(entry.site);
  }
  persistSelection();
  renderSiteList();
});

const getSelectedGroups = () =>
  sites
    .filter((entry) => selectedSites.has(entry.site))
    .map((entry) => ({ site: entry.site, cookies: entry.cookies }));

el.batchCopy.addEventListener('click', async () => {
  const groups = getSelectedGroups();
  if (!groups.length) {
    setBatchStatus('Select at least one site first.', 'error');
    return;
  }
  if (!beginExclusiveAction()) return;
  try {
    const text = serializeCombined(groups, el.batchFormat.value);
    await setClipboard(text, el.batchCopy);
    setBatchStatus(
      `Copied ${groups.length} site(s) as ${el.batchFormat.value} text.`,
    );
  } catch (error) {
    setBatchStatus(`Copy failed: ${error.message}`, 'error');
  } finally {
    endExclusiveAction();
  }
});

el.batchExport.addEventListener('click', async () => {
  const groups = getSelectedGroups();
  if (!groups.length) return;

  const formatKey = el.batchFormat.value;
  const mode = el.batchMode.value;
  const format = getFormat(formatKey);
  if (!format) {
    setBatchStatus('Unsupported export format.', 'error');
    return;
  }
  if (!beginExclusiveAction()) return;

  const date = new Date();

  updateSummary();
  setBatchStatus('Packaging cookies…');

  try {
    const { files, totalCookies } = buildBatchExport({
      groups,
      formatKey,
      mode,
      date,
    });

    if (mode === 'separate') {
      for (const [index, file] of files.entries()) {
        const { base, ext } = splitFileName(file.name);
        await saveToFile(file.data, base, {
          ext,
          mimeType: format.mimeType,
        });
        if (index < files.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
      setBatchStatus(
        `Started ${files.length} downloads (${totalCookies} cookies from ${groups.length} sites).`,
      );
      return;
    }

    const file = files[0];
    const { base, ext } = splitFileName(file.name);
    const mimeType = mode === 'zip' ? 'application/zip' : format.mimeType;
    await saveToFile(file.data, base, { ext, mimeType });
    setBatchStatus(
      mode === 'combined'
        ? `Started ${file.name} — ${groups.length} sites combined into one file, ${totalCookies} cookies.`
        : `Started ${file.name} — ${groups.length} sites, ${totalCookies} cookies.`,
    );
  } catch (error) {
    setBatchStatus(`Export failed: ${error.message}`, 'error');
  } finally {
    endExclusiveAction();
  }
});

// ----------------------------------------------
// Init
// ----------------------------------------------
// Active-tab initialization is already kicked off above so both panels share
// one snapshot and one permission check.
