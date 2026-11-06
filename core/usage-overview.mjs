// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { CoreError } from './errors.mjs';
import { sanitizeUsage } from './usage.mjs';

export const USAGE_OVERVIEW_LIMITS = Object.freeze({ runs: 202000, projectionBytes: 256 * 1024 * 1024, rowBytes: 8192, page: 20, maxPage: 50,
  runSteps: 2560, modelSteps: 512 });
export const USAGE_COUNTERS = Object.freeze(['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens']);
const COUNTS = ['modelSteps', 'stepsWithAnyUsage', 'stepsWithCompleteUsage', 'stepsWithoutUsage', 'unclassifiedSteps', 'runsWithoutStepData', 'unattributedRuns', 'demoRuns'];
const STATUSES = { running: 'running', awaiting_approval: 'awaitingApproval', completed: 'completed', failed: 'failed', cancelled: 'cancelled' };
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;
const CONNECTION = ['providerId', 'name', 'type', 'model', 'toolMode'];
// Match the per-step bound enforced by sanitizeUsage without converting sums
// back to Number. The decimal width also admits bounded legacy step counts.
const MAX_STEP_TOKENS = 1000000000000n;
const MAX_ROW_TOKENS = BigInt(USAGE_OVERVIEW_LIMITS.runSteps) * MAX_STEP_TOKENS;
const TOKEN_SUM = new RegExp(`^(?:0|[1-9]\\d{0,${MAX_ROW_TOKENS.toString().length - 1}})$`, 'u');
const invalid = () => new CoreError('INVALID_USAGE_PROJECTION', '已保存的用量投影无效，请保留数据并检查数据库。', 503);
function requireValue(value) { if (!value) throw invalid(); }
const text = (value, max) => typeof value === 'string' && value.length <= max && value.trim().length > 0 && value.isWellFormed() && !value.includes('\0');

export function emptyUsageStats() {
  return { runs: { total: 0, running: 0, awaitingApproval: 0, completed: 0, failed: 0, cancelled: 0 },
    ...Object.fromEntries(COUNTS.map(key => [key, 0])),
    tokens: Object.fromEntries(USAGE_COUNTERS.map(key => [key, { knownSum: null, reportedSteps: 0, missingSteps: 0 }])) };
}

/** Snapshot identity only. Neither the current provider nor step.detail can fill a legacy gap. */
export function createUsageProjection(sessionId, run) {
  if (run == null) return null;
  requireValue(typeof sessionId === 'string' && ID.test(sessionId) && typeof run === 'object' && !Array.isArray(run)
    && typeof run.id === 'string' && ID.test(run.id) && Object.hasOwn(STATUSES, run.status));
  let connection = null;
  if (Object.hasOwn(run, 'connection')) {
    const value = run.connection;
    requireValue(value && typeof value === 'object' && !Array.isArray(value)
      && CONNECTION.every(key => Object.hasOwn(value, key)) && typeof value.providerId === 'string' && ID.test(value.providerId)
      && text(value.name, 100) && text(value.model, 200)
      && ['demo', 'openai', 'responses', 'anthropic', 'ollama'].includes(value.type)
      && ['none', 'workspace'].includes(value.toolMode) && (value.type !== 'demo' || value.toolMode === 'workspace'));
    connection = Object.fromEntries(CONNECTION.map(key => [key, value[key]]));
  }
  const stats = emptyUsageStats();
  stats.runs.total = 1; stats.runs[STATUSES[run.status]] = 1;
  stats.unattributedRuns = Number(connection === null); stats.demoRuns = Number(connection?.type === 'demo');
  stats.runsWithoutStepData = Number(run.steps == null);
  if (run.steps != null) {
    requireValue(Array.isArray(run.steps) && run.steps.length <= USAGE_OVERVIEW_LIMITS.runSteps);
    for (const step of run.steps) {
      if (step?.type === 'tool') continue;
      if (step?.type !== 'model') { stats.unclassifiedSteps++; continue; }
      stats.modelSteps++;
      requireValue(stats.modelSteps <= USAGE_OVERVIEW_LIMITS.modelSteps);
      const usage = sanitizeUsage(step.usage);
      if (usage) stats.stepsWithAnyUsage++; else stats.stepsWithoutUsage++;
      if (usage && ['inputTokens', 'outputTokens', 'totalTokens'].every(key => usage[key] !== null)) stats.stepsWithCompleteUsage++;
      for (const key of USAGE_COUNTERS) {
        const token = stats.tokens[key], value = usage?.[key];
        if (value == null) token.missingSteps++;
        else { token.reportedSteps++; token.knownSum = (BigInt(token.knownSum ?? '0') + BigInt(value)).toString(); }
      }
    }
  }
  const groupKey = connection === null ? 'unknown' : createHash('sha256').update(JSON.stringify(CONNECTION.map(key => connection[key]))).digest('hex');
  return { sessionId, runId: run.id, groupKey, connection, stats };
}

