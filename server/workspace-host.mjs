// SPDX-License-Identifier: Apache-2.0
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createWorkspaceProfiles } from '../desktop/workspace-profiles.mjs';
import { createWorkspaceManager, inspectProjectDirectory } from './workspace-manager.mjs';
import { startServer } from './index.mjs';
import { initializeSkillDirectory, DEFAULT_SKILLS_ROOT } from '../core/skills.mjs';
import { createWorkspace } from '../core/workspace.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** One service/SQLite owner at a time. Never rebind an existing runtime to another directory. */
export async function startWorkspaceHost(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? process.env.OPENASTER_DATA_DIR ?? path.join(ROOT, '.openaster'));
  const defaultWorkspace = path.resolve(options.workspace ?? process.env.OPENASTER_WORKSPACE ?? path.join(dataDir, 'workspace'));
  const home = options.homeDirectory ?? homedir();
  const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const inside = (parent, child) => { const relative = path.relative(normalized(parent), normalized(child)); return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  if (normalized(dataDir) === normalized(ROOT) || ['server', 'core', 'public', 'desktop', 'mobile', 'scripts', 'tests', 'docs'].some(name => inside(path.join(ROOT, name), dataDir) || inside(dataDir, path.join(ROOT, name))) ||
      inside(defaultWorkspace, dataDir) || inside(defaultWorkspace, ROOT) || (inside(ROOT, defaultWorkspace) || inside(dataDir, defaultWorkspace)) && !inside(path.join(dataDir, 'workspace'), defaultWorkspace)) {
    throw Object.assign(new Error('应用数据和项目目录必须与源码、凭据存储分离。'), { code: 'UNSAFE_WORKSPACE' });
  }
  await mkdir(path.dirname(dataDir), { recursive: true, mode: 0o700 });
  const registry = createWorkspaceProfiles({ userData: dataDir, appRoots: [ROOT], homeDirectory: home });
  await registry.initialize();
  // Preserve the existing CLI dataDir/workspace binding, including an explicit
  // OPENASTER_WORKSPACE. Opening a different project gets its own profile data.
  const mapDefault = profile => profile.id === 'default' ? { ...profile, workspace: defaultWorkspace, label: options.workspaceName ?? '默认工作区' } : profile;
  const profiles = { ...registry, list: async () => (await registry.list()).map(mapDefault),
    getActive: async () => mapDefault(await registry.getActive()), activate: async selection => mapDefault(await registry.activate(selection)) };
  let service, active = await profiles.getActive(), port = options.port ?? 0, closing = false, transitionPromise;
  const manager = createWorkspaceManager({ profiles, getCurrent: async () => active,
    projectsRoot: options.projectsRoot ?? process.env.OPENASTER_PROJECTS_ROOT ?? path.join(home, 'OpenAster Projects'),
    homeDirectory: home, protectedRoots: [dataDir, ROOT],
    transition: commit => {
      transitionPromise = (async () => {
        if (closing) throw Object.assign(new Error('服务正在停止。'), { code: 'WORKSPACE_BUSY' });
        // close's idle check and admission gate are synchronous and atomic.
        await service.close({ ifIdle: true });
        let failure;
        try { await commit(); } catch (cause) { failure = cause; }
        active = await profiles.getActive();
        try { service = await open(); }
        catch (cause) { throw Object.assign(new Error('项目服务未能重新启动，请重启服务后查看所选项目。', { cause }), { code: 'WORKSPACE_RESTART_FAILED' }); }
        if (failure) throw failure;
        return true;
      })();
      return transitionPromise;
    },
  });
  async function open() {
    const external = active.kind === 'external', restored = active.kind === 'restored';
    const workspaceOptions = external ? { createRoot: false, expectedIdentity: active.identity, protectedRoots: [dataDir, ROOT], denySensitivePaths: true, projectScan: true }
      : restored ? { createRoot: false, expectedIdentity: active.identity } : options.workspaceOptions;
    // Seed only a missing skills directory; never replace user-maintained skills.
    if (external || restored) await createWorkspace(active.workspace, workspaceOptions).getIdentity();
    else {
      // Check every existing parent before creating anything or seeding skills.
      // An explicit CLI path must not redirect initialization through a link.
      let ancestor = active.workspace;
      for (;;) {
        try { await inspectProjectDirectory(ancestor); break; }
        catch (cause) { if (cause.code !== 'ENOENT') throw cause; ancestor = path.dirname(ancestor); }
      }
      await mkdir(active.workspace, { recursive: true, mode: 0o700 });
      await createWorkspace(active.workspace, { ...workspaceOptions, createRoot: false }).getIdentity();
    }
    const skillsDirectory = path.join(active.workspace, 'skills');
    await initializeSkillDirectory(DEFAULT_SKILLS_ROOT, skillsDirectory);
    const next = await startServer({ ...options, port, dataDir: active.dataDir, workspace: active.workspace,
      workspaceId: active.id, workspaceName: active.label, workspaceOptions, skillsDirectory, workspaceManager: manager });
    port = Number(new URL(next.url).port);
    return next;
  }
  service = await open();
  return { get url() { return service.url; }, get server() { return service.server; }, manager,
    async close() { closing = true; await transitionPromise?.catch(() => {}); await service.close(); } };
}
