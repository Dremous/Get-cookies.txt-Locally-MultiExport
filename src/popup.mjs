import { bytesToBase64 } from './modules/base64.mjs';
import {
  buildBatchExport,
  serializeCombined,
} from './modules/batch_export.mjs';
import { formatMap, jsonToNetscapeMapper } from './modules/cookie_format.mjs';
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

/** Promise to get URL of Active Tab (null when the tab has no web URL) */
const getUrlPromise = chrome.tabs
  .query({ active: true, currentWindow: true })
  .then(([tab]) => {
    try {
      return new URL(tab?.url);
    } catch {
      return null;
    }
  })
  .catch(() => null);

/**
 * Get the partition key for the active tab's top-level frame.
 * @returns {Promise<chrome.cookies.CookiePartitionKey | null>}
 */
const getActiveTabPartitionKey = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return getTabPartitionKey(tab);
};

const STORAGE_FORMAT = 'selectedFormat';
const STORAGE_BATCH_FORMAT = 'batchFormat';
const STORAGE_BATCH_MODE = 'batchModeV2';
const STORAGE_BATCH_SELECTION = 'batchSelection';

// ----------------------------------------------
// State
// ----------------------------------------------

/** @type {Array<{ site: string, cookies: chrome.cookies.Cookie[], cookieCount: number, domainCount: number }>} */
let sites = [];
/** @type {Set<string>} */
const selectedSites = new Set();
/** @type {string} */
let currentSiteKey = '';

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
 * @returns {Promise<{ text: string, format: Format }>}
 */
const getCookieText = async (details, formatKey = el.format.value) => {
  const cookies = await getAllCookies(details);
  const format = formatMap[formatKey];
  if (!format) throw new Error('Invalid format');
  const text = format.serializer(cookies);
  return { text, format };
};

// TODO: use offscreen API to integrate implementation in chrome and firefox
/**
 * Save text or binary data as a file
 * Firefox cannot use saveAs in a popup, so the background script handles it.
 * @param {string | Uint8Array} data
 * @param {string} name
 * @param {{ ext: string, mimeType: string }} format
 * @param {boolean} saveAs
 */
const saveToFile = async (data, name, format, saveAs = false) => {
  const isFirefox =
    chrome.runtime.getManifest().browser_specific_settings !== undefined;
  if (isFirefox) {
    const payload = {
      name,
      format: { ext: format.ext, mimeType: format.mimeType },
      saveAs,
    };
    if (data instanceof Uint8Array) payload.base64 = bytesToBase64(data);
    else payload.text = data;
    await chrome.runtime.sendMessage({
      type: 'save',
      target: 'background',
      data: payload,
    });
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
  await navigator.clipboard.writeText(text);
  if (!button) return;
  button.classList.add('copied');
  setTimeout(() => {
    button.classList.remove('copied');
  }, 2000);
};

/** @param {string} message @param {'info' | 'error'} [kind] */
const setBatchStatus = (message, kind = 'info') => {
  el.batchStatus.textContent = message;
  el.batchStatus.dataset.kind = kind;
};

/** @param {string} message @param {'info' | 'error'} [kind] */
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
  el.batchExport.disabled = selectedSites.size === 0;
  el.batchCopy.disabled = selectedSites.size === 0;
};

const renderSiteList = () => {
  const query = el.siteSearch.value.trim().toLowerCase();
  const visible = sites.filter(
    (entry) => !query || entry.site.toLowerCase().includes(query),
  );

  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'site-empty';
    empty.textContent = query
      ? 'No site matches this filter.'
      : 'No cookies found in this cookie store.';
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
  const url = await getUrlPromise;
  currentSiteKey = url ? getSiteKey(url.hostname) : '';

  const cookies = await getAllCookiesForBatch();
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
};

// ----------------------------------------------
// Actions after resolving the promise
// ----------------------------------------------

/** Set URL in the header */
getUrlPromise.then((url) => {
  el.location.textContent = url?.href ?? 'this page';
  el.location.href = url?.href ?? '#';
});

