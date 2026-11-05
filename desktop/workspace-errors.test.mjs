// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRegistryDiagnostic, describeWorkspaceFailure, formatRegistryDiagnostic } from './workspace-errors.mjs';

const native = (code = 'EACCES', syscall = 'rename') => Object.assign(new Error('PRIVATE error / secret-token'), {
  code, syscall, path: '/PRIVATE/path', dest: '/PRIVATE/destination', stack: 'PRIVATE stack',
});
const wrapped = (code, diagnostic, extra = {}) => Object.assign(new Error('PRIVATE wrapper'), {
  code, registryDiagnostic: diagnostic, ...extra,
});

test('diagnostics copy only enumerable allowlisted native facts and leave raw errors untouched', () => {
  const cause = native();
  const diagnostic = createRegistryDiagnostic({ stage: 'rename-registry', cause: new Error('outer', { cause }) });
  assert.deepEqual(diagnostic, { version: 1, stage: 'rename-registry', committed: false, systemCode: 'EACCES', syscall: 'rename' });
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostic)), diagnostic);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE|secret|path|dest|stack|message/);
  assert.equal(cause.message, 'PRIVATE error / secret-token');
  assert.equal(cause.path, '/PRIVATE/path');
});

test('cause traversal is bounded to six levels and terminates on cycles', () => {
  let within = native('ENOSPC', 'write');
  for (let index = 0; index < 5; index++) within = new Error('wrapper', { cause: within });
  assert.equal(createRegistryDiagnostic({ stage: 'write-temporary', cause: within }).systemCode, 'ENOSPC');
  const outside = new Error('seventh', { cause: within });
  assert.equal(createRegistryDiagnostic({ stage: 'write-temporary', cause: outside }).systemCode, undefined);
  const cyclic = new Error('cycle'); cyclic.cause = cyclic;
  assert.deepEqual(createRegistryDiagnostic({ stage: 'read-registry', cause: cyclic }), { version: 1, stage: 'read-registry', committed: false });
});

test('nested safe diagnostics preserve original stage and commit and merge independent cleanup facts', () => {
  const first = createRegistryDiagnostic({ stage: 'rename-registry', committed: true, cause: native('EIO'), cleanup: [
    { stage: 'remove-temporary', cause: native('EBUSY', 'unlink') },
  ] });
  const result = createRegistryDiagnostic({ stage: 'prepare-profile', cause: new Error('wrapper', { cause: wrapped('WORKSPACE_CLEANUP_INCOMPLETE', first) }), cleanup: [
    { stage: 'remove-profile', cause: native('ENOTEMPTY', 'rmdir') },
    { stage: 'remove-temporary', cause: native('EBUSY', 'unlink') },
  ] });
  assert.deepEqual(result, { version: 1, stage: 'rename-registry', committed: true, systemCode: 'EIO', syscall: 'rename', cleanup: [
    { stage: 'remove-temporary', systemCode: 'EBUSY', syscall: 'unlink' },
    { stage: 'remove-profile', systemCode: 'ENOTEMPTY', syscall: 'rmdir' },
  ] });
  result.cleanup[0].systemCode = 'EPERM';
  assert.equal(first.cleanup[0].systemCode, 'EBUSY');
});

test('read and close failures are independently represented without replacing the read diagnostic', () => {
  const diagnostic = createRegistryDiagnostic({ stage: 'read-registry', cause: native('EIO', 'read'), cleanup: [
    { stage: 'close-registry', cause: native('EBADF', 'close') },
  ] });
  const view = describeWorkspaceFailure(wrapped('WORKSPACE_REGISTRY_READ_FAILED', diagnostic), { operation: 'startup' });
  assert.match(view.message, /无法读取或关闭/);
  assert.match(view.detail, /EIO \/ read/);
  assert.match(view.detail, /EBADF \/ close/);
  assert.doesNotMatch(view.message, /移动|替换|文件夹非法/);
});

