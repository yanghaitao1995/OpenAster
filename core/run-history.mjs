import { validateProviderConnection } from './provider-retry.mjs';
import { validatePublicOutput, validateInterruptedOutputs } from './provider-progress.mjs';
// SPDX-License-Identifier: Apache-2.0
import { CoreError } from './errors.mjs';
import { sanitizeUsage } from './usage.mjs';
import { validateOperationPath } from './access-path.mjs';
import { validateToolResultRef, validateContextPlan } from './tool-artifacts.mjs';
import { commandHistory, validateCommandHistory } from './command-schema.mjs';

export const RUN_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
export const RUN_HISTORY_MAX_STEPS = 2560;
export const RUN_HISTORY_MAX_APPROVALS = 2068;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const RUN_FIELDS = ['id', 'status', 'steps', 'output', 'startedAt', 'finishedAt', 'error', 'connection', 'requestMessageId', 'requestPreview', 'budget'];
const STEP_FIELDS = ['id', 'type', 'title', 'detail', 'status', 'createdAt', 'usage', 'toolResultRef', 'contextPlan', 'finishedAt', 'phase', 'connection', 'publicSummary', 'publicSummaryTruncated', 'publicReasoning', 'interruptedOutputs', 'purpose', 'contextUsage'];
const CONNECTION_FIELDS = ['providerId', 'name', 'type', 'model', 'toolMode'];
const APPROVAL_FIELDS = ['id', 'tool', 'path', 'status', 'createdAt', 'resolvedAt', 'appliedAt', 'originalHash', 'proposedHash'];
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new CoreError('INVALID_RUN_HISTORY', '执行历史的数据格式无效。');
function requireValue(condition) { if (!condition) throw invalid(); }
function shape(value, allowed, required = allowed) {
  requireValue(object(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)));
}
function text(value) { requireValue(typeof value === 'string' && value.isWellFormed() && !value.includes('\0')); }
function id(value) { requireValue(typeof value === 'string' && ID.test(value)); }
function timestamp(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
}
function optional(value, key, check) { if (Object.hasOwn(value, key) && value[key] !== null) check(value[key]); }
export function validateRunBudget(value) {
  shape(value, ['maxModelCalls', 'maxTools', 'maxRunMs', 'modelCalls', 'toolCalls']);
  for (const [key, min, max] of [['maxModelCalls', 1, 512], ['maxTools', 1, 2048], ['maxRunMs', 1, 14400000], ['modelCalls', 0, value.maxModelCalls], ['toolCalls', 0, value.maxTools]]) requireValue(Number.isSafeInteger(value[key]) && value[key] >= min && value[key] <= max);
  return value;
}
export function validateContextUsage(value) {
  shape(value, ['estimatedInputTokens', 'contextWindowTokens', 'reservedOutputTokens', 'thresholdTokens', 'configuredOutputTokens'],
    ['estimatedInputTokens', 'contextWindowTokens', 'reservedOutputTokens', 'thresholdTokens']);
  requireValue(Object.values(value).every(item => Number.isSafeInteger(item) && item >= 0));
  requireValue(value.contextWindowTokens >= 8192 && value.contextWindowTokens <= 2000000 && value.reservedOutputTokens <= 131072 && value.thresholdTokens <= value.contextWindowTokens);
  if (Object.hasOwn(value, 'configuredOutputTokens')) requireValue(value.configuredOutputTokens >= 128 && value.configuredOutputTokens <= 131072 && value.reservedOutputTokens <= value.configuredOutputTokens);
  return value;
}
function fields(value, names) { return Object.fromEntries(names.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])); }
function jsonCopy(value) {
  let json;
  try { json = JSON.stringify(value); } catch { throw invalid(); }
  if (typeof json !== 'string') throw invalid();
  if (Buffer.byteLength(json) > RUN_HISTORY_MAX_BYTES) throw new CoreError('RUN_HISTORY_LIMIT', '单次执行历史超过 8 MiB 存储上限。', 413);
  return JSON.parse(json);
}

