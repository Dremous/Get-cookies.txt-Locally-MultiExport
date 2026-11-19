import { bytesToBase64 } from './modules/base64.mjs';
import {
  buildBatchExport,
  serializeCombined,
  siteCookieBaseName,
} from './modules/batch_export.mjs';
import { writeClipboard } from './modules/clipboard.mjs';
import { formatMap, jsonToNetscapeMapper } from './modules/cookie_format.mjs';
import { createExportGuard } from './modules/export_guard.mjs';
import getAllCookies, {
  getAllCookiesForBatch,
  getTabPartitionKey,
} from './modules/get_all_cookies.mjs';
import _saveToFile from './modules/save_to_file.mjs';
import {
  getSiteKey,
  groupCookiesBySite,
  toSiteList,
} from './modules/site_group.mjs';

/**
 * Read the active tab, its URL and its partition key from one tab snapshot.
 * Keeping these values together prevents an export from mixing a stale URL
 * with a partition key taken from a different tab.
 * @returns {Promise<{ tab: chrome.tabs.Tab | null, url: URL | null, partitionKey: chrome.cookies.CookiePartitionKey | null }>}
 */
const getActiveTabSnapshot = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { tab: null, url: null, partitionKey: null };

  let url = null;
  try {
    url = tab.url ? new URL(tab.url) : null;
  } catch {
    url = null;
  }

  return {
    tab,
    url,
    partitionKey: await getTabPartitionKey(tab),
  };
};

const STORAGE_FORMAT = 'selectedFormat';
const STORAGE_BATCH_FORMAT = 'batchFormat';
const STORAGE_BATCH_MODE = 'batchModeV2';
const STORAGE_BATCH_SELECTION = 'batchSelection';

const isFirefox = () =>
  chrome.runtime.getManifest().browser_specific_settings !== undefined;

/**
 * Firefox MV3 host access is opt-in. Chrome returns true immediately because
 * the extension is already granted the manifest host permission there.
 * @returns {Promise<boolean>}
 */
const hasHostPermission = async () => {
  if (!isFirefox()) return true;
  try {
    if (typeof chrome.permissions?.contains !== 'function') return true;
    return await chrome.permissions.contains({ origins: ['<all_urls>'] });
  } catch {
    return true;
  }
};

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
let hostPermissionMissing = false;
const exportGuard = createExportGuard();

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
};

// ----------------------------------------------
// Functions
// ----------------------------------------------

/**
 * Get Stringified Cookies Text and Format Data
 * @param {chrome.cookies.GetAllDetails} details
 * @param {string} [formatKey]
 * @returns {Promise<{ text: string, format: Format, warnings: unknown[] }>}
 */
