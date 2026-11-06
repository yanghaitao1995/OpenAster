// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContextPlan, TOOL_ARTIFACT_LIMITS } from '../core/tool-artifacts.mjs';
import { validateRunArtifactLinks } from '../core/run-history.mjs';

const result = artifactId => ({ artifactId, mode: 'full', sourceBytes: 10, sentBytes: 10, ranges: [{ start: 0, end: 10 }] });
const plan = (toolIds = [], compaction) => ({ version: 1, policy: 'preserve-messages-reference-tools', requestBytes: 1000,
  requestByteLimit: 2097152, requestSha256: 'a'.repeat(64), preservedMessages: 2,
  toolResults: toolIds.map(result), ...(compaction === undefined ? {} : { compaction }) });
const memory = (artifactIds = ['old'], summaryStepId = 'summary') => ({ summaryStepId, artifactIds });

test('compaction plan metadata is strict, disjoint, bounded and retains the legacy shape', () => {
  for (const value of [plan(['latest']), plan(['latest'], memory()), plan([], memory([]))]) {
    const original = structuredClone(value);
    assert.deepEqual(validateContextPlan(value), original); assert.deepEqual(value, original);
  }
  const malformed = [null, {}, { artifactIds: ['old'] }, { summaryStepId: 'summary' },
    { ...memory(), extra: true }, memory(['old', 'old']), memory(['latest']), memory(['bad/id']),
    memory([null]), memory(new Array(1)), memory([], ''), memory([], '../summary'),
    memory([], 'x'.repeat(101)), memory(Array.from({ length: TOOL_ARTIFACT_LIMITS.maxPerRun }, (_, i) => `old-${i}`)),
  ];
  for (const compaction of malformed) assert.throws(() => validateContextPlan(plan(['latest'], compaction)), { code: 'INVALID_CONTEXT_PLAN' });
  assert.throws(() => validateContextPlan({ ...plan(), unknown: true }), { code: 'INVALID_CONTEXT_PLAN' });
});

test('compaction metadata validation does not invoke accessors or inherited fields', () => {
  let getterCalls = 0;
  const accessor = () => ({ enumerable: true, get() { getterCalls++; return 'summary'; } });
  const top = plan(); Object.defineProperty(top, 'compaction', accessor());
  const nested = memory(); Object.defineProperty(nested, 'summaryStepId', accessor());
  const entry = ['old']; Object.defineProperty(entry, 0, accessor());
  const arrayGetter = memory(); Object.defineProperty(arrayGetter, 'artifactIds', accessor());
  for (const value of [top, plan([], nested), plan([], memory(entry)), plan([], arrayGetter),
    plan([], Object.create(memory()))]) assert.throws(() => validateContextPlan(value), { code: 'INVALID_CONTEXT_PLAN' });
  assert.equal(getterCalls, 0);
});

test('compaction evidence requires an earlier completed summary from this run and an exact tool prefix', () => {
  const artifacts = new Map(['old', 'middle', 'latest'].map(id => [id, {
    id, stepId: id, sessionId: 'session', runId: 'run', name: 'read_file', path: null,
    isError: false, bytes: 10, sha256: 'a'.repeat(64), content: '0123456789',
  }]));
  const tool = id => ({ id, type: 'tool', toolResultRef: {
    artifactId: id, name: 'read_file', path: null, isError: false, bytes: 10, sha256: 'a'.repeat(64),
  } });
  const summary = { id: 'summary', type: 'model', purpose: 'compaction', status: 'completed' };
  const model = { id: 'response', type: 'model', contextPlan: plan(['middle', 'latest'], memory()) };
  const source = { id: 'run', steps: [tool('old'), tool('middle'), summary, tool('latest'), model] };
  const options = { sessionId: 'session', getArtifact: id => artifacts.get(id) };
  assert.deepEqual([...validateRunArtifactLinks(source, options).keys()], ['old', 'middle', 'latest']);
  const invalid = [
    run => { delete run.steps.at(-1).contextPlan.compaction; },
    run => { run.steps.at(-1).contextPlan.compaction.summaryStepId = 'unknown'; },
    run => { run.steps.at(-1).contextPlan.compaction.summaryStepId = 'response'; },
    run => { run.steps[2].status = 'running'; },
    run => { run.steps[2].status = 'failed'; },
    run => { run.steps[2].status = 'cancelled'; },
    run => { run.steps[2].purpose = 'response'; },
    run => { run.steps[2].purpose = 'continuation'; },
    run => { run.steps[2].type = 'tool'; },
    run => { const [step] = run.steps.splice(2, 1); run.steps.push(step); },
    run => { run.steps.at(-1).contextPlan.compaction.artifactIds = []; },
    run => { run.steps.at(-1).contextPlan.compaction.artifactIds = ['unknown']; },
    run => { run.steps.at(-1).contextPlan = plan(['old', 'latest'], memory(['middle'])); },
    run => { run.steps.at(-1).contextPlan = plan(['latest'], memory(['middle', 'old'])); },
    run => { run.steps.at(-1).contextPlan = plan([], memory(['old', 'middle', 'latest'])); },
    run => { run.steps.at(-1).contextPlan.toolResults.reverse(); },
    run => { run.steps.at(-1).contextPlan.toolResults[0].sourceBytes = 11; run.steps.at(-1).contextPlan.toolResults[0].sentBytes = 11; run.steps.at(-1).contextPlan.toolResults[0].ranges[0].end = 11; },
    run => { run.steps[0].toolResultRef.sha256 = 'b'.repeat(64); },
    run => { run.steps.unshift({ id: 'legacy', type: 'tool' }); },
    run => { run.id = 'foreign-run'; },
  ];
  for (const mutate of invalid) {
    const run = structuredClone(source); mutate(run);
    assert.throws(() => validateRunArtifactLinks(run, options), { code: 'INVALID_RUN_HISTORY' });
  }
  assert.throws(() => validateRunArtifactLinks(source, { ...options, sessionId: 'foreign-session' }), { code: 'INVALID_RUN_HISTORY' });
  assert.throws(() => validateRunArtifactLinks(source, { ...options, isBoundary: () => false }), { code: 'INVALID_RUN_HISTORY' });
});

test('pure conversation compaction still proves summary provenance without omitting any tool evidence', () => {
  const summary = { id: 'summary', type: 'model', purpose: 'compaction', status: 'completed' };
  const run = { id: 'run', steps: [summary, { id: 'response', type: 'model', contextPlan: plan([], memory([])) }] };
  assert.equal(validateRunArtifactLinks(run, { sessionId: 'session' }).size, 0);
  run.steps[0].status = 'running';
  assert.throws(() => validateRunArtifactLinks(run, { sessionId: 'session' }), { code: 'INVALID_RUN_HISTORY' });
});