/** Validate canonical imported history without silently repairing its contents. */
export function validateRunHistoryRecord(value) {
  const record = jsonCopy(value);
  shape(record, ['sessionId', 'run', 'approvals']); id(record.sessionId);
  const run = record.run;
  shape(run, RUN_FIELDS, ['id', 'status']); id(run.id); requireValue(TERMINAL.has(run.status));
  if (Object.hasOwn(run, 'budget')) validateRunBudget(run.budget);
  for (const key of ['startedAt', 'finishedAt']) optional(run, key, timestamp);
  if (Object.hasOwn(run, 'requestMessageId')) id(run.requestMessageId);
  if (Object.hasOwn(run, 'requestPreview')) { text(run.requestPreview); requireValue(run.requestPreview.length <= 240); }
  if (Object.hasOwn(run, 'connection')) {
    shape(run.connection, CONNECTION_FIELDS);
    id(run.connection.providerId); text(run.connection.name); text(run.connection.model);
    requireValue(run.connection.name.length <= 100 && run.connection.name.trim().length > 0
      && run.connection.model.length <= 200 && run.connection.model.trim().length > 0);
    requireValue(['demo', 'openai', 'responses', 'anthropic', 'ollama'].includes(run.connection.type));
    requireValue(['workspace', 'none'].includes(run.connection.toolMode));
    requireValue(run.connection.type !== 'demo' || run.connection.toolMode === 'workspace');
  }
  if (run.steps != null) {
    requireValue(Array.isArray(run.steps) && run.steps.length <= RUN_HISTORY_MAX_STEPS);
    const ids = new Set();
    for (const step of run.steps) {
      // Older stores accepted sparse step metadata. Keep missing fields missing.
      shape(step, STEP_FIELDS, []);
      if (Object.hasOwn(step, 'id')) { id(step.id); requireValue(!ids.has(step.id)); ids.add(step.id); }
      if (Object.hasOwn(step, 'type')) requireValue(['model', 'tool'].includes(step.type));
      if (Object.hasOwn(step, 'purpose')) requireValue(step.type === 'model' && ['response', 'compaction', 'continuation'].includes(step.purpose));
      if (Object.hasOwn(step, 'contextUsage')) { requireValue(step.type === 'model'); validateContextUsage(step.contextUsage); }
      if (Object.hasOwn(step, 'status')) requireValue(['running', 'completed', 'failed', 'cancelled'].includes(step.status));
      for (const key of ['title', 'detail']) if (Object.hasOwn(step, key)) text(step[key]);
      if (Object.hasOwn(step, 'createdAt')) timestamp(step.createdAt);
      if (Object.hasOwn(step, 'finishedAt')) timestamp(step.finishedAt);
      if (Object.hasOwn(step, 'phase')) requireValue(step.type === 'model' && ['connecting', 'streaming', 'retrying', 'completed', 'failed', 'cancelled'].includes(step.phase));
      if (Object.hasOwn(step, 'connection')) {
        requireValue(step.type === 'model');
        try { validateProviderConnection(step.connection); } catch { throw invalid(); }
      }
      for (const field of ['publicSummary', 'publicReasoning']) if (Object.hasOwn(step, field)) {
        requireValue(step.type === 'model');
        try { validatePublicOutput(step[field]); } catch { throw invalid(); }
      }
      if (Object.hasOwn(step, 'interruptedOutputs')) {
        requireValue(step.type === 'model');
        try { validateInterruptedOutputs(step.interruptedOutputs); } catch { throw invalid(); }
      }
      if (Object.hasOwn(step, 'publicSummaryTruncated')) requireValue(step.publicSummaryTruncated === true && typeof step.publicSummary === 'string');
      if (Object.hasOwn(step, 'toolResultRef')) {
        requireValue(step.type === 'tool' && step.id === step.toolResultRef?.artifactId);
        try { validateToolResultRef(step.toolResultRef); } catch { throw invalid(); }
      }
      if (Object.hasOwn(step, 'contextPlan')) {
        requireValue(step.type === 'model' && typeof step.id === 'string');
        try { validateContextPlan(step.contextPlan); } catch { throw invalid(); }
      }
      if (Object.hasOwn(step, 'usage') && step.usage !== null) {
        requireValue(step.type === 'model'); shape(step.usage, USAGE_FIELDS);
        const normalized = sanitizeUsage(step.usage);
        requireValue(normalized !== null && USAGE_FIELDS.every(key => normalized[key] === step.usage[key]));
      }
    }
  }
  if (run.output != null) {
    shape(run.output, ['stepId', 'content', 'status', 'publicReasoning'], ['stepId', 'content', 'status']); id(run.output.stepId); text(run.output.content);
    try { validatePublicOutput(run.output.content); } catch { throw invalid(); }
    if (Object.hasOwn(run.output, 'publicReasoning')) { try { validatePublicOutput(run.output.publicReasoning); } catch { throw invalid(); } }
    requireValue(['streaming', 'processing', 'interrupted'].includes(run.output.status));
  }
  if (run.error != null) {
    if (typeof run.error === 'string') text(run.error);
    else { shape(run.error, ['code', 'message']); text(run.error.code); text(run.error.message); }
  }
  requireValue(Array.isArray(record.approvals) && record.approvals.length <= RUN_HISTORY_MAX_APPROVALS);
  const approvals = new Set();
  for (const approval of record.approvals) {
    shape(approval, [...APPROVAL_FIELDS, ...(approval.tool === 'run_command' ? ['command', 'startedAt'] : [])]); id(approval.id); requireValue(!approvals.has(approval.id)); approvals.add(approval.id);
    requireValue([null, 'write_file', 'edit_file', 'run_command'].includes(approval.tool));
    requireValue(['approved', 'denied', 'revoked'].includes(approval.status));
    if (approval.path !== null) { try { validateOperationPath(approval.path); } catch { throw invalid(); } }
    for (const key of ['createdAt', 'resolvedAt', 'appliedAt']) if (approval[key] !== null) timestamp(approval[key]);
    for (const key of ['originalHash', 'proposedHash']) requireValue(approval[key] === null || (typeof approval[key] === 'string' && HASH.test(approval[key])));
    if (approval.tool === 'run_command') {
      try { validateCommandHistory(approval.command); } catch { throw invalid(); }
      requireValue(['path', 'appliedAt', 'originalHash', 'proposedHash'].every(key => approval[key] === null));
      if (approval.startedAt !== null) { timestamp(approval.startedAt); requireValue(approval.status === 'approved'); }
    }
  }
  return record;
}

