// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { CoreError } from './errors.mjs';
import { validateCommand } from './command-schema.mjs';

export const COMMAND_POLICY_WARNING = '命令以服务主机当前系统账户运行，工作目录不是操作系统沙箱。本任务授权允许项目脚本修改文件及联网；无法证明脚本内部没有危险行为。授权仅适用于当前任务本轮执行，可随时撤销，结束或服务重启后失效。';
const MODES = ['smart', 'ask', 'trusted'];
const PROGRAMS = new Set(['git', 'npm', 'pnpm', 'yarn', 'node', 'python', 'python3', 'pytest', 'cargo', 'go', 'dotnet', 'mvn', 'gradle', 'tsc', 'eslint']);
const DANGEROUS = new Set(['rm', 'rmdir', 'del', 'erase', 'remove-item', 'clear-content', 'format', 'mkfs', 'diskpart', 'shutdown', 'reboot', 'sudo', 'su', 'runas', 'start-process', 'invoke-expression', 'iex', 'reset', 'restore', 'checkout', 'switch', 'stash', 'clean', 'push', 'publish', 'unpublish', 'force', 'prune', 'gc', 'reflog', 'filter-branch', 'filter-repo', 'credential', 'credentials', 'login', 'logout', 'token', 'tokens', 'config', 'uninstall', 'remove', 'exec', 'dlx', 'x', 'install-service']);
const invalid = () => new CoreError('INVALID_COMMAND_POLICY', '请选择智能审批、逐条审批或明确授权本任务。', 400);
function own(value, allowed, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (keys.some(key => !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value')) || required.some(key => !keys.includes(key))) throw invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
export function validateCommandPolicyRequest(value) {
  const result = own(value, ['mode', 'confirmRisk'], ['mode']);
  if (!MODES.includes(result.mode) || (Object.hasOwn(result, 'confirmRisk') && typeof result.confirmRisk !== 'boolean')) throw invalid();
  if (result.mode === 'trusted' && result.confirmRisk !== true) throw new CoreError('COMMAND_POLICY_CONFIRMATION_REQUIRED', COMMAND_POLICY_WARNING, 400);
  return result;
}
export function validateCommandDecision(value) {
  const result = own(value, ['decision', 'scope', 'confirmRisk'], ['decision']);
  if (!['approve', 'deny'].includes(result.decision) || (result.scope !== undefined && !['once', 'session'].includes(result.scope)) || (result.confirmRisk !== undefined && typeof result.confirmRisk !== 'boolean')) throw invalid();
  if (result.decision === 'deny' && (result.scope === 'session' || result.confirmRisk !== undefined)) throw invalid();
  if (result.scope === 'session' && result.confirmRisk !== true) throw new CoreError('COMMAND_POLICY_CONFIRMATION_REQUIRED', COMMAND_POLICY_WARNING, 400);
  return { decision: result.decision, scope: result.scope ?? 'once', ...(result.confirmRisk === undefined ? {} : { confirmRisk: result.confirmRisk }) };
}

// This is a deliberately finite literal-command policy, NOT a shell parser or a
// proof that project scripts are harmless. Any syntax outside this narrow form
// is reviewed once. The human's task grant explicitly trusts project code.
export function assessCommand(proposal, { readOnly = false, readOnlyCandidate = false, root, directory } = {}) {
  const command = validateCommand(proposal);
  const outside = path.isAbsolute(command.cwd) || /^[A-Za-z]:/u.test(command.cwd) || !root || !directory?.canonical || (() => {
    const relative = path.relative(root, directory.canonical);
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  })();
  if (outside) return { readOnly: false, sessionEligible: false, reason: '外部或绝对工作目录需要单次审核。' };
  if (readOnly) return { readOnly: true, sessionEligible: true, reason: '固定只读命令使用受限执行计划。' };
  if (readOnlyCandidate) return { readOnly: false, sessionEligible: false, reason: '程序或项目配置不能满足只读执行条件，需要单次审核。' };
  if (!/^[A-Za-z0-9_./:=,+ -]+$/u.test(command.command) || command.command.trim() !== command.command) return { readOnly: false, sessionEligible: false, reason: '复杂 shell 表达式、引用、插值或组合命令需要单次审核。' };
  const words = command.command.split(/ +/u), lower = words.map(word => word.toLowerCase());
  const program = lower[0].replace(/\.exe$/u, '');
  if (!PROGRAMS.has(program)) return { readOnly: false, sessionEligible: false, reason: '此程序不在本任务授权的开发命令范围内。' };
  if (words.some(word => /(?:^|[=:])(?:[A-Za-z]:|[\\/]|~)|(?:^|[=:/])\.\.(?:[\\/]|$)/u.test(word))) return { readOnly: false, sessionEligible: false, reason: '绝对路径、父目录或范围变化需要单次审核。' };
  if (lower.some(word => DANGEROUS.has(word) || /^--(?:force|hard|delete|global|system|prefix|git-dir|work-tree|eval|exec|config|command|encodedcommand|amend|script-shell|shell|userconfig|globalconfig)(?:[-=]|$)|^-(?:rf|fr|f|e|c|d)$/u.test(word))) return { readOnly: false, sessionEligible: false, reason: '破坏性操作、提权、配置变化或内联代码需要单次审核。' };
  if (program === 'git' && !['add', 'commit', 'status', 'diff', 'log', 'show', 'ls-files', 'rev-parse', 'branch', 'tag', 'fetch'].includes(lower[1])) return { readOnly: false, sessionEligible: false, reason: '此 Git 操作不在本轮开发授权范围内。' };
  // Language-specific inline-code flags and Git's -C/-c must never become a
  // different command or scope through case normalization or joined options.
  if ((program === 'git' && words.slice(1).some(word => /^-[cC]/u.test(word)))
    || (['node', 'python', 'python3'].includes(program) && words.slice(1).some(word => /^-(?:[cepi]|-eval|-print|-input-type)/u.test(word)))
    || (['npm', 'pnpm', 'yarn'].includes(program) && lower.slice(1).some(word => word === '-g' || word === '--global')))
    return { readOnly: false, sessionEligible: false, reason: '内联代码、配置或命令执行范围变化需要单次审核。' };
  return { readOnly: false, sessionEligible: true, reason: '限定字面开发命令；其项目脚本可能修改文件及联网。' };
}

export function createCommandAuthorization() {
  const states = new Map();
  const issued = new WeakSet();
  const current = id => states.get(id) ?? { mode: 'smart', revision: 0, runId: null, grantedAt: null };
  function snapshot(sessionId) { return { sessionId, ...current(sessionId), lifetime: 'task-run', sandbox: false, warning: COMMAND_POLICY_WARNING }; }
  function change(sessionId, input, runId = null) {
    const value = validateCommandPolicyRequest(input), old = current(sessionId);
    states.set(sessionId, { mode: value.mode, revision: old.revision + 1, runId: value.mode === 'trusted' ? runId : null, grantedAt: value.mode === 'trusted' ? new Date().toISOString() : null });
    return snapshot(sessionId);
  }
  function begin(sessionId, runId) {
    const state = states.get(sessionId);
    if (state?.mode === 'trusted') {
      if (state.runId && state.runId !== runId) return change(sessionId, { mode: 'smart' });
      state.runId = runId;
    }
    return snapshot(sessionId);
  }
  function finish(sessionId, runId) {
    if (current(sessionId).mode === 'trusted' && current(sessionId).runId === runId) return change(sessionId, { mode: 'smart' });
    return snapshot(sessionId);
  }
  function ticket(sessionId, runId, assessment) {
    const state = current(sessionId);
    if (!states.has(sessionId)) states.set(sessionId, state);
    const kind = state.mode !== 'ask' && assessment.readOnly ? 'read-only'
      : state.mode === 'trusted' && state.runId === runId && assessment.sessionEligible ? 'task-grant' : null;
    if (!kind) return null;
    const value = Object.freeze({ sessionId, runId, revision: state.revision, kind }); issued.add(value); return value;
  }
  function assert(ticketValue) {
    if (!issued.has(ticketValue)) throw new CoreError('COMMAND_AUTHORIZATION_REVOKED', '命令授权不存在或不属于此工作区服务。', 409);
    const state = current(ticketValue.sessionId);
    if (state.revision !== ticketValue.revision || state.mode === 'ask' || (ticketValue.kind === 'task-grant' && (state.mode !== 'trusted' || state.runId !== ticketValue.runId)))
      throw new CoreError('COMMAND_AUTHORIZATION_REVOKED', '命令启动前授权已撤销或改变；命令未执行，请重新发起。', 409);
  }
  function revokeAll() { for (const id of states.keys()) change(id, { mode: 'smart' }); }
  return Object.freeze({ snapshot, change, begin, finish, ticket, assert, revokeAll });
}