const getCookieText = async (details, formatKey = el.format.value) => {
  const warnings = [];
  const cookies = await getAllCookies(details, {
    onPartitionError: (error) => warnings.push(error),
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
  if (!button) return;
  button.classList.add('copied');
  setTimeout(() => {
    button.classList.remove('copied');
  }, 2000);
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
  el.selectionText.textContent = `${selectedSites.size} of ${sites.length} sites selected${
    visibleSites.length !== sites.length
      ? ` (${selectedVisible} of ${visibleSites.length} shown)`
      : ''
  }`;
  el.cookieCountText.textContent = `${selectedCookieCount()} cookies`;
  el.siteCountBadge.textContent = `(${sites.length})`;
  el.batchExport.disabled = exportGuard.busy || selectedSites.size === 0;
  el.batchCopy.disabled = exportGuard.busy || selectedSites.size === 0;
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
    } else if (hostPermissionMissing) {
      empty.textContent =
        'Firefox has not granted access to all websites. Open about:addons, open Permissions, and enable "Access your data for all websites". Reopen this popup after granting access.';
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
 * Load all cookies of this store and build the site list.
 */
const loadSites = async () => {
  hostPermissionMissing = !(await hasHostPermission());
  if (hostPermissionMissing) {
    sites = [];
    renderSiteList();
    setBatchStatus(
      'Firefox host permission is required. See the site list instructions.',
      'warning',
    );
    return;
  }

  const snapshot = await getActiveTabSnapshot();
  currentSiteKey = snapshot.url ? getSiteKey(snapshot.url.hostname) : '';

  const warnings = [];
  const cookies = await getAllCookiesForBatch(snapshot.tab, {
    onPartitionError: (error) => warnings.push(error),
  });
  sites = toSiteList(groupCookiesBySite(cookies));
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
  } else if (
    currentSiteKey &&
    sites.some((entry) => entry.site === currentSiteKey)
  ) {
    selectedSites.add(currentSiteKey);
  }

  renderSiteList();
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

/** Populate the header and single-site cookie table from one tab snapshot. */
const initializeSingleSite = async () => {
  hostPermissionMissing = !(await hasHostPermission());
  if (hostPermissionMissing) {
    document.querySelector('#netscapeTable tbody').replaceChildren();
    setSingleStatus(
      'Firefox host permission is required. Open about:addons, open Permissions, and enable "Access your data for all websites", then reopen this popup.',
      'warning',
    );
    return;
  }

  const { url, partitionKey } = await getActiveTabSnapshot();
  el.location.textContent = url?.href ?? 'this page';
  el.location.href = url?.href ?? '#';
  if (!url) {
    document.querySelector('#netscapeTable tbody').replaceChildren();
    setSingleStatus('No active page URL.', 'error');
    return;
  }

  const warnings = [];
  const details = { url: url.href };
  if (partitionKey) details.partitionKey = partitionKey;
  const cookies = await getAllCookies(details, {
    onPartitionError: (error) => warnings.push(error),
  });
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
  if (warnings.length) {
    setSingleStatus(
      'Some partitioned cookies could not be read; the table may be incomplete.',
      'warning',
    );
  }
};

initializeSingleSite().catch((error) => {
  document.querySelector('#netscapeTable tbody').replaceChildren();
  setSingleStatus(`Could not read cookies: ${error.message}`, 'error');
});

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
  const { url, partitionKey } = await getActiveTabSnapshot();
  if (!url) throw new Error('No active page URL');
  const details = { url: url.href };
  if (partitionKey) details.partitionKey = partitionKey;
  return { url, details };
};

document.querySelector('#export').addEventListener('click', async () => {
  try {
    const { url, details } = await getCurrentSiteDetails();
    const { text, format, warnings } = await getCookieText(details);
    const base = siteCookieBaseName(url.hostname);
    await saveToFile(text, base, format);
    setSingleStatus(
      `Started export of ${base}${format.ext}${partitionWarningText(warnings)}`,
      warnings.length ? 'warning' : 'info',
    );
  } catch (error) {
    setSingleStatus(`Export failed: ${error.message}`, 'error');
  }
});

document.querySelector('#exportAs').addEventListener('click', async () => {
  try {
    const { url, details } = await getCurrentSiteDetails();
    const { text, format, warnings } = await getCookieText(details);
    const base = siteCookieBaseName(url.hostname);
    await saveToFile(text, base, format, true);
    setSingleStatus(
      `Started export for ${base}${format.ext}${partitionWarningText(warnings)}`,
      warnings.length ? 'warning' : 'info',
    );
  } catch (error) {
    setSingleStatus(`Export failed: ${error.message}`, 'error');
  }
});

document.querySelector('#copy').addEventListener('click', async () => {
  try {
    const { details } = await getCurrentSiteDetails();
    const { text, warnings } = await getCookieText(details);
    await setClipboard(text, document.querySelector('#copy'));
    setSingleStatus(
      `Copied current site cookies.${partitionWarningText(warnings)}`,
      warnings.length ? 'warning' : 'info',
    );
  } catch (error) {
    setSingleStatus(`Copy failed: ${error.message}`, 'error');
  }
});

document.querySelector('#exportAll').addEventListener('click', async () => {
  try {
    const { partitionKey } = await getActiveTabSnapshot();
    const details = partitionKey ? { partitionKey } : {};
    const { text, format, warnings } = await getCookieText(details);
    await saveToFile(text, 'cookies', format);
    setSingleStatus(
      `Started export of cookies${format.ext}${partitionWarningText(warnings)}`,
      warnings.length ? 'warning' : 'info',
    );
  } catch (error) {
    setSingleStatus(`Export failed: ${error.message}`, 'error');
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
  try {
    const groups = getSelectedGroups();
    if (!groups.length) {
      setBatchStatus('Select at least one site first.', 'error');
      return;
    }
    const text = serializeCombined(groups, el.batchFormat.value);
    await setClipboard(text, el.batchCopy);
    setBatchStatus(
      `Copied ${groups.length} site(s) as ${el.batchFormat.value} text.`,
    );
  } catch (error) {
    setBatchStatus(`Copy failed: ${error.message}`, 'error');
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
  if (!exportGuard.begin()) return;

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
    exportGuard.end();
    updateSummary();
  }
});

// ----------------------------------------------
// Init
// ----------------------------------------------

loadSites().catch((error) => {
  setBatchStatus(`Could not read cookies: ${error.message}`, 'error');
});
