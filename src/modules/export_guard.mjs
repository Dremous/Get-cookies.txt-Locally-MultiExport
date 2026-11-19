/**
 * Prevent a second batch export from starting while one is awaiting downloads.
 * The guard is deliberately small and synchronous so tests can cover the
 * re-entrancy path without a DOM.
 */
export const createExportGuard = () => {
  let busy = false;
  return {
    get busy() {
      return busy;
    },
    begin() {
      if (busy) return false;
      busy = true;
      return true;
    },
    end() {
      busy = false;
    },
  };
};
