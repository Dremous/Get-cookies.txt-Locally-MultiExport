/** Blob URL -> requested download filename. */
const pendingFileNames = new Map();
let filenameListenerRegistered = false;

const CLEANUP_TIMEOUT_MS = 5 * 60_000;
const ANCHOR_CHECK_DELAY_MS = 1000;

const supportsFilenameSuggestion = () =>
  typeof globalThis.chrome?.downloads?.onDeterminingFilename?.addListener ===
  'function';

const ensureFilenameListener = () => {
  if (filenameListenerRegistered || !supportsFilenameSuggestion()) return;

  try {
    globalThis.chrome.downloads.onDeterminingFilename.addListener(
      (item, suggest) => {
        if (typeof suggest !== 'function') return;
        const filename = pendingFileNames.get(item.url);
        if (!filename) {
          suggest();
          return;
        }
        pendingFileNames.delete(item.url);
        suggest({ filename, conflictAction: 'uniquify' });
      },
    );
    filenameListenerRegistered = true;
  } catch {
    // Firefox or older browsers may not expose the event; keep the native name.
  }
};

const isFirefox = () =>
  typeof globalThis.chrome?.runtime?.getManifest === 'function' &&
  globalThis.chrome.runtime.getManifest().browser_specific_settings !==
    undefined;

const canUseAnchorDownload = (saveAs) =>
  !saveAs &&
  typeof document !== 'undefined' &&
  typeof document.createElement === 'function' &&
  !isFirefox();

/**
 * Save text or binary data as a file.
 * Firefox fails if revoked during download.
 * Firefox cannot use saveAs in a popup, so the background script handles it.
 * Chrome ignores the filename option for blob URLs, so normal exports use an
 * anchor with a download attribute; save-as still goes through the API.
 * @param {string | Uint8Array} data
 * @param {string} name
 * @param {{ ext: string, mimeType: string }} format
 * @param {boolean} saveAs
 */
export default async function saveToFile(
  data,
  name,
  { ext, mimeType },
  saveAs = false,
) {
  const blob = new Blob([data], { type: mimeType });
  const filename = name + ext;
  const url = URL.createObjectURL(blob);
  let id;
  let cleanedUp = false;
  let cleanupTimer;
  let anchorCheckTimer;
  let onCreated;

  /** @param {chrome.downloads.DownloadDelta} delta  */
  const onChange = (delta) => {
    if (delta.id === id && delta.state?.current !== 'in_progress') {
      cleanup();
    }
  };

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (cleanupTimer) clearTimeout(cleanupTimer);
    if (anchorCheckTimer) clearTimeout(anchorCheckTimer);
    pendingFileNames.delete(url);
    if (onCreated) {
      chrome.downloads?.onCreated?.removeListener(onCreated);
    }
    chrome.downloads.onChanged.removeListener(onChange);
    URL.revokeObjectURL(url);
  };

  /**
   * A very small anchor download can finish before onCreated/onChanged
   * listeners are attached. Search once after the download is indexed; if it
   * is already finished, revoke immediately instead of waiting for the
   * fallback timer.
   */
  const checkAnchorDownloadState = async () => {
    if (cleanedUp) return;
    try {
      if (typeof chrome.downloads?.search !== 'function') return;
      const items = await chrome.downloads.search({});
      const item = items.find((candidate) => candidate.url === url);
      if (item && item.state !== 'in_progress') cleanup();
    } catch {
      // The event listener or fallback timer still covers cleanup.
    }
  };

  if (canUseAnchorDownload(saveAs)) {
    if (typeof chrome.downloads?.onCreated?.addListener === 'function') {
      onCreated = (item) => {
        if (item.url !== url) return;
        id = item.id;
        chrome.downloads.onCreated.removeListener(onCreated);
        onCreated = null;
        chrome.downloads.onChanged.addListener(onChange);
      };
      chrome.downloads.onCreated.addListener(onCreated);
    }

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    if (!cleanedUp) {
      cleanupTimer = setTimeout(cleanup, CLEANUP_TIMEOUT_MS);
      anchorCheckTimer = setTimeout(() => {
        anchorCheckTimer = null;
        void checkAnchorDownloadState();
      }, ANCHOR_CHECK_DELAY_MS);
    }
    return;
  }

  try {
    ensureFilenameListener();
    if (filenameListenerRegistered) pendingFileNames.set(url, filename);
    id = await chrome.downloads.download({ url, filename, saveAs });
  } catch (error) {
    cleanup();
    throw error;
  }

  chrome.downloads.onChanged.addListener(onChange);

  // A tiny file can finish before the listener is attached. Check the current
  // state once so the object URL is not leaked in that race. `search()` can
  // briefly return an empty array while the download is still being indexed;
  // an empty result is not proof of completion, so keep the listener and rely
  // on the fallback timer instead of revoking immediately.
  try {
    const [item] = await chrome.downloads.search({ id });
    if (item && item.state !== 'in_progress') cleanup();
  } catch {
    // The event listener is still the fallback if search is unavailable.
  }

  if (!cleanedUp) {
    cleanupTimer = setTimeout(cleanup, CLEANUP_TIMEOUT_MS);
  }
}
