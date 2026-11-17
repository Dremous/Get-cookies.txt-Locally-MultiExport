/**
 * Get all cookies that match the given criteria.
 * @param {chrome.cookies.GetAllDetails} details
 * @returns {Promise<chrome.cookies.Cookie[]>}
 */
export default async function getAllCookies(details) {
  details.storeId ??= await getCurrentCookieStoreId();
  const { partitionKey, ...detailsWithoutPartitionKey } = details;
  // Error handling for browsers that do not support partitionKey, such as chrome < 119.
  // `chrome.cookies.getAll()` returns Promise but cannot directly catch() chain.
  const cookiesWithPartitionKey = partitionKey
    ? await Promise.resolve()
        .then(() => chrome.cookies.getAll(details))
        .catch(() => [])
    : [];
  const cookies = await chrome.cookies.getAll(detailsWithoutPartitionKey);
  return [...cookies, ...cookiesWithPartitionKey];
}

/**
 * Fingerprint used to drop duplicates when merging cookie lists.
 * @param {chrome.cookies.Cookie} cookie
 */
const cookieKey = (cookie) =>
  [
    cookie.storeId ?? '',
    cookie.partitionKey?.topLevelSite ?? '',
    cookie.domain ?? '',
    cookie.path ?? '',
    cookie.name ?? '',
  ].join('\u0000');

/**
 * Remove duplicate cookies (same store, partition, domain, path and name).
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
 * @returns {Promise<chrome.cookies.Cookie[]>}
 */
export async function getAllCookiesForBatch() {
  const cookies = await getAllCookies({});

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url;
  try {
    url = new URL(tab?.url);
  } catch {
    return cookies;
  }

  const partitioned = await getAllCookies({
    url: url.href,
    partitionKey: { topLevelSite: url.origin },
  });
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
  if (tab.cookieStoreId) return tab.cookieStoreId;

  // Chrome does not support the `tab.cookieStoreId` property.
  const stores = await chrome.cookies.getAllCookieStores();
  return stores.find((store) => store.tabIds.includes(tab.id))?.id;
};
