const DEFAULT_DEBOUNCE_MS = 80;

/**
 * Create the active-tab badge updater.
 *
 * The updater is intentionally serialized by a generation token: several
 * cookie/tab events can overlap, and a slower earlier query must not overwrite
 * a newer badge value.
 *
 * @param {{
 *   getActiveTab: () => Promise<{ id?: number, url?: string } | undefined>,
 *   getPartitionKey: (tab: { id?: number, url?: string }) => Promise<chrome.cookies.CookiePartitionKey | null>,
 *   getAllCookies: (details: chrome.cookies.GetAllDetails, options?: { activeTab?: chrome.tabs.Tab | null }) => Promise<chrome.cookies.Cookie[]>,
 *   setBadgeText: (tabId: number, text: string) => Promise<void>,
 *   debounceMs?: number,
 *   setTimeoutFn?: (callback: () => void, delay: number) => unknown,
 *   clearTimeoutFn?: (timer: unknown) => void,
 *   logger?: Pick<Console, 'warn'>,
 * }} options
 */
export const createBadgeCounter = ({
  getActiveTab,
  getPartitionKey,
  getAllCookies,
  setBadgeText,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
}) => {
  if (typeof getActiveTab !== 'function') {
    throw new TypeError('createBadgeCounter requires getActiveTab');
  }
  if (typeof getPartitionKey !== 'function') {
    throw new TypeError('createBadgeCounter requires getPartitionKey');
  }
  if (typeof getAllCookies !== 'function') {
    throw new TypeError('createBadgeCounter requires getAllCookies');
  }
  if (typeof setBadgeText !== 'function') {
    throw new TypeError('createBadgeCounter requires setBadgeText');
  }

  let generation = 0;
  let timer = null;
  let disposed = false;

  const clearBadge = async (tabId, run) => {
    if (run !== generation) return;
    try {
      await setBadgeText(tabId, '');
    } catch {
      // A tab can disappear between the query and the clear.
    }
  };

  const update = async () => {
    if (disposed) return;

    const run = ++generation;
    let tabId;

    try {
      const tab = await getActiveTab();
      if (!tab || typeof tab.id !== 'number') return;
      tabId = tab.id;
      if (run !== generation) return;

      if (!tab.url) {
        await clearBadge(tabId, run);
        return;
      }

      const url = new URL(tab.url);
      const partitionKey = await getPartitionKey(tab);
      if (run !== generation) return;

      const details = { url: url.href };
      if (partitionKey) details.partitionKey = partitionKey;
      const cookies = await getAllCookies(details, { activeTab: tab });
      if (run !== generation) return;

      await setBadgeText(tabId, cookies.length.toFixed());
    } catch (error) {
      await clearBadge(tabId, run);
      if (!/No tab with id/i.test(error?.message ?? '')) {
        logger.warn('[badge] update failed', error);
      }
    }
  };

  const schedule = () => {
    if (disposed) return;
    if (timer !== null) clearTimeoutFn(timer);
    timer = setTimeoutFn(() => {
      timer = null;
      void update();
    }, debounceMs);
  };

  const dispose = () => {
    disposed = true;
    generation += 1;
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  };

  return { update, schedule, dispose };
};
