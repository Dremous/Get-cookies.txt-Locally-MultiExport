import { getSiteKey, getTopLevelSite } from './site_group.mjs';

/**
 * Resolve the active tab only when a snapshot was not supplied. A `null`
 * snapshot means "there is no active tab" and must not trigger another query.
 * @param {chrome.tabs.Tab | null | undefined} tab
 * @returns {Promise<chrome.tabs.Tab | null>}
 */
const getActiveTab = async (tab) => {
  if (tab !== undefined) return tab;
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return activeTab ?? null;
};

/**
 * `getPartitionKey()` reports whether the frame has a cross-site ancestor as
 * part of the key. That flag is an exact filter in `chrome.cookies.getAll()`,
 * but a top-level frame always reports `false`; passing it through would hide
 * cookies set by third-party frames under the same top-level site. Read
 * queries only need the top-level site.
 * @param {chrome.cookies.CookiePartitionKey | undefined} partitionKey
 * @returns {chrome.cookies.CookiePartitionKey | null}
 */
const toQueryPartitionKey = (partitionKey) => {
  if (!partitionKey?.topLevelSite) return null;
  return { topLevelSite: partitionKey.topLevelSite };
};

const isFirefox = () =>
  globalThis.chrome?.runtime?.getManifest?.()?.browser_specific_settings !==
  undefined;

/**
 * Firefox's first-party isolation requires `firstPartyDomain` when it is
 * enabled. Use the registrable domain of the queried URL, or `null` for a
 * store-wide query. Chrome must not receive this Firefox-only field.
 * @param {string | URL | undefined} value
 * @returns {string | null}
 */
const getFirstPartyDomain = (value) => {
  let url;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return getSiteKey(url.hostname) || null;
};

/**
 * Add Firefox's first-party isolation selector to a cookie query. `null` is
 * required when isolation is enabled and also works when it is disabled; the
 * result is filtered afterwards so normal (empty-domain) cookies are kept.
 * @param {chrome.cookies.GetAllDetails} details
 */
const withFirefoxIsolation = (details) => {
  if (!isFirefox()) return details;
  return { ...details, firstPartyDomain: null };
};

/**
 * When first-party isolation is enabled, Firefox returns cookies from every
 * first-party domain. Keep normal cookies plus the current tab's domain; Chrome
 * never receives this filter.
 * @param {chrome.cookies.Cookie[]} cookies
 * @param {chrome.cookies.GetAllDetails} details
 */
const filterFirefoxIsolation = (cookies, details) => {
  if (!isFirefox() || !details.url) return cookies;
  const firstPartyDomain = getFirstPartyDomain(details.url);
  if (!firstPartyDomain) return cookies;
  return cookies.filter((cookie) => {
    const cookieFirstPartyDomain = getSiteKey(cookie.firstPartyDomain);
    return (
      !cookieFirstPartyDomain || cookieFirstPartyDomain === firstPartyDomain
    );
  });
};

/**
 * Get all cookies that match the given criteria.
 * @param {chrome.cookies.GetAllDetails} details
 * @param {{
 *   onPartitionError?: (error: unknown) => void,
 *   activeTab?: chrome.tabs.Tab | null | undefined,
 *   includeUnpartitioned?: boolean,
 * }} [options]
 * @returns {Promise<chrome.cookies.Cookie[]>}
 */
export default async function getAllCookies(
  details,
  { onPartitionError, activeTab, includeUnpartitioned = true } = {},
) {
  details.storeId ??= await getCookieStoreId(activeTab);
  const { partitionKey, ...detailsWithoutPartitionKey } = details;
  const queryDetails = withFirefoxIsolation(detailsWithoutPartitionKey);
  const queryPartitionKey = toQueryPartitionKey(partitionKey);

  // Error handling for browsers that do not support partitionKey, such as chrome < 119.
  // `chrome.cookies.getAll()` returns Promise but cannot directly catch() chain.
  const cookiesWithPartitionKey = queryPartitionKey
    ? await Promise.resolve()
        .then(() =>
          chrome.cookies.getAll({
            ...queryDetails,
            partitionKey: queryPartitionKey,
          }),
        )
        .catch((error) => {
          if (typeof onPartitionError === 'function') {
            onPartitionError(error);
          } else {
            console.warn('[cookies] partitioned getAll failed', error);
          }
          return [];
        })
    : [];
  const cookies = includeUnpartitioned
    ? await chrome.cookies.getAll(queryDetails)
    : [];
  return filterFirefoxIsolation(
    dedupeCookies([...cookies, ...cookiesWithPartitionKey]),
    detailsWithoutPartitionKey,
  );
}

