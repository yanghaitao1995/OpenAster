// SPDX-License-Identifier: Apache-2.0
import { app, BrowserWindow, Menu, dialog, safeStorage, session, shell, clipboard } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFile, copyFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { startServer } from '../server/index.mjs';
import { createWorkspaceManager } from '../server/workspace-manager.mjs';
import { createSecretStore } from './secret-store.mjs';
import { createDesktopDraftRepository } from './composer-drafts.mjs';
import { createWorkspaceProfiles, initializeProfileWorkspace } from './workspace-profiles.mjs';
import { describeWorkspaceFailure } from './workspace-errors.mjs';
import { createDesktopLifecycle } from './lifecycle.mjs';
import { createNativeLeaveGuard, createDeferredNativeQuit } from './native-leave.mjs';
import { createWorkspaceActions } from './workspace-actions.mjs';
import { createWorkspaceNavigation } from './workspace-navigation.mjs';
import { runBackupJob } from './backup-worker-client.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { openRelaunchSmokeState } from './relaunch-smoke-state.mjs';
import { createRelaunchSmokeScenario } from './relaunch-smoke.mjs';
import { createSmokeController, createSmokeStageDiagnostic } from './smoke-diagnostics.mjs';
import { createSmokeReadiness } from './smoke-readiness.mjs';

app.setName('OpenAster');
app.enableSandbox();
const smokeMode = process.argv.includes('--smoke-test');
const relaunchSmokeMode = smokeMode && process.argv.includes('--relaunch-smoke-test');
const backupSmokeMode = smokeMode && (process.argv.includes('--backup-smoke-test') || relaunchSmokeMode);
let relaunchSmokeState;
let relaunchScenario;
let smokeTransitioning = false;
let smokeBackupOutput = null;
const smokeLifecycleEvents = [];
let smokeCheckStage = 'page';
let lastMenuAction;
let smokeDirectory;
let smokeTimer;
let smokeReadiness;
if (smokeMode) {
  let guardStage = 'configuration';
  try {
    const requested = process.env.OPENASTER_SMOKE_DATA_DIR;
    const owner = process.env.OPENASTER_SMOKE_OWNER;
    if (!requested || !path.isAbsolute(requested) || !owner || !/^[a-f0-9]{64}$/.test(owner)) throw new Error();
    guardStage = 'requested-canonical';
    // Match fs.promises.realpath in the smoke runners, including Windows 8.3 aliases.
    smokeDirectory = realpathSync.native(requested);
    guardStage = 'temporary-root';
    const temporaryRoot = realpathSync.native(tmpdir());
    guardStage = 'temporary-child';
    const relative = path.relative(temporaryRoot, smokeDirectory);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !/^openaster-smoke-[a-zA-Z0-9]+$/.test(relative)) throw new Error();
    guardStage = 'root-directory';
    if (lstatSync(requested).isSymbolicLink() || !lstatSync(smokeDirectory).isDirectory()) throw new Error();
    if (relaunchSmokeMode) {
      guardStage = 'relaunch-arguments';
      const stages = process.argv.filter(value => value.startsWith('--smoke-phase='));
      if (stages.length !== 1 || !/^--smoke-phase=[0-4]$/.test(stages[0])) throw new Error();
      guardStage = 'relaunch-state';
      relaunchSmokeState = openRelaunchSmokeState({ directory: smokeDirectory, owner, phase: Number(stages[0].slice(-1)) });
    } else {
      guardStage = 'fresh-directory';
      if (readdirSync(smokeDirectory).some(name => name !== '.smoke-owner')) throw new Error();
    }
    guardStage = 'owner-marker';
    if (readFileSync(path.join(smokeDirectory, '.smoke-owner'), 'utf8') !== owner) throw new Error();
    guardStage = 'user-data-path';
    app.setPath('userData', backupSmokeMode ? path.join(smokeDirectory, 'data') : smokeDirectory);
    guardStage = 'session-data-path';
    app.setPath('sessionData', path.join(smokeDirectory, 'chromium'));
  } catch (error) {
    const suppliedCode = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
    const allowedCodes = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP', 'EINVAL', 'EBUSY', 'EIO',
      'RELAUNCH_SMOKE_INVALID', 'RELAUNCH_SMOKE_CHANGED', 'RELAUNCH_SMOKE_UNSAFE', 'RELAUNCH_SMOKE_OWNER',
      'RELAUNCH_SMOKE_EXISTS', 'RELAUNCH_SMOKE_INCOMPLETE', 'RELAUNCH_SMOKE_FINISHED',
      'RELAUNCH_SMOKE_PREVIOUS_ALIVE', 'RELAUNCH_SMOKE_PROCESS_UNKNOWN']);
    console.error(`OPENASTER_SMOKE_GUARD_FAILURE ${JSON.stringify({ version: 1, stage: guardStage, code: allowedCodes.has(suppliedCode) ? suppliedCode : 'SMOKE_GUARD_REJECTED' })}`);
    console.error('Smoke test requires a fresh, owned temporary directory. Use scripts/desktop-smoke.mjs.');
    app.exit(2);
  }
}
let service;
let window;
let closing = false;
let profiles;
let activeProfile;
let lifecycle;
let workspaceActions;
let exitAllowed = false;
let leaveNotice;
const nativeLeave = createNativeLeaveGuard({ getWindow: () => window });
const resumeQuit = createDeferredNativeQuit(() => { exitAllowed = true; app.quit(); });
const smokeController = smokeMode ? createSmokeController({
  phase: relaunchSmokeState?.phase ?? 0,
  record: result => { if (relaunchSmokeMode && relaunchSmokeState) relaunchSmokeState.finish(result); },
  close: async () => { smokeReadiness?.beginClosing(); await service?.close(); smokeReadiness?.dispose(); },
  output: result => console.log(`OPENASTER_SMOKE_RESULT ${JSON.stringify(result)}`),
  exit: code => app.exit(code),
  recordFailure: () => console.error('Unable to persist the bounded relaunch smoke result.'),
}) : null;

const appRoots = [app.isPackaged ? path.dirname(process.execPath) : fileURLToPath(new URL('../', import.meta.url))];
const menuLabel = value => String(value).replaceAll('&', '&&');
const messageBox = options => window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
const externalOptions = profile => ({
  createRoot: false, expectedIdentity: profile.identity,
  protectedRoots: [app.getPath('userData'), ...appRoots], denySensitivePaths: true, projectScan: true,
});
const workspaceOptions = profile => profile.kind === 'external' ? externalOptions(profile)
  : profile.kind === 'restored' ? { createRoot: false, expectedIdentity: profile.identity } : undefined;
