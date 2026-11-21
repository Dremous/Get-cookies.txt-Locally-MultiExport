const DEFAULT_FEEDBACK_MS = 2000;

/**
 * Keep the transient "Copied!" state on only one button at a time.
 * @param {{
 *   setTimer?: (callback: () => void, delay: number) => unknown,
 *   clearTimer?: (timer: unknown) => void,
 *   delay?: number,
 * }} [options]
 */
export const createCopyFeedback = ({
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  delay = DEFAULT_FEEDBACK_MS,
} = {}) => {
  let resetTimer;
  /** @type {{ classList: { remove: (className: string) => void } } | null} */
  let activeButton = null;

  /**
   * @param {{ classList: { add: (className: string) => void, remove: (className: string) => void } } | null} button
   */
  const show = (button) => {
    if (!button) return;

    if (resetTimer) {
      clearTimer(resetTimer);
      resetTimer = undefined;
    }
    if (activeButton && activeButton !== button) {
      activeButton.classList.remove('copied');
    }

    activeButton = button;
    button.classList.add('copied');
    resetTimer = setTimer(() => {
      button.classList.remove('copied');
      if (activeButton === button) activeButton = null;
      resetTimer = undefined;
    }, delay);
  };

  const dispose = () => {
    if (resetTimer) {
      clearTimer(resetTimer);
      resetTimer = undefined;
    }
    if (activeButton) {
      activeButton.classList.remove('copied');
      activeButton = null;
    }
  };

  return { show, dispose };
};