/** This accepts one compact database row, never a history body or executable data. */
export function parseUsageStats(json) {
  requireValue(typeof json === 'string' && Buffer.byteLength(json) <= USAGE_OVERVIEW_LIMITS.rowBytes);
  let value; try { value = JSON.parse(json); } catch { throw invalid(); }
  const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
  requireValue(exact(value, ['runs', ...COUNTS, 'tokens']) && exact(value.runs, ['total', ...Object.values(STATUSES)]) && exact(value.tokens, USAGE_COUNTERS));
  requireValue(value.runs.total === 1 && Object.values(STATUSES).every(key => [0, 1].includes(value.runs[key]))
    && Object.values(STATUSES).reduce((n, key) => n + value.runs[key], 0) === 1);
  for (const key of COUNTS) requireValue(Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= USAGE_OVERVIEW_LIMITS.runSteps);
  for (const key of ['modelSteps', 'stepsWithAnyUsage', 'stepsWithCompleteUsage', 'stepsWithoutUsage']) requireValue(value[key] <= USAGE_OVERVIEW_LIMITS.modelSteps);
  for (const key of ['runsWithoutStepData', 'unattributedRuns', 'demoRuns']) requireValue(value[key] <= 1);
  requireValue(value.unattributedRuns + value.demoRuns <= 1);
  requireValue(value.stepsWithAnyUsage + value.stepsWithoutUsage === value.modelSteps
    && value.stepsWithCompleteUsage <= value.stepsWithAnyUsage && value.modelSteps + value.unclassifiedSteps <= USAGE_OVERVIEW_LIMITS.runSteps);
  if (value.runsWithoutStepData) requireValue(value.modelSteps === 0 && value.unclassifiedSteps === 0);
  for (const key of USAGE_COUNTERS) {
    const token = value.tokens[key];
    requireValue(exact(token, ['knownSum', 'reportedSteps', 'missingSteps'])
      && Number.isSafeInteger(token.reportedSteps) && token.reportedSteps >= 0 && token.reportedSteps <= value.stepsWithAnyUsage
      && token.missingSteps === value.modelSteps - token.reportedSteps);
    if (['inputTokens', 'outputTokens', 'totalTokens'].includes(key)) requireValue(value.stepsWithCompleteUsage <= token.reportedSteps);
    if (token.reportedSteps === 0) requireValue(token.knownSum === null);
    else requireValue(typeof token.knownSum === 'string' && TOKEN_SUM.test(token.knownSum)
      && BigInt(token.knownSum) <= MAX_ROW_TOKENS && BigInt(token.knownSum) <= BigInt(token.reportedSteps) * MAX_STEP_TOKENS);
  }
  requireValue(value.stepsWithAnyUsage <= USAGE_COUNTERS.reduce((total, key) => total + value.tokens[key].reportedSteps, 0));
  const primaryReports = ['inputTokens', 'outputTokens', 'totalTokens'].reduce((total, key) => total + value.tokens[key].reportedSteps, 0);
  requireValue(value.stepsWithCompleteUsage >= Math.max(0, primaryReports - 2 * value.modelSteps));
  return value;
}

/** Decimal strings cross SQLite/JSON; BigInt is used only for exact addition. */
export function mergeUsageStats(target, source) {
  for (const key of Object.keys(target.runs)) target.runs[key] += source.runs[key];
  for (const key of COUNTS) target[key] += source[key];
  for (const key of USAGE_COUNTERS) {
    const a = target.tokens[key], b = source.tokens[key];
    a.reportedSteps += b.reportedSteps; a.missingSteps += b.missingSteps;
    if (b.knownSum !== null) a.knownSum = (BigInt(a.knownSum ?? '0') + BigInt(b.knownSum)).toString();
  }
  return target;
}
