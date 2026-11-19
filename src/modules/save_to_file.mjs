/**
 * Save text or binary data as a file.
 * Firefox fails if revoked during download.
 * Firefox cannot use saveAs in a popup, so the background script handles it.
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

  /** @param {chrome.downloads.DownloadDelta} delta  */
  const onChange = (delta) => {
    if (delta.id === id && delta.state?.current !== 'in_progress') {
      cleanup();
    }
  };

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    chrome.downloads.onChanged.removeListener(onChange);
    URL.revokeObjectURL(url);
  };

  try {
    id = await chrome.downloads.download({ url, filename, saveAs });
  } catch (error) {
    cleanup();
    throw error;
  }

  chrome.downloads.onChanged.addListener(onChange);

  // A tiny file can finish before the listener is attached. Check the current
  // state once so the object URL is not leaked in that race.
  try {
    const [item] = await chrome.downloads.search({ id });
    if (!item || item.state !== 'in_progress') cleanup();
  } catch {
    // The event listener is still the fallback if search is unavailable.
  }
}
