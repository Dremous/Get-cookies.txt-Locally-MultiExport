/**
 * Run a background API call without letting a rejected promise become an
 * unhandled rejection. Some chrome.* APIs return promises in Manifest V3,
 * while others may throw synchronously when a platform does not expose them.
 *
 * @param {string} label
 * @param {() => unknown | Promise<unknown>} task
 * @param {Pick<Console, 'warn'>} [logger]
 * @returns {void}
 */
export const runBackgroundTask = (label, task, logger = console) => {
  const report = (error) => {
    try {
      logger.warn(`[background] ${label} failed`, error);
    } catch {
      // Logging must never turn into another background failure.
    }
  };

  try {
    Promise.resolve(task()).catch(report);
  } catch (error) {
    report(error);
  }
};