test('error getters, inherited fields, toJSON and string conversions never enter diagnostics', () => {
  let calls = 0;
  const malicious = Object.create({ code: 'EPERM', syscall: 'unlink', registryDiagnostic: { version: 1, stage: 'rename-registry', committed: true } });
  for (const name of ['cause', 'code', 'syscall', 'registryDiagnostic']) Object.defineProperty(malicious, name, { get() { calls++; throw new Error('PRIVATE getter'); } });
  malicious.toJSON = () => { calls++; return 'PRIVATE'; };
  malicious.toString = () => { calls++; return 'PRIVATE'; };
  assert.deepEqual(createRegistryDiagnostic({ stage: 'verify-before', cause: malicious }), { version: 1, stage: 'verify-before', committed: false });
  assert.equal(formatRegistryDiagnostic(malicious), '');
  assert.equal(describeWorkspaceFailure(malicious), null);
  assert.equal(calls, 0);
});

test('hostile stage values are not coerced and malformed existing diagnostics are ignored', () => {
  let calls = 0;
  const coercion = { toString() { calls++; throw new Error('PRIVATE coercion'); } };
  const valid = { version: 1, stage: 'rename-registry', committed: false };
  const invalid = [
    { ...valid, stage: coercion }, { ...valid, extra: '/PRIVATE/path' },
    { ...valid, systemCode: 'PRIVATE_KEY' }, { ...valid, syscall: '/PRIVATE/path' },
    { ...valid, cleanup: [{ stage: coercion }] },
    Object.assign(Object.create({ hidden: true }), valid),
    { ...valid, cleanup: Array(1) },
  ];
  for (const registryDiagnostic of invalid) {
    const error = Object.assign(native('ENOSPC', 'write'), { registryDiagnostic });
    assert.deepEqual(createRegistryDiagnostic({ stage: 'write-temporary', cause: error }), { version: 1, stage: 'write-temporary', committed: false, systemCode: 'ENOSPC', syscall: 'write' });
    assert.equal(formatRegistryDiagnostic(error), '');
  }
  assert.equal(calls, 0);
});

test('throwing and revoked proxies cannot break optional error formatting', () => {
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const throwing = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('PRIVATE trap'); }, getPrototypeOf() { throw new Error('PRIVATE trap'); } });
  for (const value of [revoked.proxy, throwing]) {
    assert.equal(formatRegistryDiagnostic(value), '');
    assert.equal(describeWorkspaceFailure(value), null);
    assert.deepEqual(createRegistryDiagnostic({ stage: 'verify-before', cause: value }), { version: 1, stage: 'verify-before', committed: false });
    assert.equal(formatRegistryDiagnostic({ registryDiagnostic: value }), '');
  }
});

test('unknown native codes and syscalls are omitted and invalid caller stages are rejected', () => {
  assert.deepEqual(createRegistryDiagnostic({ stage: 'open-temporary', cause: native('PRIVATE_CODE', 'PRIVATE_SYSCALL') }), { version: 1, stage: 'open-temporary', committed: false });
  for (const stage of ['__proto__', 'constructor', 'PRIVATE_STAGE', null]) assert.throws(() => createRegistryDiagnostic({ stage }), TypeError);
  assert.throws(() => createRegistryDiagnostic({ stage: 'open-temporary', committed: 1 }), TypeError);
  assert.throws(() => createRegistryDiagnostic({ stage: 'open-temporary', cleanup: [{ stage: 'PRIVATE_CLEANUP' }] }), TypeError);
  assert.throws(() => createRegistryDiagnostic({ stage: 'open-temporary', cleanup: Array.from({ length: 4 }, () => ({ stage: 'remove-temporary' })) }), TypeError);
});

test('write cleanup changed and unsafe errors have distinct safe meanings', () => {
  for (const [code, phrase] of [
    ['WORKSPACE_REGISTRY_WRITE_FAILED', '无法保存'],
    ['WORKSPACE_CLEANUP_INCOMPLETE', '安全清理'],
    ['WORKSPACE_REGISTRY_CHANGED', '发生变化'],
    ['WORKSPACE_REGISTRY_UNSAFE', '普通单链接'],
    ['WORKSPACE_REGISTRY_INVALID', '格式检查'],
  ]) {
    const failure = describeWorkspaceFailure(wrapped(code, createRegistryDiagnostic({ stage: 'rename-registry', cause: native() })), { restartRequired: true });
    assert.match(failure.message, new RegExp(phrase));
    assert.ok(failure.detail.includes(code));
    assert.match(failure.detail, /本地服务已停止/);
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE|secret|目录可能已移动/);
  }
  assert.equal(describeWorkspaceFailure(Object.assign(native(), { code: 'PRIVATE_APPLICATION_CODE' })), null);
});

