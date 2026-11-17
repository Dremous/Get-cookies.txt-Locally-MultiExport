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
  const id = await chrome.downloads.download({ url, filename, saveAs });

  /** @param {chrome.downloads.DownloadDelta} delta  */
  const onChange = (delta) => {
    if (delta.id === id && delta.state?.current !== 'in_progress') {
      chrome.downloads.onChanged.removeListener(onChange);
      URL.revokeObjectURL(url);
    }
  };

  chrome.downloads.onChanged.addListener(onChange);
}