/** Archive facts from this run only; never copy executable approvals or credentials. */
export function createRunHistoryRecord(session) {
  if (!TERMINAL.has(session?.run?.status)) return null;
  const source = session.run;
  const run = fields(source, RUN_FIELDS);
  if (object(source.connection)) run.connection = fields(source.connection, CONNECTION_FIELDS);
  if (Array.isArray(source.steps)) run.steps = source.steps.map(step => {
    if (!object(step)) throw invalid();
    const clean = fields(step, STEP_FIELDS.filter(key => key !== 'usage'));
    if (step.type === 'model' && Object.hasOwn(step, 'usage')) clean.usage = sanitizeUsage(step.usage);
    return clean;
  });
  if (object(source.output)) run.output = fields(source.output, ['stepId', 'content', 'status', 'publicReasoning']);
  if (object(source.error)) run.error = fields(source.error, ['code', 'message']);
  const approvals = (session.approvals ?? []).filter(approval => approval?.runId === source.id).map(approval => ({
    id: approval.id,
    tool: ['write_file', 'edit_file', 'run_command'].includes(approval.tool) ? approval.tool : null,
    path: approval.args?.path ?? null,
    status: approval.status === 'pending' || approval.revoked === true ? 'revoked' : approval.status,
    createdAt: approval.createdAt ?? null,
    resolvedAt: approval.resolvedAt ?? null,
    appliedAt: approval.appliedAt ?? null,
    originalHash: approval.preview && Object.hasOwn(approval.preview, 'originalHash') ? approval.preview.originalHash : approval.hashes?.original ?? null,
    proposedHash: approval.preview && Object.hasOwn(approval.preview, 'newHash') ? approval.preview.newHash : approval.hashes?.proposed ?? null,
    ...(approval.tool === 'run_command' ? { command: commandHistory(approval.command), startedAt: approval.startedAt ?? null } : {}),
  }));
  return validateRunHistoryRecord({ sessionId: session.id, run, approvals });
}