/** Set Cookies data to the table */
getUrlPromise
  .then(async (url) => {
    if (!url) return [];
    const partitionKey = await getActiveTabPartitionKey();
    const details = { url: url.href };
    if (partitionKey) details.partitionKey = partitionKey;
    return getAllCookies(details).catch(() => []);
  })
  .then((cookies) => {
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
    document
      .querySelector('#netscapeTable tbody')
      .replaceChildren(...tableRows);
  });

// ----------------------------------------------
// Tabs
// ----------------------------------------------

const activatePanel = (panelId) => {
  const isSingle = panelId === 'singlePanel';
  el.tabSingle.classList.toggle('active', isSingle);
  el.tabMulti.classList.toggle('active', !isSingle);
  el.tabSingle.setAttribute('aria-selected', String(isSingle));
  el.tabMulti.setAttribute('aria-selected', String(!isSingle));
  el.panelSingle.hidden = !isSingle;
  el.panelMulti.hidden = isSingle;
  if (isSingle) el.tabSingle.focus();
  else el.tabMulti.focus();
};

el.tabSingle.addEventListener('click', () => activatePanel('singlePanel'));
el.tabMulti.addEventListener('click', () => activatePanel('multiPanel'));

// ----------------------------------------------
// Event Listeners — single site
// ----------------------------------------------

const getCurrentSiteDetails = async () => {
  const url = await getUrlPromise;
  if (!url) throw new Error('No active page URL');
  const partitionKey = await getActiveTabPartitionKey();
  const details = { url: url.href };
  if (partitionKey) details.partitionKey = partitionKey;
  return { url, details };
};

document.querySelector('#export').addEventListener('click', async () => {
  try {
    const { url, details } = await getCurrentSiteDetails();
    const { text, format } = await getCookieText(details);
    await saveToFile(text, `${url.hostname}_cookies`, format);
    setSingleStatus(`Saved ${url.hostname}_cookies${format.ext}`);
  } catch (error) {
    setSingleStatus(`Export failed: ${error.message}`, 'error');
  }
});

document.querySelector('#exportAs').addEventListener('click', async () => {
  try {
    const { url, details } = await getCurrentSiteDetails();
    const { text, format } = await getCookieText(details);
    await saveToFile(text, `${url.hostname}_cookies`, format, true);
    setSingleStatus(`Started export for ${url.hostname}_cookies${format.ext}`);
  } catch (error) {
    setSingleStatus(`Export failed: ${error.message}`, 'error');
  }
});

document.querySelector('#copy').addEventListener('click', async () => {
  try {
    const { details } = await getCurrentSiteDetails();
    const { text } = await getCookieText(details);
    await setClipboard(text, document.querySelector('#copy'));
    setSingleStatus('Copied current site cookies.');
  } catch (error) {
    setSingleStatus(`Copy failed: ${error.message}`, 'error');
  }
});

document.querySelector('#exportAll').addEventListener('click', async () => {
  try {
    const { text, format } = await getCookieText({ partitionKey: {} });
    await saveToFile(text, 'cookies', format);
    setSingleStatus(`Saved cookies${format.ext}`);
  } catch (error) {
    setSingleStatus(`Export failed: ${error.message}`, 'error');
  }
});

/** Set last used format value */
const selectedFormat = localStorage.getItem(STORAGE_FORMAT);
if (selectedFormat && formatMap[selectedFormat]) {
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
  formatMap[savedBatchFormat]
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
  const format = formatMap[formatKey];
  const date = new Date();

  el.batchExport.disabled = true;
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
        ? `Saved ${file.name} — ${groups.length} sites combined into one file, ${totalCookies} cookies.`
        : `Saved ${file.name} — ${groups.length} sites, ${totalCookies} cookies.`,
    );
  } catch (error) {
    setBatchStatus(`Export failed: ${error.message}`, 'error');
  } finally {
    updateSummary();
  }
});

// ----------------------------------------------
// Init
// ----------------------------------------------

loadSites().catch((error) => {
  setBatchStatus(`Could not read cookies: ${error.message}`, 'error');
});
