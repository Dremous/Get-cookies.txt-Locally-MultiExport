import { base64ToBytes } from './base64.mjs';

/**
 * Accept only messages sent from an extension page in this extension.
 * Content-script and externally_connectable senders have a web URL, so they
 * fail the extension-URL prefix check even when their `sender.id` is present.
 * @param {unknown} sender
 * @returns {boolean}
 */
const isExtensionSender = (sender) => {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.id) return false;
  if (!sender || typeof sender !== 'object') return false;
  if (sender.id !== runtime.id) return false;
  if (typeof sender.url !== 'string') return false;
  try {
    return sender.url.startsWith(runtime.getURL(''));
  } catch {
    return false;
  }
};

/**
 * Build the background-page message listener used by Firefox.
 *
 * The listener itself must stay synchronous so `return true` keeps the
 * message channel open. The save work runs in an async IIFE and reports
 * success/failure through `sendResponse`.
 *
 * @param {{
 *   saveFile: (data: string | Uint8Array, name: string, format: { ext: string, mimeType: string }, saveAs: boolean) => Promise<void>,
 *   timeoutMs?: number,
 *   saveAsTimeoutMs?: number,
 *   setTimeoutFn?: (callback: () => void, delay: number) => unknown,
 *   clearTimeoutFn?: (timer: unknown) => void,
 *   isTrustedSender?: (sender: unknown) => boolean,
 * }} options
 * @returns {(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean}
 */
export const createSaveMessageListener = ({
  saveFile,
  timeoutMs = 60_000,
  saveAsTimeoutMs = 5 * 60_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  isTrustedSender = isExtensionSender,
}) => {
  if (typeof saveFile !== 'function') {
    throw new TypeError('createSaveMessageListener requires saveFile');
  }
  if (typeof isTrustedSender !== 'function') {
    throw new TypeError('createSaveMessageListener requires isTrustedSender');
  }

  const withTimeout = (promise, timeout, message = 'Save timed out') => {
    if (!Number.isFinite(timeout) || timeout <= 0) return promise;

    return new Promise((resolve, reject) => {
      const timer = setTimeoutFn(() => reject(new Error(message)), timeout);
      promise.then(
        (value) => {
          clearTimeoutFn(timer);
          resolve(value);
        },
        (error) => {
          clearTimeoutFn(timer);
          reject(error);
        },
      );
    });
  };

  return (message, sender, sendResponse) => {
    if (!isTrustedSender(sender)) return false;
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
      if (responded) return;
      responded = true;
      try {
        sendResponse?.(response);
      } catch {
        // The popup may have closed before the response was delivered.
      }
    };

    let responded = false;
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
        const save = Promise.resolve().then(() =>
          saveFile(content, name, format, Boolean(saveAs)),
        );
        const timeout = saveAs ? saveAsTimeoutMs : timeoutMs;
        const timeoutMessage = saveAs
          ? 'Save timed out; the download may still complete in the background.'
          : 'Save timed out';
        await withTimeout(save, timeout, timeoutMessage);
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