const validateWorkspace = async profile => {
  if (profile.kind !== 'default') await createWorkspace(profile.workspace, workspaceOptions(profile)).getIdentity();
};
const runMenuAction = (name, action) => {
  const result = smokeMode ? smokeController.runMenu(name, action)
    : action().catch(() => { console.error('OpenAster native operation did not finish cleanly.'); return false; });
  if (backupSmokeMode) lastMenuAction = result;
  return result;
};

async function showWorkspaceError(error, { restartRequired = false, signal } = {}) {
  if (await showNativeLeaveError(error, signal)) return;
  const failure = describeWorkspaceFailure(error, { operation: 'switch', restartRequired });
  if (failure) {
    await messageBox({ type: 'warning', ...failure, buttons: ['知道了'], signal });
    return;
  }
  const known = error.code === 'WORKSPACE_BUSY' ? '当前工作区仍有操作未结束。请稍后重试；如需处理任务，请返回工作区。'
    : '无法打开该工作区。目录可能已移动、被替换，或属于不允许访问的位置。请重新选择独立的项目文件夹。';
  await messageBox({ type: 'warning', title: '工作区未切换', message: known,
    detail: restartRequired ? '应用将重新打开上次保存的工作区。原目录中的任务和文件不会被搬移。' : '', buttons: ['知道了'], signal });
}

