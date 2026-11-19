import { base64ToBytes } from './base64.mjs';

/**
 * Build the background-page message listener used by Firefox.
 *
 * The listener itself must stay synchronous so `return true` keeps the
 * message channel open. The save work runs in an async IIFE and reports
 * success/failure through `sendResponse`.
 *
 * @param {{ saveFile: (data: string | Uint8Array, name: string, format: { ext: string, mimeType: string }, saveAs: boolean) => Promise<void> }} options
 * @returns {(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean}
 */
export const createSaveMessageListener = ({ saveFile }) => {
  if (typeof saveFile !== 'function') {
    throw new TypeError('createSaveMessageListener requires saveFile');
  }

  return (message, _sender, sendResponse) => {
    const { type, target, data } = message || {};
    if (target !== 'background' || type !== 'save') return false;

    const { text, base64, name, format, saveAs } = data || {};
    const hasText = typeof text === 'string';
    const hasBase64 = typeof base64 === 'string';

    if (!hasText && !hasBase64) {
      sendResponse({ ok: false, error: 'Missing save payload' });
      return false;
    }

    const respond = (response) => {
      try {
        sendResponse?.(response);
      } catch {
        // The popup may have closed before the response was delivered.
      }
    };

    let content;
    try {
      content = hasText ? text : base64ToBytes(base64);
    } catch (error) {
      respond({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    (async () => {
      try {
        await saveFile(content, name, format, Boolean(saveAs));
        respond({ ok: true });
      } catch (error) {
        respond({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return true;
  };
};
