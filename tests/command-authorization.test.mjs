// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { assessCommand, createCommandAuthorization, validateCommandDecision, validateCommandPolicyRequest } from '../core/command-authorization.mjs';
import { createCommandApprovalService } from '../server/command-authorization.mjs';

const root = path.resolve('command-policy-fixture');
const context = { root, directory: { canonical: root, dev: '1', ino: '2' } };
const proposal = (command, extra = {}) => ({ command, cwd: '', shell: process.platform === 'win32' ? 'powershell' : 'sh', timeoutMs: 30000, ...extra });

test('smart grants only a verified read-only plan; unverified known query falls back to once', () => {
  const auth = createCommandAuthorization();
  const safe = assessCommand(proposal('git status'), { ...context, readOnly: true });
  assert.equal(auth.ticket('a', 'run', safe).kind, 'read-only');
  assert.equal(auth.ticket('a', 'run', assessCommand(proposal('npm test'), context)), null);
  assert.equal(assessCommand(proposal('git status'), { ...context, readOnlyCandidate: true }).sessionEligible, false);
  auth.change('a', { mode: 'ask' });
  assert.equal(auth.ticket('a', 'run', safe), null);
});

test('task grant is explicit, local to session/run/runtime, revoked at finish, and never restored from history', () => {
  const auth = createCommandAuthorization(), assessment = assessCommand(proposal('npm run build'), context);
  assert.throws(() => auth.change('a', { mode: 'trusted' }), { code: 'COMMAND_POLICY_CONFIRMATION_REQUIRED' });
  auth.change('a', { mode: 'trusted', confirmRisk: true });
  assert.equal(auth.ticket('a', 'run', assessment), null);
  auth.begin('a', 'run');
  const ticket = auth.ticket('a', 'run', assessment);
  assert.equal(ticket.kind, 'task-grant'); auth.assert(ticket);
  assert.equal(auth.ticket('b', 'run', assessment), null);
  assert.equal(auth.ticket('a', 'other', assessment), null);
  assert.throws(() => createCommandAuthorization().assert(ticket), { code: 'COMMAND_AUTHORIZATION_REVOKED' });
  assert.throws(() => auth.assert({ ...ticket }), { code: 'COMMAND_AUTHORIZATION_REVOKED' });
  auth.finish('a', 'run');
  assert.equal(auth.snapshot('a').mode, 'smart');
  assert.throws(() => auth.assert(ticket), { code: 'COMMAND_AUTHORIZATION_REVOKED' });
});

test('revocation invalidates previously queued tickets including smart plans and is not undone by regrant', () => {
  const auth = createCommandAuthorization(), safe = assessCommand(proposal('pwd'), { ...context, readOnly: true });
  const first = auth.ticket('a', 'run', safe);
  auth.revokeAll();
  assert.throws(() => auth.assert(first), { code: 'COMMAND_AUTHORIZATION_REVOKED' });
  auth.change('a', { mode: 'trusted', confirmRisk: true }, 'run');
  assert.throws(() => auth.assert(first), { code: 'COMMAND_AUTHORIZATION_REVOKED' });
  auth.assert(auth.ticket('a', 'run', safe));
});

test('ordinary development scripts are eligible only under an explicit task grant', () => {
  for (const command of ['npm test', 'npm run build', 'pnpm test', 'yarn build', 'node scripts/build.mjs', 'python tools/check.py', 'python3 -m pytest', 'pytest tests', 'cargo test', 'go test ./...', 'dotnet build', 'git add src', 'git commit -m fixture']) {
    const assessment = assessCommand(proposal(command), context);
    assert.equal(assessment.sessionEligible, true, command);
    assert.equal(assessment.readOnly, false, command);
  }
});

test('dangerous arguments, alternate scope, elevation, wrappers and shell syntax cannot widen task grants', () => {
  const commands = [
    'rm -rf project', 'Remove-Item project', 'sudo npm test', 'runas node script.js', 'cmd /c npm test', 'pwsh -Command npm',
    'sh -c npm', 'npm test; rm file', 'npm test && node other.js', 'npm test | node other.js', 'npm test > out', 'npm test\nnode other.js',
    'npm test $HOME', 'npm run `whoami`', 'npm test "x"', 'node -e process.exit()', 'node --eval=x', 'node -p1', 'python -cx',
    'git reset --hard', 'git clean -fd', 'git push origin main', 'git commit --amend', 'git -Cother status', 'git -cfoo=bar status',
    'git --config-env=x status', 'git --exec-path=x status', 'git update-ref HEAD x', 'git branch -D main', 'git checkout main',
    'npm publish', 'npm uninstall x', 'npm --global install x', 'npm --prefix=outside test', 'npm run test --force=true',
    'node /tmp/script.js', 'node C:/temp/script.js', 'node ../other.js', 'npm test --output=/tmp/x', 'node ./../other.js',
    'unknown-tool test', 'npm --script-shell=sh test', 'node script.js --delete=all', 'npm run test --force-with-lease',
  ];
  for (const command of commands) assert.equal(assessCommand(proposal(command), context).sessionEligible, false, command);
  assert.equal(assessCommand(proposal('npm test', { cwd: path.resolve(root, '..') }), context).sessionEligible, false);
  assert.equal(assessCommand(proposal('npm test'), { ...context, directory: { canonical: path.resolve(root, '..') } }).sessionEligible, false);
});

test('policy/decision DTOs reject overbroad, malformed, inherited and accessor-shaped permission input', () => {
  for (const value of [{ mode: 'all' }, { mode: 'trusted', confirmRisk: false }, { mode: 'smart', scope: '*' }, { mode: 'smart', confirmRisk: 'yes' }, { get mode() { throw new Error('must not invoke'); } }]) assert.throws(() => validateCommandPolicyRequest(value));
  assert.throws(() => validateCommandPolicyRequest(Object.create({ mode: 'trusted' })));
  for (const value of [{ decision: 'allow' }, { decision: 'approve', scope: '*' }, { decision: 'approve', scope: 'session' }, { decision: 'deny', scope: 'session', confirmRisk: true }, { decision: 'approve', command: 'npm test' }]) assert.throws(() => validateCommandDecision(value));
  assert.deepEqual(validateCommandDecision({ decision: 'approve' }), { decision: 'approve', scope: 'once' });
});

test('service forwards only validated human API requests, not client-selected executable scope', async () => {
  const calls = [], runtime = { getCommandPolicy: async id => ({ sessionId: id }), setCommandPolicy: async (...args) => { calls.push(args); return {}; }, decide: async (...args) => { calls.push(args); return {}; } };
  const service = createCommandApprovalService({ runtime });
  assert.deepEqual(await service.read('s'), { sessionId: 's' });
  await service.update('s', { mode: 'trusted', confirmRisk: true });
  await service.decide('a', { decision: 'approve', scope: 'session', confirmRisk: true });
  assert.deepEqual(calls, [['s', { mode: 'trusted', confirmRisk: true }], ['a', 'approve', { scope: 'session', confirmRisk: true }]]);
  assert.throws(() => service.update('s', { mode: 'trusted', confirmRisk: true, shell: '*' }));
  assert.throws(() => service.decide('a', { decision: 'approve', scope: 'session', confirmRisk: true, sessionId: 'other' }));
  assert.equal(calls.length, 2);
});