test('uncertain commits never claim the old selection is unchanged or that restart guarantees repair', () => {
  const diagnostic = createRegistryDiagnostic({ stage: 'remove-installed-temporary', committed: true, cause: native('EBUSY', 'unlink') });
  const failure = describeWorkspaceFailure(wrapped('WORKSPACE_REGISTRY_COMMIT_UNCERTAIN', diagnostic), { operation: 'startup' });
  assert.match(failure.message, /当前选择可能已经改变/);
  assert.match(failure.detail, /重新启动不一定能解决/);
  assert.doesNotMatch(failure.detail, /应用将重新打开/);
  const wrappedCleanup = describeWorkspaceFailure(wrapped('WORKSPACE_CLEANUP_INCOMPLETE', diagnostic), { restartRequired: true });
  assert.match(wrappedCleanup.message, /已经提交/);
  assert.match(wrappedCleanup.detail, /尝试重新打开/);
  assert.doesNotMatch(wrappedCleanup.message, /原选择未更改|配置未保存/);
});

test('retained locations are separately bounded local paths and never become diagnostic JSON', () => {
  const directory = path.resolve('test-results', 'registry-safe-location');
  const diagnostic = createRegistryDiagnostic({ stage: 'prepare-profile', cause: native('EIO', 'lstat') });
  const error = wrapped('WORKSPACE_CLEANUP_INCOMPLETE', diagnostic, { orphanPath: directory, retainedPaths: [directory, `${directory}\nPRIVATE`, path.join(directory, 'second'), path.join(directory, 'fourth')] });
  const displayed = describeWorkspaceFailure(error);
  assert.ok(displayed.detail.includes(directory));
  assert.ok(displayed.detail.includes(path.join(directory, 'second')));
  assert.ok(!displayed.detail.includes(path.join(directory, 'fourth')));
  assert.doesNotMatch(displayed.detail, /PRIVATE/);
  assert.ok(!formatRegistryDiagnostic(error).includes(directory));
  assert.ok(!JSON.stringify(diagnostic).includes(directory));
  const restoreDetail = describeWorkspaceFailure(error, { operation: 'restore' }).detail;
  assert.match(restoreDetail, /另外保留的暂存位置/);
  assert.ok(restoreDetail.split('\n').includes(path.join(directory, 'second')));
  assert.ok(!restoreDetail.split('\n').includes(directory));
  for (const invalid of ['relative/PRIVATE', `${directory}\u0000PRIVATE`, path.join(directory, '..', 'x') + '/../PRIVATE', 'x'.repeat(4097)]) {
    assert.doesNotMatch(describeWorkspaceFailure({ code: 'WORKSPACE_CLEANUP_INCOMPLETE', orphanPath: invalid }).detail, /PRIVATE/);
  }
});

test('safe diagnostics roundtrip with a bounded cleanup list and are independent of later mutation', () => {
  let diagnostic = createRegistryDiagnostic({ stage: 'rename-registry', cause: native() });
  for (let index = 0; index < 12; index++) diagnostic = createRegistryDiagnostic({ stage: 'prepare-profile', cause: { registryDiagnostic: diagnostic }, cleanup: [
    { stage: index % 2 ? 'remove-profile' : 'remove-temporary', cause: native(index % 3 ? 'EIO' : 'EBUSY', index % 2 ? 'rmdir' : 'unlink') },
  ] });
  assert.ok(diagnostic.cleanup.length <= 6);
  const clean = JSON.parse(JSON.stringify(diagnostic));
  assert.ok(formatRegistryDiagnostic(clean));
  const snapshot = createRegistryDiagnostic({ stage: 'verify-before', cause: { registryDiagnostic: clean } });
  clean.stage = 'PRIVATE'; clean.cleanup[0].syscall = 'PRIVATE';
  assert.doesNotMatch(formatRegistryDiagnostic(snapshot), /PRIVATE/);
});
