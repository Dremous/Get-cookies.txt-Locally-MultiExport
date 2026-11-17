import {
  buildBatchExport,
  serializeCombined,
} from './modules/batch_export.mjs';
import { formatMap, jsonToNetscapeMapper } from './modules/cookie_format.mjs';
import getAllCookies, {
  getAllCookiesForBatch,
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
  });

const STORAGE_FORMAT = 'selectedFormat';
const STORAGE_BATCH_FORMAT = 'batchFormat';
const STORAGE_BATCH_MODE = 'batchMode';
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
  batchCopy: document.querySelector('#batchCopy'),
  batchStatus: document.querySelector('#batchStatus'),
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
    await chrome.runtime.sendMessage({
      type: 'save',
      target: 'background',
      data: { text: data, name, format, saveAs },
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
  el.siteCountBadge.textContent = sites.length.toFixed();
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
      : 'No cookies found in this browser profile.';
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
      badge.textContent = 'current';
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
  .then((url) =>
    url
      ? getAllCookies({
          url: url.href,
          partitionKey: { topLevelSite: url.origin },
        }).catch(() => [])
      : [],
  )
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

document.querySelector('#export').addEventListener('click', async () => {
  const url = await getUrlPromise;
  if (!url) return;
  const details = { url: url.href, partitionKey: { topLevelSite: url.origin } };
  const { text, format } = await getCookieText(details);
  saveToFile(text, `${url.hostname}_cookies`, format);
});

document.querySelector('#exportAs').addEventListener('click', async () => {
  const url = await getUrlPromise;
  if (!url) return;
  const details = { url: url.href, partitionKey: { topLevelSite: url.origin } };
  const { text, format } = await getCookieText(details);
  saveToFile(text, `${url.hostname}_cookies`, format, true);
});

document.querySelector('#copy').addEventListener('click', async () => {
  const url = await getUrlPromise;
  if (!url) return;
  const details = { url: url.href, partitionKey: { topLevelSite: url.origin } };
  const { text } = await getCookieText(details);
  setClipboard(text, document.querySelector('#copy'));
});

document.querySelector('#exportAll').addEventListener('click', async () => {
  const { text, format } = await getCookieText({ partitionKey: {} });
  saveToFile(text, 'cookies', format);
});

/** Set last used format value */
const selectedFormat = localStorage.getItem(STORAGE_FORMAT);
if (selectedFormat && formatMap[selectedFormat]) {
  el.format.value = selectedFormat;
}
el.format.addEventListener('change', () => {
  localStorage.setItem(STORAGE_FORMAT, el.format.value);
  el.batchFormat.value = el.format.value;
  localStorage.setItem(STORAGE_BATCH_FORMAT, el.format.value);
});

// ----------------------------------------------
// Event Listeners — multi site
// ----------------------------------------------

const savedBatchFormat = localStorage.getItem(STORAGE_BATCH_FORMAT);
if (savedBatchFormat && formatMap[savedBatchFormat]) {
  el.batchFormat.value = savedBatchFormat;
} else {
  el.batchFormat.value = el.format.value;
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
el.batchMode.addEventListener('change', () => {
  localStorage.setItem(STORAGE_BATCH_MODE, el.batchMode.value);
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
  selectedSites.clear();
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
  if (!groups.length) return;
  const text = serializeCombined(groups, el.batchFormat.value);
  await setClipboard(text, el.batchCopy);
  setBatchStatus(
    `Copied ${groups.length} site(s) as ${el.batchFormat.value} text.`,
  );
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
      `Saved ${file.name} — ${groups.length} sites, ${totalCookies} cookies.`,
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
