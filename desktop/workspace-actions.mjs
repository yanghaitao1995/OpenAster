// SPDX-License-Identifier: Apache-2.0
import { createWorkspaceSwitcher } from './workspace-switch.mjs';

/** Main-process-only actions. The renderer receives no filesystem privileges. */
export function createWorkspaceActions({ profiles, activeProfile, lifecycle, dialogs, validateWorkspace, backupIdentity, runJob, openDirectory, copyPath }) {
  return {
    createProject() {
      return lifecycle.run('create', async context => {
        const location = await dialogs.chooseProjectLocation();
        if (!location || !context.active) return false;
        const candidate = await profiles.prepareProject(location);
        if (!context.active || !await dialogs.confirmCreateProject(candidate, context.signal) || !context.active) return false;
        if (!await context.stopService()) return false;
        return profiles.createProject(candidate);
      });
    },
    showCurrentDirectory({ copy = false } = {}) {
      return lifecycle.run('location', async context => {
        const selected = await profiles.getActive();
        if (selected.id !== activeProfile.id) throw Object.assign(new Error('当前工作区选择已改变，请重新打开应用后检查。'), { code: 'WORKSPACE_IDENTITY_CHANGED' });
        await validateWorkspace(selected);
        if (!context.active) return false;
        if (copy) await copyPath(selected.workspace);
        else await openDirectory(selected.workspace);
        return true;
      });
    },
    chooseWorkspace(id) {
      return lifecycle.run('switch', async context => {
        let target;
        if (id) {
          target = (await profiles.list()).find(item => item.id === id);
          if (!target || !context.active) return false;
          if (target.kind === 'external') target = await profiles.inspect(target.workspace);
        } else {
          const directory = await dialogs.chooseDirectory();
          if (!directory || !context.active) return false;
          target = await profiles.inspect(directory);
        }
        if (!context.active) return false;
        await validateWorkspace(target);
        if (!context.active) return false;
        const switcher = createWorkspaceSwitcher({ profiles, currentId: activeProfile.id,
          canContinue: () => context.active,
          confirm: target => dialogs.confirmSwitch(target, context.signal),
          ...(typeof dialogs.retrySwitch === 'function' ? { retryBusy: async (target, error) => {
            if (!context.active || await dialogs.retrySwitch(target, error, context.signal) !== true || !context.active) return false;
            // Revalidate the originally selected identity, never adopt a
            // replacement directory or silently choose another target.
            await validateWorkspace(target);
            return context.active;
          } } : {}),
          closeService: () => context.stopService(), restart: async () => {},
          reportError: async error => { throw error; },
        });
        return switcher.switchTo(target);
      });
    },
    backup() {
      return lifecycle.run('backup', async context => {
        const output = await dialogs.chooseBackupOutput();
        if (!output || !context.active) return false;
        if (!await dialogs.confirmBackup(activeProfile, output, context.signal) || !context.active) return false;
        if (!await context.stopService()) return false;
        const result = await runJob('backup', {
          dataDir: activeProfile.dataDir, workspace: activeProfile.workspace, output,
          expectedWorkspaceIdentity: backupIdentity.workspace,
          expectedDataIdentity: backupIdentity.data,
          denySensitivePaths: activeProfile.kind === 'external',
        });
        if (context.active) await dialogs.backupDone(result, context.signal);
        return result;
      });
    },
    restore() {
      return lifecycle.run('restore', async context => {
        const input = await dialogs.chooseRestoreInput();
        if (!input || !context.active) return false;
        if (!await dialogs.confirmRestore(input, context.signal) || !context.active) return false;
        if (!await context.stopService()) return false;
        const restored = await profiles.createRestored({ restore: ({ dataDir }) => runJob('restore', { input, dataDir }) });
        if (context.active) await dialogs.restoreDone(restored, context.signal);
        return restored;
      });
    },
  };
}