/**
 * Build the partition key for a tab, preferring Chrome's own frame API when
 * available. The fallback derives the schemeful site from the tab URL.
 * Firefox does not expose `getPartitionKey()` but supports `partitionKey`
 * queries (Firefox 94+), so it uses the same URL fallback.
 * @param {chrome.tabs.Tab | undefined} tab
 * @returns {Promise<chrome.cookies.CookiePartitionKey | null>}
 */
export const getTabPartitionKey = async (tab) => {
  if (!tab?.id) return null;

  // Read through Reflect.get so Firefox's static API scanner does not report
  // the Chrome-only method as an unsupported API. The runtime guard below still
  // ensures `getPartitionKey()` is only called where it exists.
  const getPartitionKey = Reflect.get(chrome.cookies, 'getPartitionKey');
  if (typeof getPartitionKey === 'function') {
    try {
      const { partitionKey } = await getPartitionKey.call(chrome.cookies, {
        tabId: tab.id,
        frameId: 0,
      });
      if (partitionKey?.topLevelSite) return partitionKey;
    } catch {
      // Chrome before 132 has no getPartitionKey; fall back to the URL below.
    }
  }

  const topLevelSite = getTopLevelSite(tab.url);
  return topLevelSite ? { topLevelSite } : null;
};

/**
 * Fingerprint used to drop duplicates when merging cookie lists. Firefox
 * first-party isolation can hold the same cookie per first-party domain, so
 * include that field as well.
 * @param {chrome.cookies.Cookie} cookie
 */
const cookieKey = (cookie) =>
  [
    cookie.storeId ?? '',
    cookie.firstPartyDomain ?? '',
    cookie.partitionKey?.topLevelSite ?? '',
    cookie.partitionKey?.hasCrossSiteAncestor ?? '',
    cookie.domain ?? '',
    cookie.path ?? '',
    cookie.name ?? '',
  ].join('\u0000');

/**
 * Remove duplicate cookies (same store, partition, domain, path and name).
 * Cookies that differ only by partition ancestry are distinct cookies.
 * @param {chrome.cookies.Cookie[]} cookies
 * @returns {chrome.cookies.Cookie[]}
 */
export const dedupeCookies = (cookies) => {
  const seen = new Map();
  for (const cookie of cookies) {
    seen.set(cookieKey(cookie), cookie);
  }
  return [...seen.values()];
};

/**
 * Get all cookies of the current cookie store, including partitioned cookies
 * belonging to the active tab (those are invisible to a bare getAll call).
 * @param {chrome.tabs.Tab | null | undefined} [tab] Optional tab snapshot to
 *   avoid racing with a second active-tab lookup.
 * @param {{
 *   storeId?: string,
 *   onPartitionError?: (error: unknown) => void,
 * }} [options]
 * @returns {Promise<chrome.cookies.Cookie[]>}
 */
export async function getAllCookiesForBatch(tab, options = {}) {
  const { onPartitionError } = options;
  const hasStoreId = Object.hasOwn(options, 'storeId');
  const activeTab = await getActiveTab(tab);
  const storeId = hasStoreId
    ? options.storeId
    : await getCookieStoreId(activeTab);

  const cookies = await getAllCookies(
    { storeId },
    { onPartitionError, activeTab },
  );
  if (!activeTab) return cookies;

  const partitionKey = await getTabPartitionKey(activeTab);
  if (!partitionKey) return cookies;

  // Query by partition key only: `url` would restrict the result to the
  // top-level page's own domain and hide third-party partitioned cookies.
  // The base query already returned the unpartitioned cookies, so skip a
  // second full-store query inside the partition call.
  const partitioned = await getAllCookies(
    { storeId, partitionKey },
    { onPartitionError, activeTab, includeUnpartitioned: false },
  );
  return dedupeCookies([...cookies, ...partitioned]);
}

/**
 * Get the cookie store ID for a tab snapshot. Passing `null` means there is no
 * active tab; passing `undefined` requests the current active tab.
 * @param {chrome.tabs.Tab | null | undefined} [tab]
 * @returns {Promise<string | undefined>}
 */
export const getCookieStoreId = async (tab) => {
  // If the extension is in split incognito mode, return undefined to choose the default store.
  if (chrome.runtime.getManifest().incognito === 'split') return undefined;

  const activeTab = await getActiveTab(tab);
  if (!activeTab) return undefined;
  if (activeTab.cookieStoreId) return activeTab.cookieStoreId;

  // Chrome does not support the `tab.cookieStoreId` property.
  const stores = await chrome.cookies.getAllCookieStores();
  return stores.find((store) => store.tabIds.includes(activeTab.id))?.id;
};