/** The compact projection stored separately for bounded SQL pagination. */
export function summarizeRunHistory(record) {
  const { run, approvals } = record;
  return {
    id: run.id, status: run.status,
    startedAt: run.startedAt ?? null, finishedAt: run.finishedAt ?? null,
    connection: run.connection ?? null, requestPreview: run.requestPreview ?? null,
    stepCount: run.steps?.length ?? 0, approvalCount: approvals.length,
  };
}

/** Check references without loading full tool bodies during streaming checkpoints. */
export function validateRunArtifactLinks(run, { sessionId, getArtifact, isBoundary } = {}) {
  if (!run) return;
  const preceding = new Map(), completedCompactions = new Map();
  let completePreceding = true;
  for (const step of run.steps ?? []) {
    if (Object.hasOwn(step, 'contextPlan')) {
      requireValue(step.type === 'model' && typeof step.id === 'string' && completePreceding);
      id(sessionId); id(run.id); id(step.id);
      let plan; try { plan = validateContextPlan(step.contextPlan); } catch { throw invalid(); }
      const summarizedIds = plan.compaction?.artifactIds ?? [];
      if (plan.compaction) {
        const availableAtSummary = completedCompactions.get(plan.compaction.summaryStepId);
        requireValue(Number.isSafeInteger(availableAtSummary) && summarizedIds.length <= availableAtSummary);
      }
      // Compaction accounts for an exact older prefix. It never permits missing,
      // reordered, cross-run, or future evidence to masquerade as a valid plan.
      const coveredIds = [...summarizedIds, ...plan.toolResults.map(item => item.artifactId)];
      const precedingIds = [...preceding.keys()];
      requireValue(coveredIds.length === precedingIds.length && coveredIds.every((artifactId, index) => artifactId === precedingIds[index]));
      for (const item of plan.toolResults) {
        const artifact = preceding.get(item.artifactId);
        requireValue(Boolean(artifact) && artifact.bytes === item.sourceBytes);
        for (const range of item.ranges) {
          for (const offset of [range.start, range.end]) {
            const boundary = isBoundary
              ? isBoundary(artifact, offset)
              : (() => { const data = Buffer.from(artifact.content, 'utf8'); return offset === data.length || (data[offset] & 0xc0) !== 0x80; })();
            requireValue(boundary);
          }
        }
      }
    }
    if (Object.hasOwn(step, 'toolResultRef')) {
      let ref; try { ref = validateToolResultRef(step.toolResultRef); } catch { throw invalid(); }
      requireValue(step.type === 'tool' && step.id === ref.artifactId && !preceding.has(ref.artifactId));
      const artifact = getArtifact(ref.artifactId);
      requireValue(Boolean(artifact) && artifact.id === step.id && artifact.stepId === step.id
        && artifact.sessionId === sessionId && artifact.runId === run.id);
      requireValue(['name', 'path', 'isError', 'bytes', 'sha256'].every(key => ref[key] === artifact[key]));
      preceding.set(artifact.id, artifact);
    }
    if (!['model', 'tool'].includes(step.type) || typeof step.id !== 'string' || (step.type === 'tool' && !Object.hasOwn(step, 'toolResultRef'))) completePreceding = false;
    if (step.type === 'model' && step.purpose === 'compaction' && step.status === 'completed') {
      id(step.id); completedCompactions.set(step.id, preceding.size);
    }
  }
  return preceding;
}
