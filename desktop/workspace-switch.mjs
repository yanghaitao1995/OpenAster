// SPDX-License-Identifier: Apache-2.0

/** Directory switching always ends the process; never rebind a live session. */
export function createWorkspaceSwitcher({ profiles, currentId, confirm, closeService, restart, reportError, retryBusy, canContinue = () => true }) {
  let switching = false;
  return {
    get busy() { return switching; },
    async switchTo(target) {
      if (switching || target.id === currentId || !canContinue()) return false;
      switching = true;
      let stopped = false;
      try {
        if (!await confirm(target) || !canContinue()) return false;
        // Every attempt keeps the atomic busy check. Only an explicit user
        // decision may repeat it; selection and confirmation are not repeated.
        while (!stopped) {
          try {
            if (await closeService({ ifIdle: true }) === false) return false;
            stopped = true;
          } catch (error) {
            if (error.code !== 'WORKSPACE_BUSY') { stopped = true; throw error; }
            if (typeof retryBusy !== 'function') throw error;
            if (!canContinue() || await retryBusy(target, error) !== true || !canContinue()) return false;
          }
        }
        if (!canContinue()) return false;
        await profiles.activate(target.kind === 'external' ? target : target.id);
        return true;
      } catch (error) {
        await reportError(error, { restartRequired: stopped });
        return false;
      } finally {
        // On a registry failure its last committed selection is preserved.
        // Reopen that selection instead of continuing with a stopped service.
        try { if (stopped) await restart(); }
        finally { switching = false; }
      }
    },
  };
}
