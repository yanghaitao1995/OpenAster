// SPDX-License-Identifier: Apache-2.0

/** Native operations share one gate. Once disk work starts, quitting waits for
 * its completion; a late picker response never starts new work after quit. */
export function createDesktopLifecycle({ closeService, relaunch, quit, reportError, prepareTransition }) {
  let pending, quitPromise, quitting = false, restarted = false, exited = false;
  const exitOnce = () => { if (!exited) { exited = true; quit(); } };
  const beginQuit = () => { quitting = true; pending?.controller.abort(); };
  return {
    get busy() { return Boolean(pending); },
    get quitting() { return quitting; },
    run(operation, work) {
      if (pending || quitting || restarted || exited) return Promise.resolve(false);
      let stopped = false;
      const controller = new AbortController();
      const context = {
        get active() { return !quitting && !controller.signal.aborted; },
        signal: controller.signal,
        async stopService() {
          if (!context.active) return false;
          let lease, admitted = false;
          try {
            lease = await prepareTransition?.({ signal: controller.signal });
            if (!context.active) return false;
            admitted = true;
            await closeService({ ifIdle: true }); stopped = true;
            return context.active;
          } catch (error) {
            if (admitted && error.code !== 'WORKSPACE_BUSY') stopped = true;
            throw error;
          } finally {
            if (!stopped && await lease?.release() === false) {
              throw Object.assign(new Error('尚未确认页面已解除离开锁定。服务未关闭；请保留未保存内容，退出后重新打开应用。'), { code: 'NATIVE_LEAVE_RELEASE_FAILED' });
            }
          }
        },
      };
      // Assign before entering any callback, including synchronously resolved
      // dialogs. Duplicate native menu activation must observe the same lock.
      const current = Promise.resolve().then(async () => {
        try { return await work(context); }
        catch (error) {
          if (!quitting && !controller.signal.aborted) await reportError(error, { operation, restartRequired: stopped, signal: controller.signal });
          return false;
        } finally {
          if (stopped && !quitting && !restarted) {
            restarted = true;
            try { await relaunch(); }
            finally { exitOnce(); }
          }
        }
      });
      pending = { promise: current, controller };
      // Handle cleanup on both outcomes without an unobserved rejected finally.
      void current.then(() => { if (pending?.promise === current) pending = undefined; }, () => { if (pending?.promise === current) pending = undefined; });
      return current;
    },
    beginQuit,
    cancelQuit() {
      if (quitPromise || restarted || exited) return false;
      quitting = false;
      return true;
    },
    requestQuit() {
      if (quitPromise) return quitPromise;
      beginQuit();
      const active = pending?.promise;
      quitPromise = (async () => {
        try {
          try { await active; } catch { /* disk work already settled; still close */ }
          await closeService();
        } finally { exitOnce(); }
      })();
      return quitPromise;
    },
  };
}
