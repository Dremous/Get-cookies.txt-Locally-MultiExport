/**
 * Write text to the clipboard through the async Clipboard API.
 * Kept separate from the popup button state so the failure path is testable.
 * @param {string} text
 * @param {{ writeText?: (value: string) => Promise<void> } | undefined} clipboard
 */
export const writeClipboard = async (
  text,
  clipboard = globalThis.navigator?.clipboard,
) => {
  if (typeof clipboard?.writeText !== 'function') {
    throw new Error('Clipboard API unavailable');
  }
  await clipboard.writeText(text);
};