async function openPath(options) {
  const result = await (window && !window.isDestroyed() ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
  return !result.canceled && result.filePaths.length === 1 ? result.filePaths[0] : null;
}
const confirmed = async options => (await messageBox({ type: 'question', buttons: ['继续', '取消'], defaultId: 1, cancelId: 1, noLink: true, ...options })).response === 0;

async function showNativeLeaveError(error, signal) {
  if (!['NATIVE_LEAVE_PENDING', 'NATIVE_LEAVE_DRAFTS_PENDING', 'NATIVE_LEAVE_UNKNOWN', 'NATIVE_LEAVE_RELEASE_FAILED'].includes(error?.code)) return false;
  await messageBox({ type: 'warning', title: error.code === 'NATIVE_LEAVE_RELEASE_FAILED' ? '页面尚未确认解除锁定' : '请先处理未保存的内容', message: error.message, buttons: ['知道了'], signal });
  return true;
}

async function showOperationError(error, options) {
  if (await showNativeLeaveError(error, options.signal)) return;
  if (options.operation === 'switch') return showWorkspaceError(error, options);
  if (options.operation === 'location') {
    await messageBox({ type: 'warning', title: '无法显示当前项目位置', message: '当前目录无法确认或打开。请检查目录是否存在、是否被移动，以及当前工作区状态。', buttons: ['知道了'], signal: options.signal });
    return;
  }
  if (options.operation === 'create') {
    const failure = describeWorkspaceFailure(error, { operation: 'switch', restartRequired: options.restartRequired });
    const messages = {
      WORKSPACE_PROJECT_EXISTS: '此位置已经存在。请输入新的项目文件夹名称；已有文件和目录不会被覆盖。',
      WORKSPACE_PROJECT_NAME: '请输入有效的新项目文件夹名称（不需要文件扩展名）。',
      WORKSPACE_INVALID_PATH: '请选择有效的本机父目录，并输入新的项目文件夹名称。',
      WORKSPACE_PROTECTED_PATH: '项目文件夹不能包含应用数据、安装文件，或使用受保护的位置。',
      WORKSPACE_PROFILE_LIMIT: '已达到 100 个工作区的注册上限，本次没有创建项目。',
      WORKSPACE_BUSY: '当前工作区仍有操作未结束，本次没有创建项目。请返回工作区处理后再试。',
      WORKSPACE_PROJECT_RETAINED: '项目未能完成注册，无法安全清理的目录已保留，请检查其中的内容。',
      WORKSPACE_IDENTITY_CHANGED: '选择后目录身份发生变化，请重新选择新项目位置。',
    };
    await messageBox({ type: 'warning', title: '新建项目未完成', message: failure?.message ?? messages[error.code] ?? '无法创建项目。请检查目录访问权限、磁盘空间和工作区状态。',
      detail: [error.projectPath ? '新项目目录已保留，请检查：\n' + error.projectPath : '', failure?.detail ?? '',
        options.restartRequired ? '应用将重新打开已保存的工作区。' : ''].filter(Boolean).join('\n\n'), buttons: ['知道了'], signal: options.signal });
    return;
  }
  const failure = describeWorkspaceFailure(error, { operation: options.operation === 'restore' ? 'restore' : 'switch', restartRequired: options.restartRequired });
  const title = failure?.title ?? (options.operation === 'backup' ? '备份未完成' : '恢复未完成');
  const known = {
    WORKSPACE_BUSY: `当前工作区仍有操作未结束，本次${options.operation === 'backup' ? '备份' : '恢复'}尚未开始。请稍后重试。`,
    BACKUP_EXISTS: '目标文件已存在。请选择新的文件名；已有备份不会被覆盖。',
    SOURCE_CHANGED: '源目录或文件发生变化，未能完成一致的备份。',
    UNSAFE_BACKUP_PATH: '备份包含不支持的链接或特殊文件。请检查源文件。',
    SENSITIVE_PATH: '工作区包含禁止备份的敏感路径，整次备份已拒绝。',
    UNSUPPORTED_BACKUP_FILE: '此备份格式只接受 UTF-8 文本；工作区含二进制或不支持编码的文件。整次备份已拒绝。',
    BACKUP_LIMIT: '任务或文件超过此备份格式的容量限制，整次操作已拒绝。',
  };
  const detail = [error.orphanPath ? error.partialRestore
    ? `以下位置可能留有未完成的恢复数据，请保留现场并核查：\n${error.orphanPath}\n此位置尚未确认为完整、可打开的工作区。`
    : `恢复数据已保留在：\n${error.orphanPath}\n请保留此目录；它尚未确认关联到工作区。` : '',
    failure?.detail ?? (options.restartRequired ? '应用将重新打开已保存的工作区。' : ''),
    !failure && Object.hasOwn(known, error.code) ? `诊断代码：${error.code}` : '',
  ].filter(Boolean).join('\n\n');
  await messageBox({ type: 'warning', title, message: failure?.message ?? known[error.code] ?? '操作未完成。请检查备份格式、文件范围、目录权限和可用磁盘空间。', detail, buttons: ['知道了'], signal: options.signal });
}

function nativeDialogs() {
  return {
    async chooseProjectLocation() {
      const options = { title: '新建项目 — 输入新项目文件夹名称', buttonLabel: '选择新项目位置', nameFieldLabel: '项目文件夹名称：',
        defaultPath: path.join(app.getPath('documents'), '新项目'), properties: ['dontAddToRecent'] };
      const result = await (window && !window.isDestroyed() ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options));
      return !result.canceled && result.filePath ? result.filePath : null;
    },
    confirmCreateProject: (target, signal) => confirmed({ title: '新建项目', message: '创建此项目文件夹并打开？',
      detail: target.workspace + '\n\n这里只会新建文件夹，不会覆盖已有路径；不需要文件扩展名。项目使用独立的任务和模型连接，现有记录不会搬移。应用将重新打开。请先处理未保存内容；已保存的草稿保留在原工作区。',
      buttons: ['创建并打开项目', '取消'], signal }),
    chooseDirectory: () => openPath({ title: '打开工作区', buttonLabel: '选择文件夹', properties: ['openDirectory', 'dontAddToRecent'] }),
    chooseRestoreInput: () => openPath({ title: '恢复 OpenAster 备份', buttonLabel: '选择备份', properties: ['openFile', 'dontAddToRecent'], filters: [{ name: 'OpenAster JSON 备份', extensions: ['json'] }] }),
    async chooseBackupOutput() {
      const options = { title: '备份当前工作区', buttonLabel: '选择新文件',
        defaultPath: path.join(app.getPath('documents'), `openaster-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
        filters: [{ name: 'OpenAster JSON 备份', extensions: ['json'] }], properties: ['showOverwriteConfirmation', 'dontAddToRecent'] };
      const result = await (window && !window.isDestroyed() ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options));
      return !result.canceled && result.filePath ? result.filePath : null;
    },
    confirmSwitch: (target, signal) => confirmed({ title: '切换工作区', message: `打开“${target.label ?? path.basename(target.workspace)}”？`,
      detail: `${target.workspace}\n\n每个工作区保存独立的任务和模型连接。现有记录和密钥不会搬移。应用将重新打开。未保存的输入可能丢失；已保存的草稿保留在原工作区。\n\n文件工具可读取目录内的普通文本。${target.kind === 'external' ? '常见凭据文件会被排除，其他文本仍可能包含秘密，请先核对。' : ''}使用远程模型时，读取内容会发往该服务商。文件写入仍需逐项批准。`,
      buttons: ['切换工作区', '取消'], signal }),
    retrySwitch: (target, _error, signal) => confirmed({ type: 'warning', title: '工作区未切换',
      message: '当前工作区仍有操作未结束，请稍后重试。',
      detail: `目标文件夹：${target.workspace}\n\n原工作区仍保持打开，尚未发送的输入仍保留。如需处理任务，请取消后返回工作区。\n\n重试成功后应用会重新打开。未保存的输入可能丢失；已保存的草稿保留在原工作区。`,
      buttons: ['重试切换', '取消'], defaultId: 1, cancelId: 1, signal }),
    confirmBackup: (profile, output, signal) => confirmed({ title: '备份当前工作区', message: `备份“${profile.label}”？`,
      detail: `文件目录：${profile.workspace}\n备份文件：${output}\n\n备份包含任务、运行历史、工具结果和支持的工作区文本，以明文保存；模型密钥不包含在内。二进制文件、敏感路径或超过限制的内容会使整次备份失败，不会静默略过。请使用新的文件名。\n\n应用会重新打开当前工作区。未保存的输入可能丢失，已保存的草稿会保留。`,
      buttons: ['备份并重新打开', '取消'], signal }),
    confirmRestore: (input, signal) => confirmed({ title: '恢复备份', message: '恢复到新的独立工作区？',
      detail: `${input}\n\n恢复数据将保存在应用数据目录内的新工作区，原工作区保留。外部模型连接会停用，待审批操作会撤销，未完成的任务不会继续执行。模型密钥需要重新配置。\n\n应用会重新打开恢复后的工作区。未保存的输入可能丢失；已保存的草稿保留在原工作区，不包含在恢复数据中。`,
      buttons: ['恢复并打开', '取消'], signal }),
    backupDone: (result, signal) => messageBox({ type: 'info', title: '备份已保存', message: `已保存 ${result.sessions} 个任务。`,
      detail: `${result.path}\n\n请妥善保管此明文备份。应用即将重新打开。`, buttons: ['重新打开'], signal }),
    restoreDone: ({ profile, result }, signal) => messageBox({ type: 'info', title: '恢复已完成', message: `已恢复 ${result.sessions} 个任务。`,
      detail: `${profile.workspace}\n\n外部模型连接已停用，待审批操作已撤销。应用即将打开此工作区。`, buttons: ['打开工作区'], signal }),
  };
}

async function configureWorkspaceActions() {
  if (relaunchSmokeMode) relaunchScenario = createRelaunchSmokeScenario({ state: relaunchSmokeState, userData: app.getPath('userData'),
    getService: () => service, getProfile: () => activeProfile, getWindow: () => window,
    beforeTransition: () => smokeReadiness.seal(),
    click: async ({ label, workspace }) => {
      const menu = Menu.getApplicationMenu().items.find(item => item.label === '工作区').submenu;
      const item = workspace ? menu.items.find(item => item.label === '最近的工作区').submenu.items.find(item => item.label === menuLabel(workspace))
        : menu.items.find(item => item.label === label);
      if (!item?.enabled) throw new Error('Smoke menu target is unavailable');
      const previous = lastMenuAction; item.click();
      if (!lastMenuAction || lastMenuAction === previous) throw new Error('Smoke menu callback did not start');
      return lastMenuAction;
    },
  });
  lifecycle = createDesktopLifecycle({
    // The owner-validated API-only backup fixture reopens a service without
    // navigating its old renderer; it does not claim transition-guard coverage.
    // Real source/directory/staged relaunch scenarios use the full handshake.
    prepareTransition: backupSmokeMode && !relaunchSmokeMode ? undefined : options => nativeLeave.acquire(options),
    closeService: options => {
    if (backupSmokeMode) smokeReadiness?.beginClosing();
    return service.close(options);
  }, reportError: backupSmokeMode ? async error => {
    // Latch before lifecycle's finally can attempt a relaunch or quit.
    smokeController.capture(error); throw error;
  } : showOperationError,
    relaunch: async () => {
      if (smokeController?.failed) { await finishSmoke(1, { error: 'native-menu-failed' }); return; }
      if (relaunchSmokeMode) {
        await smokeController.relaunch({ select: () => profiles.getActive(),
          prepare: selected => relaunchScenario.beforeRelaunch(selected.id),
          launch: next => {
            const args = [...process.argv.slice(1).filter(value => !value.startsWith('--smoke-phase=')), `--smoke-phase=${next.nextPhase}`];
            smokeTransitioning = true; closing = true; clearTimeout(smokeTimer);
            app.relaunch({ args });
          },
        });
        return;
      }
      if (backupSmokeMode) { smokeLifecycleEvents.push('relaunch'); return; }
      closing = true;
      try { app.relaunch(); }
      catch { dialog.showErrorBox('请重新打开 OpenAster', '应用未能自动重新打开。请手动启动 OpenAster。'); }
    },
    quit: () => {
      if (smokeController?.failed) return; // The failure finisher owns close + exit.
      if (backupSmokeMode && !relaunchSmokeMode) { smokeLifecycleEvents.push('quit'); return; }
      closing = true; resumeQuit();
    },
  });
  const backupIdentity = {
    workspace: await createWorkspace(activeProfile.workspace, { ...workspaceOptions(activeProfile), createRoot: false }).getIdentity(),
    data: await createWorkspace(activeProfile.dataDir, { createRoot: false, expectedIdentity: activeProfile.dataIdentity }).getIdentity(),
  };
  const dialogs = nativeDialogs();
  // Smoke failures must remain bounded diagnostics, never hidden retry dialogs.
  if (backupSmokeMode) dialogs.retrySwitch = async (_target, error) => { throw error; };
  // Deterministic chooser responses exist only in the already owner-validated,
  // fresh temporary smoke environment. Disk jobs and menu callbacks remain real.
  if (relaunchSmokeMode) Object.assign(dialogs, relaunchScenario.dialogs);
  else if (backupSmokeMode) Object.assign(dialogs, {
    chooseBackupOutput: async () => smokeBackupOutput,
    chooseRestoreInput: async () => smokeBackupOutput,
    confirmBackup: async () => true, confirmRestore: async () => true, confirmSwitch: async () => true,
    backupDone: async () => {}, restoreDone: async () => {},
  });
  workspaceActions = createWorkspaceActions({ profiles, activeProfile, lifecycle, dialogs, validateWorkspace, backupIdentity, runJob: runBackupJob,
    openDirectory: async directory => { if (await shell.openPath(directory)) throw Object.assign(new Error('系统未能打开当前项目文件夹。'), { code: 'WORKSPACE_OPEN_FAILED' }); },
    copyPath: directory => clipboard.writeText(directory),
  });
}

async function startProfileService() {
  const skillsDirectory = await initializeProfileWorkspace(activeProfile, workspaceOptions(activeProfile));
  const deviceDraftStore = createDesktopDraftRepository({ directory: path.join(activeProfile.dataDir, 'device-drafts'), crypto: safeStorage });
  const workspaceManager = createWorkspaceManager({ profiles, getCurrent: async () => activeProfile,
    projectsRoot: path.join(app.getPath('home'), 'OpenAster Projects'), homeDirectory: app.getPath('home'),
    protectedRoots: [app.getPath('userData'), ...appRoots],
    transition: commit => workspaceActions.commitPreparedProject(commit),
  });
  try {
    return await startServer({ port: 0, host: '127.0.0.1', dataDir: activeProfile.dataDir,
      workspace: activeProfile.workspace, workspaceId: activeProfile.id, workspaceName: activeProfile.label,
      workspaceOptions: workspaceOptions(activeProfile), deviceDraftStore, skillsDirectory, workspaceManager,
      workspaceActions: {
        open: () => runMenuAction('open-workspace', () => workspaceActions.chooseWorkspace()),
        create: () => runMenuAction('create-project', () => workspaceActions.createProject()),
      },
      secretStore: createSecretStore({ directory: activeProfile.secretsDir, crypto: safeStorage }),
    });
  } catch (error) { await deviceDraftStore.close(); throw error; }
}

async function verifySmokeBackupLifecycle() {
  smokeCheckStage = 'fixture';
  const check = value => { if (!value) throw new Error('Native backup smoke assertion failed'); };
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const toolRecords = values => JSON.stringify(canonical([...values].sort((a, b) => a.id.localeCompare(b.id))));
  const connect = async () => {
    const first = await fetch(service.url + '/api/bootstrap'), bootstrap = await first.json();
    const headers = { cookie: first.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': bootstrap.csrfToken, 'Content-Type': 'application/json' };
    return { bootstrap, request: async (route, body) => {
      const response = await fetch(service.url + route, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
      check(response.ok); return response.json();
    } };
  };
  const click = label => {
    const item = Menu.getApplicationMenu().items.find(item => item.label === '工作区').submenu.items.find(item => item.label === label);
    check(item && item.enabled); const previous = lastMenuAction; item.click();
    check(lastMenuAction && lastMenuAction !== previous); return lastMenuAction;
  };
  const reopen = async () => { activeProfile = await resolveStartupWorkspace(); service = await startProfileService(); await configureWorkspaceActions(); await installWorkspaceMenu(); return connect(); };
  let client = await connect();
  const note = '\ufeff桌面恢复验证🙂\r\n';
  await client.request('/api/workspace/files', { path: 'native-note.txt', content: note });
  const task = (await client.request('/api/sessions', { title: '原生备份恢复验证' })).session;
  const route = `/api/sessions/${task.id}`;
  await client.request(route + '/messages', { content: '查看当前文件，不要写入' });
  let completed;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    completed = (await client.request(route)).session;
    if (completed.run?.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  check(completed.run?.status === 'completed');
  const ref = completed.run.steps.find(step => step.toolResultRef?.name === 'read_file' && step.toolResultRef.path === 'native-note.txt')?.toolResultRef;
  check(ref && ref.isError === false);
  const artifactRoute = `${route}/runs/${completed.run.id}/artifacts/${ref.artifactId}`;
  const originalArtifact = await client.request(artifactRoute);
  check(JSON.parse(originalArtifact.page.content).result.content === note);
  smokeCheckStage = 'handoff';
  check(client.bootstrap.capabilities.conversationHandoff === 1);
  const preview = await client.request(route + '/handoff-preview');
  const handoffRequest = { requestId: randomUUID(), expectedSourceHash: preview.source.hash,
    summary: '\ufeff 已读取文件；原文与工具记录保留在来源任务。\r\n下一步由用户核对。 \r\n',
    content: '根据交接内容继续演示。', providerId: 'demo', skillId: 'general' };
  const created = (await client.request(route + '/continuations', handoffRequest)).session;
  const continuationRoute = `/api/sessions/${created.id}`;
  let continuation;
  const handoffDeadline = Date.now() + 10000;
  while (Date.now() < handoffDeadline) {
    continuation = (await client.request(continuationRoute)).session;
    if (continuation.run?.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  check(continuation?.run?.status === 'completed' && continuation.messages.length === 2 && continuation.approvals.length === 0);
  check(continuation.messages[0].contextHandoff.summary === handoffRequest.summary);
  check(JSON.stringify((await client.request(route)).session) === JSON.stringify(completed));
  const replay = (await client.request(route + '/continuations', handoffRequest)).session;
  check(replay.id === continuation.id && replay.run.id === continuation.run.id);
  const savedHandoff = JSON.stringify(continuation.messages[0].contextHandoff);
  smokeCheckStage = 'summary-draft';
  check(client.bootstrap.capabilities.handoffDraft === 1);
  let summaryCalls = 0, summaryDraft, summaryRequest;
  const summaryText = '\ufeff 模拟摘要：原任务已读取资料，实际文件仍须重新核对。\r\n';
  const summaryFixture = http.createServer(async (req, res) => {
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; check(bytes <= 2 * 1024 * 1024); chunks.push(chunk); }
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      check(req.url === '/v1/chat/completions' && req.method === 'POST' && request.stream !== true && !request.tools);
      const envelope = JSON.parse(request.messages.at(-1).content);
      check(envelope.source.sessionId === task.id && envelope.source_fragment.untrusted_data === true);
      check(JSON.stringify(JSON.parse(envelope.source_fragment.content)) === JSON.stringify(completed.messages));
      summaryCalls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: summaryText } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise((resolve, reject) => { summaryFixture.once('error', reject); summaryFixture.listen(0, '127.0.0.1', resolve); });
  try {
    const provider = (await client.request('/api/providers', { name: '原生摘要验证（本机模拟）', type: 'openai', model: 'smoke-summary', baseUrl: `http://127.0.0.1:${summaryFixture.address().port}/v1`, toolMode: 'workspace', maxTokens: 128 })).provider;
    const plan = await client.request(route + '/summary-preview', { providerId: provider.id, expectedSourceHash: preview.source.hash });
    check(plan.maxRequests === 1 && summaryCalls === 0);
    summaryRequest = { requestId: randomUUID(), providerId: provider.id, expectedSourceHash: plan.source.hash, expectedPlanHash: plan.planHash };
    await client.request(route + '/summary-drafts', summaryRequest);
    const summaryDeadline = Date.now() + 10000;
    while (Date.now() < summaryDeadline) {
      summaryDraft = (await client.request(route + '/summary-drafts/' + summaryRequest.requestId)).draft;
      if (summaryDraft.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    check(summaryDraft.status === 'completed' && summaryDraft.summary === summaryText && summaryDraft.connection.toolMode === 'none');
    check(summaryDraft.steps[0].usage.totalTokens === 5 && summaryCalls === 1);
    check(JSON.stringify((await client.request(route + '/summary-drafts', summaryRequest)).draft) === JSON.stringify(summaryDraft) && summaryCalls === 1);
    check(JSON.stringify((await client.request(route)).session) === JSON.stringify(completed));
  } finally {
    await new Promise(resolve => { summaryFixture.close(resolve); summaryFixture.closeIdleConnections(); });
  }
  const savedSummaryDraft = JSON.stringify(summaryDraft);
  const exportedToolArtifacts = (await client.request('/api/export')).toolArtifacts;
  const savedToolArtifacts = toolRecords(exportedToolArtifacts);
  smokeCheckStage = 'cancel';
  const cancelled = await click('备份当前工作区…'); check(cancelled === false && smokeLifecycleEvents.length === 0);
  check((await client.request(route)).session.id === task.id);
  smokeBackupOutput = path.join(smokeDirectory, 'native-backup.json');
  smokeCheckStage = 'backup';
  // Pause only new renderer/Service Worker requests after the cancellation
  // check. The existing server close still rejects any genuinely active task.
  const rendererReadiness = await smokeReadiness.seal();
  check(rendererReadiness.version === 1 && rendererReadiness.policy === 'pause-new-background-requests-before-transition'
    && rendererReadiness.allAdmittedRequestsSettled === true && rendererReadiness.allStartedHandlersSettled === true
    && Number.isSafeInteger(rendererReadiness.handlersStarted) && rendererReadiness.handlersStarted > 0
    && rendererReadiness.handlersStarted === rendererReadiness.handlersSettled);
  const backup = await click('备份当前工作区…'); check(backup?.sessions === 2 && backup.toolArtifacts === exportedToolArtifacts.length && backup.summaryJobs === 1);
  const archive = JSON.parse(await readFile(smokeBackupOutput, 'utf8'));
  check(archive.format === 'openaster-backup' && archive.version === 9 && Array.isArray(archive.payload.steeringInputs) && archive.payload.steeringInputs.length === 0);
  check(JSON.stringify(archive.payload.sessions.find(item => item.id === continuation.id)?.messages[0]?.contextHandoff) === savedHandoff);
  check(toolRecords(archive.payload.toolArtifacts) === savedToolArtifacts);
  check(JSON.stringify(archive.payload.summaryJobs[0]) === savedSummaryDraft);
  check(smokeLifecycleEvents.join(',') === 'relaunch,quit');
  smokeCheckStage = 'reopen-original';
  client = await reopen(); check(activeProfile.id === 'default' && client.bootstrap.sessions.some(item => item.id === task.id) && client.bootstrap.sessions.some(item => item.id === continuation.id));
  smokeCheckStage = 'restore';
  const restored = await click('恢复备份…'); check(restored?.profile.kind === 'restored');
  smokeCheckStage = 'reopen-restored';
  client = await reopen(); check(activeProfile.id === restored.profile.id && client.bootstrap.sessions.some(item => item.id === task.id) && client.bootstrap.sessions.some(item => item.id === continuation.id));
  const restoredContinuation = (await client.request(continuationRoute)).session;
  check(JSON.stringify(restoredContinuation.messages[0].contextHandoff) === savedHandoff && restoredContinuation.run.id === continuation.run.id);
  check((await client.request(continuationRoute + '/runs')).runs.length === 1);
  check(JSON.stringify((await client.request(route + '/summary-drafts/' + summaryDraft.id)).draft) === savedSummaryDraft);
  check(JSON.stringify((await client.request(route + '/summary-drafts', summaryRequest)).draft) === savedSummaryDraft && summaryCalls === 1);
  check((await client.request('/api/usage')).summary.tokens.totalTokens.knownSum === '5');
  check(JSON.stringify(await client.request(artifactRoute)) === JSON.stringify(originalArtifact));
  check(toolRecords((await client.request('/api/export')).toolArtifacts) === savedToolArtifacts);
  check(await readFile(path.join(activeProfile.workspace, 'native-note.txt'), 'utf8') === note);
  check(await readFile(path.join(app.getPath('userData'), 'workspace', 'native-note.txt'), 'utf8') === note);
  check(smokeLifecycleEvents.join(',') === 'relaunch,quit,relaunch,quit');
  return { realMenuCallbacks: true, chooserResponses: 'injected only in fresh owned smoke directory', cancellationPreservedService: true,
    workerBackup: true, workerRestore: true, restoredProfileReopened: true, tasks: backup.sessions, toolArtifacts: backup.toolArtifacts,
    artifactBytesPreserved: true, originalWorkspacePreserved: true, handoffCreatedViaApi: true, handoffReplayKeptRun: true,
    handoffSnapshotRestored: true, handoffHistoryNotReplayed: true, summaryDraftCreatedViaApi: true, summaryDraftRestored: true,
    summaryDraftReplayKeptRequest: true, summaryDraftUsageRestored: true, summaryFixtureRequests: summaryCalls,
    relaunchRequests: 2, processRelaunchExecuted: false,
    rendererReadiness, transitionReadiness: 'fixture paused new renderer and service worker requests before backup; not naturally idle startup',
    rendererTransitionGuard: false, rendererTransitionGuardReason: 'api-fixture' };
}

async function installWorkspaceMenu() {
  const entries = await profiles.list();
  const navigation = createWorkspaceNavigation({ entries, activeId: activeProfile.id,
    onSelect: id => runMenuAction('switch-recent', () => workspaceActions.chooseWorkspace(id)) });
  const menu = [{ label: '工作区', submenu: [
    { label: '新建项目…', click: () => runMenuAction('create-project', () => workspaceActions.createProject()) },
    { label: '打开文件夹…', accelerator: 'CmdOrCtrl+O', click: () => runMenuAction('open-workspace', () => workspaceActions.chooseWorkspace()) },
    { label: '默认工作区', type: 'checkbox', checked: activeProfile.id === 'default', enabled: activeProfile.id !== 'default', click: () => runMenuAction('switch-default', () => workspaceActions.chooseWorkspace('default')) },
    navigation.recent,
    navigation.all,
    { type: 'separator' },
    { label: menuLabel('当前文件夹：' + activeProfile.workspace), enabled: false },
    { label: '打开当前文件夹', click: () => runMenuAction('reveal-workspace', () => workspaceActions.showCurrentDirectory()) },
    { label: '复制当前路径', click: () => runMenuAction('copy-workspace-path', () => workspaceActions.showCurrentDirectory({ copy: true })) },
    { type: 'separator' },
    { label: '备份当前工作区…', click: () => runMenuAction('backup', () => workspaceActions.backup()) },
    { label: '恢复备份…', click: () => runMenuAction('restore', () => workspaceActions.restore()) },
    { type: 'separator' }, { role: process.platform === 'darwin' ? 'close' : 'quit' },
  ] }, { role: 'editMenu' }, { role: 'windowMenu' }];
  if (process.platform === 'darwin') menu.unshift({ role: 'appMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
}

async function resolveStartupWorkspace() {
  const userData = app.getPath('userData');
  profiles = createWorkspaceProfiles({ userData, appRoots, homeDirectory: app.getPath('home') });
  await profiles.initialize();
  try {
    const profile = await profiles.getActive();
    await validateWorkspace(profile);
    return profile;
  }
  catch (error) {
    if (smokeMode) throw error;
    if (describeWorkspaceFailure(error, { operation: 'startup' })) throw error;
    const result = await dialog.showMessageBox({ type: 'warning', title: '工作区无法打开',
      message: '上次使用的目录已无法验证。',
      detail: '应用不会重建丢失的目录，也不会把原任务关联到其他文件夹。可以返回默认工作区，再重新选择目录。原任务记录仍保留。',
      buttons: ['返回默认工作区', '退出'], defaultId: 1, cancelId: 1, noLink: true });
    if (result.response !== 0) return null;
    return profiles.activate('default');
  }
}

async function finishSmoke(code, result) {
  clearTimeout(smokeTimer);
  if (code !== 0) smokeController.capture(undefined, { reason: result.error });
  return smokeController.finish(code === 0 ? { ...result, ok: true } : undefined);
}

async function verifySmokeSecretStorage() {
  const available = await safeStorage.isAsyncEncryptionAvailable();
  const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : process.platform === 'win32' ? 'DPAPI' : 'Keychain';
  const testDirectory = path.join(smokeDirectory, 'smoke-secrets');
  const vault = createSecretStore({ directory: testDirectory, crypto: safeStorage });
  const value = randomBytes(32).toString('hex');
  const protectedBackend = process.platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend);
  if (!available || !protectedBackend) {
    let rejected = false;
    try { await vault.set('smoke-random', value); } catch { rejected = true; }
    if (!rejected) throw new Error('Unprotected secret storage unexpectedly accepted a write');
    // Headless Linux environments may lack a keyring: verify refusal, without claiming an encryption pass.
    if (process.platform !== 'linux') throw new Error('Expected OS key storage unavailable');
    return { available: false, backend, unprotectedWriteRejected: true, roundTrip: false };
  }
  await vault.set('smoke-random', value);
  const encrypted = await readFile(path.join(testDirectory, 'smoke-random.secret'));
  if (encrypted.includes(Buffer.from(value))) throw new Error('Secret appeared as plaintext on disk');
  if (await vault.get('smoke-random') !== value) throw new Error('OS encryption round trip failed');
  await vault.delete('smoke-random');
  if (await vault.get('smoke-random') !== undefined) throw new Error('Test secret deletion failed');
  return { available: true, backend, roundTrip: true, plaintextAbsent: true, deleted: true };
}

async function verifySmokeDraftStorage(secretStorage) {
  const check = value => { if (!value) throw new Error('Native draft storage smoke assertion failed'); };
  const bootstrapResponse = await fetch(service.url + '/api/bootstrap'), bootstrap = await bootstrapResponse.json();
  const storageId = bootstrap.workspace.storageId, route = service.url + '/api/device-drafts';
  const headers = { cookie: bootstrapResponse.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': bootstrap.csrfToken,
    'Content-Type': 'application/json', 'X-OpenAster-Storage-Id': storageId };
  check(bootstrap.capabilities.deviceDrafts === 1);
  const unauthorized = await fetch(route); check(unauthorized.status === 401); await unauthorized.arrayBuffer();
  const noCsrf = await fetch(route, { method: 'POST', headers: { cookie: headers.cookie, 'Content-Type': 'application/json' }, body: '{}' });
  check(noCsrf.status === 403); await noCsrf.arrayBuffer();
  const foreign = await fetch(route, { headers: { ...headers, 'X-OpenAster-Storage-Id': randomUUID() } });
  check(foreign.status === 409); await foreign.arrayBuffer();
  const initialResponse = await fetch(route, { headers });
  if (!secretStorage.available) {
    check(process.platform === 'linux' && initialResponse.status === 503); await initialResponse.arrayBuffer();
    return { available: false, backend: secretStorage.backend, unprotectedStorageRejected: true, roundTrip: false,
      unauthenticatedRejected: true, csrfRequired: true, foreignStorageRejected: true };
  }
  check(initialResponse.ok);
  const initial = (await initialResponse.json()).snapshot;
  const text = '\ufeff  未发送草稿🙂\r\n' + randomBytes(32).toString('hex') + '中文'.repeat(9000 / 2);
  const drafts = [{ slot: 'new', text, files: [{ path: 'native-draft.txt', sha256: 'a'.repeat(64), bytes: 99 }],
    providerId: 'demo', skillId: 'general', updatedAt: new Date().toISOString(), revision: randomUUID(), uncertain: true }];
  const savedResponse = await fetch(route, { method: 'POST', headers, body: JSON.stringify({ storageId, expectedRevision: initial.revision, drafts }) });
  check(savedResponse.ok); const saved = (await savedResponse.json()).snapshot;
  check(JSON.stringify(saved.drafts) === JSON.stringify(drafts));
  const readResponse = await fetch(route, { headers }); check(readResponse.ok);
  check(JSON.stringify((await readResponse.json()).snapshot) === JSON.stringify(saved));
  const directory = path.join(activeProfile.dataDir, 'device-drafts'), source = path.join(directory, `${storageId}.draft`);
  const encrypted = await readFile(source); check(!encrypted.includes(Buffer.from(text)) && !encrypted.includes(Buffer.from('native-draft.txt')));
  const reopened = createDesktopDraftRepository({ directory, crypto: safeStorage });
  try {
    check(JSON.stringify(await reopened.read(storageId)) === JSON.stringify(saved));
    const otherId = randomUUID(); check((await reopened.read(otherId)).revision === '0');
    await copyFile(source, path.join(directory, `${otherId}.draft`), constants.COPYFILE_EXCL);
    let transplantRejected = false;
    try { await reopened.read(otherId); } catch (error) { transplantRejected = error.code === 'DRAFT_CORRUPT'; }
    check(transplantRejected);
  } finally { await reopened.close(); }
  // Clear only this verified revision; no live user storage is involved.
  const cleared = await fetch(route, { method: 'POST', headers, body: JSON.stringify({ storageId, expectedRevision: saved.revision, drafts: [] }) });
  check(cleared.ok); check((await cleared.json()).snapshot.drafts.length === 0);
  return { available: true, backend: secretStorage.backend, roundTrip: true, plaintextAbsent: true, repositoryRecreated: true,
    authenticatedEndpointRoundTrip: true, unauthenticatedRejected: true, csrfRequired: true, foreignStorageRejected: true,
    transplantedCiphertextRejected: true, clearedWithExactRevision: true, encryptedBytes: encrypted.length };
}

function showWindow() {
  window = new BrowserWindow({
    title: 'OpenAster', width: 1440, height: 960, minWidth: 840, minHeight: 620,
    backgroundColor: '#f7f8fa', show: false, autoHideMenuBar: false,
    icon: fileURLToPath(new URL('./resources/icon.png', import.meta.url)),
    webPreferences: {
      nodeIntegration: false, nodeIntegrationInWorker: false, contextIsolation: true,
      sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, devTools: !app.isPackaged, partition: 'openaster-local',
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, destination) => {
    try {
      if (new URL(destination).origin !== new URL(service.url).origin) event.preventDefault();
    } catch { event.preventDefault(); }
  });
  window.webContents.on('will-prevent-unload', () => {
    // Default Electron behavior keeps the window open; do not authorize unload.
    if (lifecycle?.cancelQuit() !== false) closing = false;
    if (!leaveNotice && !smokeMode) {
      leaveNotice = messageBox({ type: 'warning', title: '窗口仍保持打开',
        message: exitAllowed ? '退出已暂停，请保留未保存内容；本地服务可能已经停止。'
          : '仍有未保存或尚待核对的内容。请返回编辑，保存或明确放弃修改后再关闭。',
        buttons: ['返回编辑'] }).catch(() => {}).finally(() => { leaveNotice = undefined; });
    }
  });
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => { if (!smokeMode) window?.show(); });
  if (smokeMode) {
    smokeTimer = setTimeout(() => { smokeController.capture({ code: 'SMOKE_TIMEOUT' }, { reason: 'timeout' }); void finishSmoke(1, { error: 'timeout' }); }, backupSmokeMode ? 45000 : 20000);
    window.webContents.once('render-process-gone', () => { if (!smokeTransitioning) { smokeController.capture({ code: 'SMOKE_RENDERER_EXITED' }, { action: 'page-check', reason: 'renderer-exited' }); void finishSmoke(1, { error: 'renderer-exited' }); } });
    window.webContents.once('did-finish-load', async () => {
      try {
        smokeCheckStage = 'page';
        const page = await window.webContents.executeJavaScript(`(async () => {
          const started = Date.now();
          while (!document.querySelector('#connection-indicator.connected') && Date.now() - started < 10000) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          return {
            title: document.title,
            requireUnavailable: typeof window.require === 'undefined',
            processUnavailable: typeof window.process === 'undefined',
            connected: Boolean(document.querySelector('#connection-indicator.connected')),
          };
        })()`);
        const preferences = window.webContents.getLastWebPreferences();
        const sandboxed = preferences.sandbox === true && preferences.contextIsolation === true && preferences.nodeIntegration === false;
        smokeCheckStage = 'workspace-menu';
        const workspaceMenu = Menu.getApplicationMenu()?.items.find(item => item.label === '工作区')?.submenu;
        const registered = (await profiles.list()).filter(item => item.kind !== 'default');
        const allMenu = workspaceMenu?.items.find(item => item.id === 'workspace-all');
        const leaves = menu => (menu?.items ?? []).flatMap(item => item.submenu ? leaves(item.submenu) : [item]);
        const allEntries = leaves(allMenu?.submenu);
        const workspaceNavigation = {
          registeredEntries: registered.length, allEntries: allEntries.length,
          allEntriesMatch: Boolean(allMenu && allMenu.label === `全部工作区（${registered.length}）`
            && allEntries.length === registered.length && new Set(allEntries.map(item => item.id)).size === registered.length
            && registered.every(profile => allEntries.some(item => item.id === `workspace-all-${profile.id}`
              && item.label === menuLabel(`${profile.label} — ${profile.workspace}`)
              && item.type === 'checkbox' && item.checked === (profile.id === activeProfile.id) && item.enabled === (profile.id !== activeProfile.id)))),
        };
        const workspaceMenuInstalled = Boolean(workspaceMenu?.items.some(item => item.label === '打开文件夹…' && item.accelerator === 'CmdOrCtrl+O')
          && workspaceMenu.items.some(item => item.label === '默认工作区' && item.checked === (activeProfile.id === 'default')) && workspaceNavigation.allEntriesMatch);
        smokeCheckStage = 'keychain';
        const secretStorage = await verifySmokeSecretStorage();
        smokeCheckStage = 'draft';
        const deviceDraftStorage = !relaunchSmokeMode ? await verifySmokeDraftStorage(secretStorage) : undefined;
        const ok = /OpenAster/.test(page.title) && page.requireUnavailable && page.processUnavailable && page.connected && sandboxed && workspaceMenuInstalled;
        if (relaunchSmokeMode) {
          if (!ok) throw new Error('Smoke startup boundary failed');
          smokeCheckStage = 'relaunch';
          const processRelaunch = await relaunchScenario.run({ ...page, sandboxed, workspaceMenuInstalled, workspaceNavigation, secretStorage });
          if (!processRelaunch.transitioning) await finishSmoke(0, { processRelaunch, sandboxed, secretStorage });
          return;
        }
        const backupLifecycle = backupSmokeMode ? await verifySmokeBackupLifecycle() : undefined;
        if (!ok) smokeController.capturePageError(undefined);
        await finishSmoke(ok ? 0 : 1, { ...page, sandboxed, workspaceMenuInstalled, workspaceNavigation, secretStorage,
          ...(deviceDraftStorage ? { deviceDraftStorage } : {}), ...(backupLifecycle ? { backupLifecycle } : {}) });
      } catch (error) {
        console.error('OPENASTER_SMOKE_STAGE_DIAGNOSTIC ' + JSON.stringify(createSmokeStageDiagnostic(smokeCheckStage)));
        smokeController.capturePageError(error); await finishSmoke(1, { error: 'page-check-failed' });
      }
    });
  }
  window.on('closed', () => { window = undefined; });
  window.loadURL(service.url).catch(() => {
    if (smokeMode) { smokeController.capture({ code: 'SMOKE_PAGE_LOAD_FAILED' }, { action: 'page-check', reason: 'page-load-failed' }); void finishSmoke(1, { error: 'page-load-failed' }); return; }
    dialog.showErrorBox('OpenAster', '无法加载本地工作台。请重启应用并查看本地诊断信息。');
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
  });
  app.whenReady().then(async () => {
    activeProfile = await resolveStartupWorkspace();
    if (!activeProfile) { app.quit(); return; }
    service = await startProfileService();
    await configureWorkspaceActions();
    await installWorkspaceMenu();
    const isolated = session.fromPartition('openaster-local');
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    const allowedOrigin = new URL(service.url).origin;
    if (backupSmokeMode) {
      smokeReadiness = createSmokeReadiness({ server: service.server, origin: allowedOrigin,
        onFailure: error => smokeController.capture(error, { action: 'page-check', reason: 'page-check-failed' }) });
      isolated.webRequest.onResponseStarted(details => smokeReadiness.responseStarted(details));
      isolated.webRequest.onCompleted(details => smokeReadiness.completed(details));
      isolated.webRequest.onErrorOccurred(details => smokeReadiness.errored(details));
    }
    isolated.on('will-download', (event, item, contents) => {
      let trustedExport = false;
      try {
        const url = new URL(item.getURL());
        trustedExport = contents === window?.webContents && url.protocol === 'blob:' && url.origin === allowedOrigin;
      } catch { /* malformed download source */ }
      if (!trustedExport) return event.preventDefault();
      item.setSaveDialogOptions({
        title: '保存 OpenAster 导出',
        defaultPath: path.join(app.getPath('downloads'), 'openaster-export.json'),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
    });
    isolated.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      try { allowed = new URL(details.url).origin === allowedOrigin; } catch { /* deny unknown schemes */ }
      if (!allowed) { callback({ cancel: true }); return; }
      if (smokeReadiness) { smokeReadiness.beforeRequest(details, callback); return; }
      callback({ cancel: false });
    });
    showWindow();
    app.on('activate', () => { if (!window && service && !closing && !lifecycle?.quitting) showWindow(); });
  }).catch(error => {
    // Never print raw error details that could contain provider credentials.
    console.error('OpenAster startup failed.');
    if (smokeMode) { smokeController.capture(error, { action: 'startup', reason: 'startup-failed' }); void finishSmoke(1, { error: 'startup-failed' }); return; }
    const failure = describeWorkspaceFailure(error, { operation: 'startup' });
    dialog.showErrorBox(failure?.title ?? 'OpenAster 启动失败', failure
      ? `${failure.message}\n\n${failure.detail}`
      : '本地服务未能启动。请检查数据目录权限、磁盘空间和系统版本。');
    app.quit();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => {
    if (!service || exitAllowed) return;
    closing = true;
    // Cancel pending intent now, but keep the service live until beforeunload
    // has actually been accepted by every renderer.
    lifecycle?.beginQuit();
  });
  app.on('will-quit', event => {
    if (!service || exitAllowed) return;
    event.preventDefault();
    closing = true;
    const shutdown = lifecycle ? lifecycle.requestQuit() : Promise.resolve(service.close()).finally(resumeQuit);
    void shutdown.catch(() => {
      console.error('OpenAster shutdown did not finish cleanly.');
    });
  });
}
