import { getTopLevelSite } from './site_group.mjs';

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

/**
 * Get all cookies that match the given criteria.
 * @param {chrome.cookies.GetAllDetails} details
 * @returns {Promise<chrome.cookies.Cookie[]>}
 */
export default async function getAllCookies(details) {
  details.storeId ??= await getCurrentCookieStoreId();
  const { partitionKey, ...detailsWithoutPartitionKey } = details;
  const queryPartitionKey = toQueryPartitionKey(partitionKey);

  // Error handling for browsers that do not support partitionKey, such as chrome < 119.
  // `chrome.cookies.getAll()` returns Promise but cannot directly catch() chain.
  const cookiesWithPartitionKey = queryPartitionKey
    ? await Promise.resolve()
        .then(() =>
          chrome.cookies.getAll({
            ...detailsWithoutPartitionKey,
            partitionKey: queryPartitionKey,
          }),
        )
        .catch((error) => {
          console.warn('[cookies] partitioned getAll failed', error);
          return [];
        })
    : [];
  const cookies = await chrome.cookies.getAll(detailsWithoutPartitionKey);
  return [...cookies, ...cookiesWithPartitionKey];
}

/**
 * Build the CHIPS partition key for a tab, preferring Chrome's own frame API
 * when available. The fallback derives the schemeful site from the tab URL.
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
 * Fingerprint used to drop duplicates when merging cookie lists.
 * @param {chrome.cookies.Cookie} cookie
 */
const cookieKey = (cookie) =>
  [
    cookie.storeId ?? '',
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
 * @param {chrome.tabs.Tab | undefined} [tab] Optional tab snapshot to avoid
 *   racing with a second active-tab lookup.
 * @returns {Promise<chrome.cookies.Cookie[]>}
 */
export async function getAllCookiesForBatch(tab) {
  const cookies = await getAllCookies({});

  const activeTab =
    tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const partitionKey = await getTabPartitionKey(activeTab);
  if (!partitionKey) return cookies;

  // Query by partition key only: `url` would restrict the result to the
  // top-level page's own domain and hide third-party partitioned cookies.
  const partitioned = await getAllCookies({ partitionKey });
  return dedupeCookies([...cookies, ...partitioned]);
}

/**
 * Get the current cookie store ID.
 * @returns {Promise<string | undefined>}
 */
const getCurrentCookieStoreId = async () => {
  // If the extension is in split incognito mode, return undefined to choose the default store.
  if (chrome.runtime.getManifest().incognito === 'split') return undefined;

  // Firefox supports the `tab.cookieStoreId` property.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return undefined;
  if (tab.cookieStoreId) return tab.cookieStoreId;

  // Chrome does not support the `tab.cookieStoreId` property.
  const stores = await chrome.cookies.getAllCookieStores();
  return stores.find((store) => store.tabIds.includes(tab.id))?.id;
};
