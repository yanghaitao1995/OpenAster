import { validateProviderConnection } from '../core/provider-retry.mjs';
import { validatePublicOutput, validateInterruptedOutputs } from '../core/provider-progress.mjs';
// SPDX-License-Identifier: Apache-2.0
import { validateImages } from '../core/image-attachments.mjs';
import * as fs from 'node:fs/promises';
import { constants, lstatSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { Store, SUMMARY_STORAGE_LIMITS } from './store.mjs';
import { STEERING_LIMITS, validateSteeringRecord } from '../core/steering-input.mjs';
import { STEERING_COLUMNS, validateSteeringTable } from './steering-store.mjs';
import { acquireDataLock } from './lock.mjs';
import { validateRelativePath } from '../core/workspace.mjs';
import { validateOperationPath } from '../core/access-path.mjs';
import { isSensitiveSegment } from '../core/sensitive-paths.mjs';
import { validateProvider, PROVIDER_TYPES } from '../core/providers.mjs';
import { sanitizeUsage } from '../core/usage.mjs';
import { validateCommand, validateCommandHistory } from '../core/command-schema.mjs';
import { createRunHistoryRecord, validateRunHistoryRecord, summarizeRunHistory, validateRunArtifactLinks } from '../core/run-history.mjs';
import { validateContextFiles } from '../core/context-files.mjs';
import { validateBranchMetadata } from '../core/conversation-branch.mjs';
import { validateContextHandoff } from '../core/conversation-handoff.mjs';
import { validateSummaryDraft, interruptSummaryDraft } from '../core/summary-draft.mjs';
import { validateToolArtifact, validateToolResultRef, validateContextPlan, TOOL_ARTIFACT_LIMITS } from '../core/tool-artifacts.mjs';

const MiB = 1024 * 1024;
export const BACKUP_LIMITS = Object.freeze({ archiveBytes: 128 * MiB, sourceDatabaseBytes: 512 * MiB, logicalBytes: 64 * MiB, fileBytes: 16 * MiB, sessionBytes: 8 * MiB, providers: 40, sessions: 1000, runHistory: 200000, toolArtifacts: 200000, summaryJobs: SUMMARY_STORAGE_LIMITS.jobs, audit: 10000, entries: 10000 });
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const usageFields = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens'];
const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const fail = (code, message) => Object.assign(new Error(message), { code });
const invalid = () => fail('INVALID_BACKUP', '备份内容不符合 OpenAster v1–v9 数据格式或容量限制。');
const requireValue = condition => { if (!condition) throw invalid(); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function shape(value, allowed, required = allowed) {
  requireValue(object(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)));
}
function text(value, limit, { empty = true } = {}) {
  requireValue(typeof value === 'string' && value.isWellFormed() && !value.includes('\0') && value.length <= limit && (empty || value.trim().length > 0));
}
function id(value) { requireValue(typeof value === 'string' && ID.test(value)); }
function timestamp(value) { requireValue(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value); }
function optional(value, key, validate) { if (Object.hasOwn(value, key) && value[key] != null) validate(value[key]); }
function unique(values, field = 'id') { const ids = new Set(); for (const value of values) { requireValue(object(value) && Object.hasOwn(value, field) && !ids.has(value[field])); ids.add(value[field]); } return ids; }
function limitedArray(value, count) { requireValue(Array.isArray(value) && value.length <= count); }
function hashOrNull(value) { requireValue(value === null || (typeof value === 'string' && HASH.test(value))); }
function content(value, max = 256 * 1024) { text(value, max); requireValue(Buffer.byteLength(value) <= max); }
function safeRelative(value) {
  validateRelativePath(value);
  // These are application/credential containers, not ordinary workspace documents.
  const names = value.split('/').map(part => part.normalize('NFC').toLowerCase());
  requireValue(!names.some(name => /^(?:\.env(?:\..*)?|secrets|credentials(?:\..*)?|openaster\.sqlite(?:-.*)?|\.instance\.sqlite(?:-.*)?)$/.test(name) || name.endsWith('.secret')));
  return value;
}
const providerFields = ['id', 'name', 'type', 'model', 'baseUrl', 'enabled', 'tokenParameter', 'maxTokens', 'streaming', 'toolMode'];
function providerConfig(value, stripSecrets = false) {
  shape(value, [...providerFields, ...(stripSecrets ? ['apiKey', 'hasKey', 'envKey', 'credential', 'credentials'] : [])], ['id', 'name', 'type', 'model', 'baseUrl', 'enabled']);
  const clean = Object.fromEntries(providerFields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  id(clean.id); text(clean.name, 80, { empty: false }); requireValue(typeof clean.enabled === 'boolean');
  optional(clean, 'streaming', item => requireValue(typeof item === 'boolean'));
  optional(clean, 'maxTokens', item => requireValue(Number.isSafeInteger(item) && item >= 128 && item <= 16384));
  optional(clean, 'tokenParameter', item => requireValue(['max_tokens', 'max_completion_tokens'].includes(item)));
  if (Object.hasOwn(clean, 'toolMode')) requireValue(['workspace', 'none'].includes(clean.toolMode) && (clean.type !== 'demo' || clean.toolMode === 'workspace'));
  requireValue((clean.id === 'demo') === (clean.type === 'demo'));
  validateProvider({ ...clean, enabled: true });
  if (clean.type === 'demo') requireValue(clean.model === 'deterministic-demo' && clean.baseUrl === '');
  return clean;
}
function validateApproval(value, sessionId, version) {
  if (value?.tool === 'run_command') {
    requireValue(version >= 7);
    shape(value, ['id', 'sessionId', 'runId', 'tool', 'command', 'description', 'status', 'createdAt', 'resolvedAt', 'startedAt', 'archived', 'revoked'],
      ['id', 'sessionId', 'runId', 'tool', 'command', 'description', 'status', 'createdAt']);
    id(value.id); id(value.sessionId); id(value.runId); requireValue(value.sessionId === sessionId);
    requireValue(['pending', 'approved', 'denied'].includes(value.status)); text(value.description, 2000); timestamp(value.createdAt);
    try { validateCommand(value.command); } catch { throw invalid(); }
    if (Object.hasOwn(value, 'resolvedAt')) timestamp(value.resolvedAt);
    requireValue(value.status === 'pending' ? !Object.hasOwn(value, 'resolvedAt') : Object.hasOwn(value, 'resolvedAt'));
    if (Object.hasOwn(value, 'startedAt')) { timestamp(value.startedAt); requireValue(value.status === 'approved'); }
    if (Object.hasOwn(value, 'archived')) requireValue(value.archived === true && value.status !== 'pending');
    if (Object.hasOwn(value, 'revoked')) requireValue(value.revoked === true && value.status === 'denied' && !Object.hasOwn(value, 'startedAt'));
    return;
  }
  shape(value, ['id', 'sessionId', 'runId', 'tool', 'args', 'description', 'preview', 'status', 'createdAt', 'resolvedAt', 'appliedAt', 'archived', 'hashes', 'revoked'], ['id', 'status']);
  id(value.id); requireValue(['pending', 'approved', 'denied'].includes(value.status));
  if (value.status === 'pending') requireValue(value.appliedAt == null);
  optional(value, 'sessionId', item => { id(item); requireValue(item === sessionId); });
  optional(value, 'runId', id);
  if (Object.hasOwn(value, 'tool')) requireValue(['write_file', 'edit_file'].includes(value.tool));
  optional(value, 'description', item => text(item, 2000));
  for (const key of ['createdAt', 'resolvedAt', 'appliedAt']) optional(value, key, timestamp);
  optional(value, 'archived', item => requireValue(typeof item === 'boolean'));
  if (Object.hasOwn(value, 'revoked')) requireValue(value.revoked === true && value.status === 'denied' && value.appliedAt == null);
  if (value.args != null) { shape(value.args, ['path', 'content'], ['path']); validateOperationPath(value.args.path); if (!path.isAbsolute(value.args.path)) safeRelative(value.args.path); optional(value.args, 'content', content); }
  if (value.preview != null) {
    shape(value.preview, ['before', 'after', 'originalHash', 'newHash']);
    if (value.preview.before !== null) content(value.preview.before);
    content(value.preview.after); hashOrNull(value.preview.originalHash); hashOrNull(value.preview.newHash);
  }
  if (value.hashes != null) { shape(value.hashes, ['original', 'proposed']); hashOrNull(value.hashes.original); hashOrNull(value.hashes.proposed); }
}
function validateRun(run, session, historical = false, version = 6) {
    shape(run, ['id', 'status', 'steps', 'output', 'startedAt', 'finishedAt', 'error', 'connection', 'requestMessageId', 'requestPreview'], ['id', 'status']);
    id(run.id); requireValue((historical ? ['completed', 'failed', 'cancelled'] : ['running', 'awaiting_approval', 'completed', 'failed', 'cancelled']).includes(run.status));
    if (Object.hasOwn(run, 'connection')) {
      shape(run.connection, ['providerId', 'name', 'type', 'model', 'toolMode']);
      id(run.connection.providerId); text(run.connection.name, 100, { empty: false }); text(run.connection.model, 200, { empty: false });
      requireValue(PROVIDER_TYPES.includes(run.connection.type) && ['workspace', 'none'].includes(run.connection.toolMode));
      requireValue(run.connection.type !== 'demo' || run.connection.toolMode === 'workspace');
    }
    if (Object.hasOwn(run, 'requestMessageId')) {
      id(run.requestMessageId);
      requireValue(session.messages.some(message => message.id === run.requestMessageId && message.role === 'user'));
    }
    if (Object.hasOwn(run, 'requestPreview')) text(run.requestPreview, 240);
    for (const key of ['startedAt', 'finishedAt']) optional(run, key, timestamp);
    if (run.steps != null) {
      limitedArray(run.steps, 64);
      if (historical) unique(run.steps.filter(step => object(step) && Object.hasOwn(step, 'id')));
      else unique(run.steps);
      for (const step of run.steps) {
        shape(step, ['id', 'type', 'title', 'detail', 'status', 'createdAt', 'usage', 'finishedAt', 'phase', 'connection', 'publicSummary', 'publicSummaryTruncated', 'publicReasoning', 'interruptedOutputs', ...(version >= 4 ? ['toolResultRef', 'contextPlan'] : [])], historical ? [] : ['id', 'type', 'title', 'detail', 'status', 'createdAt']);
        if (Object.hasOwn(step, 'id')) id(step.id);
        if (Object.hasOwn(step, 'type')) requireValue(['model', 'tool'].includes(step.type));
        if (Object.hasOwn(step, 'status')) requireValue(['running', 'completed', 'failed', 'cancelled'].includes(step.status));
        if (Object.hasOwn(step, 'title')) text(step.title, historical ? BACKUP_LIMITS.sessionBytes : 512);
        if (Object.hasOwn(step, 'detail')) text(step.detail, historical ? BACKUP_LIMITS.sessionBytes : 4000);
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
          requireValue(step.type === 'model');
          shape(step.usage, usageFields);
          // Archives must already be canonical: never silently repair invalid or
          // inconsistent counters when restoring data supplied by another party.
          const normalized = sanitizeUsage(step.usage);
          requireValue(normalized !== null && usageFields.every(key => step.usage[key] === normalized[key]));
        }
      }
    }
    if (run.output != null) {
      shape(run.output, ['stepId', 'content', 'status', 'publicReasoning'], ['stepId', 'content', 'status']); id(run.output.stepId); content(run.output.content, historical ? BACKUP_LIMITS.sessionBytes : 256 * 1024); requireValue(['streaming', 'processing', 'interrupted'].includes(run.output.status));
      if (Object.hasOwn(run.output, 'publicReasoning')) { try { validatePublicOutput(run.output.publicReasoning); } catch { throw invalid(); } }
    }
    if (run.error != null) {
      if (typeof run.error === 'string') text(run.error, historical ? BACKUP_LIMITS.sessionBytes : 4000);
      else { shape(run.error, ['code', 'message']); text(run.error.code, historical ? BACKUP_LIMITS.sessionBytes : 100); text(run.error.message, historical ? BACKUP_LIMITS.sessionBytes : 4000); }
    }
}
function validateSession(value, providerIds, version) {
  const fields = ['id', 'title', 'providerId', 'createdAt', 'updatedAt', 'messages', 'approvals', 'run'];
  shape(value, [...fields, ...(version >= 5 ? ['branch'] : [])], fields);
  id(value.id); id(value.providerId); requireValue(providerIds.has(value.providerId));
  text(value.title, 160, { empty: false }); timestamp(value.createdAt); timestamp(value.updatedAt);
  limitedArray(value.messages, 201); limitedArray(value.approvals, 64);
  unique(value.messages); unique(value.approvals);
  for (const [index, message] of value.messages.entries()) {
    shape(message, ['id', 'role', 'content', 'createdAt', ...(version >= 3 ? ['contextFiles'] : []), ...(version >= 6 ? ['contextHandoff'] : []), ...(version >= 8 ? ['images'] : [])], ['id', 'role', 'content', 'createdAt']); id(message.id);
    requireValue(['user', 'assistant'].includes(message.role)); content(message.content); timestamp(message.createdAt);
    if(Object.hasOwn(message,'images')) { requireValue(message.role==='user'); try { validateImages(message.images); } catch { throw invalid(); } }
    if (Object.hasOwn(message, 'contextFiles')) {
      requireValue(message.role === 'user');
      try { validateContextFiles(message.contextFiles); } catch { throw invalid(); }
    }
    if (Object.hasOwn(message, 'contextHandoff')) {
      requireValue(index === 0 && message.role === 'user');
      try { validateContextHandoff(message.contextHandoff); } catch { throw invalid(); }
      requireValue(message.contextHandoff.sourceSessionId !== value.id);
    }
  }
  for (const approval of value.approvals) validateApproval(approval, value.id, version);
  if (Object.hasOwn(value, 'branch')) {
    try { validateBranchMetadata(value.branch); } catch { throw invalid(); }
    requireValue(value.branch.sourceSessionId !== value.id && value.branch.retainedMessages < value.messages.length);
    requireValue(value.messages[value.branch.retainedMessages].role === 'user' && value.branch.createdAt === value.createdAt);
  }
  if (value.run !== null) validateRun(value.run, value, false, version);
  requireValue(bytes(value) <= BACKUP_LIMITS.sessionBytes);
}
function validateRunHistory(record, sessions, version) {
  shape(record, ['sessionId', 'run', 'approvals']); id(record.sessionId);
  const session = sessions.get(record.sessionId); requireValue(Boolean(session));
  validateRun(record.run, session, true, version);
  limitedArray(record.approvals, 64); unique(record.approvals);
  for (const approval of record.approvals) {
    shape(approval, ['id', 'tool', 'path', 'status', 'createdAt', 'resolvedAt', 'appliedAt', 'originalHash', 'proposedHash', ...(approval.tool === 'run_command' ? ['command', 'startedAt'] : [])]);
    id(approval.id); requireValue(approval.tool === null || ['write_file', 'edit_file', ...(version >= 7 ? ['run_command'] : [])].includes(approval.tool));
    if (approval.path !== null) validateOperationPath(approval.path);
    requireValue(['approved', 'denied', 'revoked'].includes(approval.status));
    for (const key of ['createdAt', 'resolvedAt', 'appliedAt']) if (approval[key] !== null) timestamp(approval[key]);
    hashOrNull(approval.originalHash); hashOrNull(approval.proposedHash);
    if (approval.tool === 'run_command') {
      try { validateCommandHistory(approval.command); } catch { throw invalid(); }
      requireValue(['path', 'appliedAt', 'originalHash', 'proposedHash'].every(key => approval[key] === null));
      if (approval.startedAt !== null) { timestamp(approval.startedAt); requireValue(approval.status === 'approved'); }
    }
  }
  requireValue(bytes(record) <= BACKUP_LIMITS.sessionBytes);
}
function validatePayload(payload, version = 9) {
  shape(payload, ['createdAt', 'providers', 'sessions', 'audit', 'workspace', ...(version >= 2 ? ['runHistory'] : []), ...(version >= 4 ? ['toolArtifacts'] : []), ...(version >= 7 ? ['summaryJobs'] : []), ...(version >= 9 ? ['steeringInputs'] : [])]); timestamp(payload.createdAt);
  limitedArray(payload.providers, BACKUP_LIMITS.providers); limitedArray(payload.sessions, BACKUP_LIMITS.sessions);
  limitedArray(payload.audit, BACKUP_LIMITS.audit); limitedArray(payload.workspace, BACKUP_LIMITS.entries);
  const providerIds = unique(payload.providers); requireValue(providerIds.has('demo'));
  for (const provider of payload.providers) providerConfig(provider);
  unique(payload.sessions); for (const session of payload.sessions) validateSession(session, providerIds, version);
  unique(payload.sessions.flatMap(session => session.messages));
  unique(payload.sessions.flatMap(session => session.approvals));
  if (version === 1) {
    unique(payload.sessions.filter(session => session.run).map(session => session.run));
    unique(payload.sessions.flatMap(session => session.run?.steps ?? []));
  }
  if (version >= 2) {
    limitedArray(payload.runHistory, BACKUP_LIMITS.runHistory);
    const sessions = new Map(payload.sessions.map(session => [session.id, session])), seen = new Set();
    for (const record of payload.runHistory) {
      validateRunHistory(record, sessions, version);
      const key = `${record.sessionId}\0${record.run.id}`;
      requireValue(!seen.has(key)); seen.add(key);
      const current = sessions.get(record.sessionId).run;
      // The latest terminal run is intentionally also present in the session.
      // An active execution may never masquerade as already completed history.
      if (current?.id === record.run.id) {
        requireValue(['completed', 'failed', 'cancelled'].includes(current.status));
        requireValue(isDeepStrictEqual(record.run, createRunHistoryRecord(sessions.get(record.sessionId)).run));
      }
    }
  }
  if (version >= 4) {
    limitedArray(payload.toolArtifacts, BACKUP_LIMITS.toolArtifacts);
    const artifacts = new Map(), runs = new Map(), linked = new Set(); let total = 0;
    for (const source of payload.toolArtifacts) {
      let artifact; try { artifact = validateToolArtifact(source); } catch { throw invalid(); }
      const runKey = `${artifact.sessionId}\0${artifact.runId}`, key = `${runKey}\0${artifact.id}`;
      requireValue(!artifacts.has(key)); artifacts.set(key, artifact);
      const budget = runs.get(runKey) ?? { count: 0, bytes: 0 }; budget.count++; budget.bytes += artifact.bytes; total += artifact.bytes; runs.set(runKey, budget);
      requireValue(budget.count <= TOOL_ARTIFACT_LIMITS.maxPerRun && budget.bytes <= TOOL_ARTIFACT_LIMITS.runBytes && total <= TOOL_ARTIFACT_LIMITS.storeBytes);
    }
    for (const { sessionId, run } of [...payload.sessions.map(session => ({ sessionId: session.id, run: session.run })), ...payload.runHistory]) {
      if (!run) continue;
      const prefix = `${sessionId}\0${run.id}\0`;
      try {
        const refs = validateRunArtifactLinks(run, { sessionId, getArtifact: id => artifacts.get(prefix + id) });
        for (const id of refs?.keys() ?? []) linked.add(prefix + id);
      } catch { throw invalid(); }
    }
    requireValue(linked.size === artifacts.size);
  }
  if (version >= 7) {
    limitedArray(payload.summaryJobs, BACKUP_LIMITS.summaryJobs);
    const sessions = new Set(payload.sessions.map(session => session.id)), seen = new Set(), counts = new Map(); let total = 0;
    const runIds = new Set([...payload.sessions.filter(session => session.run).map(session => `${session.id}\0${session.run.id}`), ...payload.runHistory.map(record => `${record.sessionId}\0${record.run.id}`)]);
    for (const value of payload.summaryJobs) {
      let draft; try { draft = validateSummaryDraft(value); } catch { throw invalid(); }
      const key = `${draft.sessionId}\0${draft.id}`, count = (counts.get(draft.sessionId) ?? 0) + 1, size = bytes(draft);
      requireValue(sessions.has(draft.sessionId) && !seen.has(key) && !runIds.has(key)); seen.add(key); counts.set(draft.sessionId, count); total += size;
      requireValue(count <= SUMMARY_STORAGE_LIMITS.perSession && size <= SUMMARY_STORAGE_LIMITS.jobBytes && total <= SUMMARY_STORAGE_LIMITS.bytes);
    }
  }
  if (version >= 9) {
    limitedArray(payload.steeringInputs, STEERING_LIMITS.records);
    const sessions = new Map(payload.sessions.map(session => [session.id, session])), keys = new Set(), sequences = new Set(), counts = new Map(), sizes = new Map(); let total = 0;
    const runIds = new Set([...payload.sessions.filter(session => session.run).map(session => `${session.id}\0${session.run.id}`), ...payload.runHistory.map(record => `${record.sessionId}\0${record.run.id}`)]);
    for (const raw of payload.steeringInputs) {
      let value; try { value = validateSteeringRecord(raw); } catch { throw invalid(); }
      const session = sessions.get(value.sessionId), key = `${value.sessionId}\0${value.requestId}`, sequence = `${value.sessionId}\0${value.sequence}`;
      requireValue(session && !keys.has(key) && !sequences.has(sequence)); keys.add(key); sequences.add(sequence);
      const count = (counts.get(value.sessionId) ?? 0) + 1, size = (sizes.get(value.sessionId) ?? 0) + bytes(value); counts.set(value.sessionId, count); sizes.set(value.sessionId, size); total += bytes(value);
      requireValue(count <= STEERING_LIMITS.perSession && size <= STEERING_LIMITS.sessionBytes && total <= STEERING_LIMITS.bytes);
      if (value.status === 'consumed') {
        const message = session.messages.find(message => message.id === value.requestId);
        requireValue(runIds.has(`${value.sessionId}\0${value.runId}`) && message?.role === 'user' && message.content === value.content
          && isDeepStrictEqual(message.images ?? [], value.images) && isDeepStrictEqual(message.contextFiles ?? [], value.contextFiles));
      }
    }
  }
  unique(payload.audit);
  for (const entry of payload.audit) {
    shape(entry, ['id', 'time', 'action', 'detail', 'sessionId']);
    requireValue(Number.isSafeInteger(entry.id) && entry.id > 0); timestamp(entry.time); text(entry.action, 100); text(entry.detail, 2000);
    if (entry.sessionId !== null) id(entry.sessionId); // Deleted sessions remain in the audit trail.
  }
  let size = bytes(payload.providers) + bytes(payload.sessions) + bytes(payload.audit) + (version >= 2 ? bytes(payload.runHistory) : 0) + (version >= 4 ? bytes(payload.toolArtifacts) : 0) + (version >= 7 ? bytes(payload.summaryJobs) : 0) + (version >= 9 ? bytes(payload.steeringInputs) : 0);
  const paths = new Map();
  for (const entry of payload.workspace) {
    requireValue(object(entry));
    shape(entry, entry.type === 'file' ? ['path', 'type', 'bytes', 'sha256', 'content'] : ['path', 'type', 'sha256']);
    safeRelative(entry.path); requireValue(['file', 'directory'].includes(entry.type));
    const key = entry.path.normalize('NFC').toLowerCase();
    requireValue(!paths.has(key)); paths.set(key, entry);
    if (entry.type === 'file') {
      content(entry.content, BACKUP_LIMITS.fileBytes);
      requireValue(Number.isSafeInteger(entry.bytes) && entry.bytes === Buffer.byteLength(entry.content) && entry.sha256 === hash(entry.content));
      size += entry.bytes;
    } else requireValue(entry.sha256 === hash(`directory\0${entry.path}`));
    size += Buffer.byteLength(entry.path);
    requireValue(size <= BACKUP_LIMITS.logicalBytes);
  }
  for (const entry of payload.workspace) {
    const segments = entry.path.split('/');
    for (let count = 1; count < segments.length; count++) {
      const parent = segments.slice(0, count).join('/');
      const actual = paths.get(parent.normalize('NFC').toLowerCase());
      requireValue(actual?.type === 'directory' && actual.path === parent);
    }
  }
  requireValue(size <= BACKUP_LIMITS.logicalBytes);
  return payload;
}

const keyPath = value => (process.platform === 'win32' ? value.toLowerCase() : value).normalize('NFC');
const within = (parent, child) => { const relative = path.relative(keyPath(parent), keyPath(child)); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const overlap = (left, right) => within(left, right) || within(right, left);
const identity = stat => `${stat.dev}:${stat.ino}`;
const fingerprint = stat => `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value) || (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':')))) throw fail('UNSAFE_BACKUP_PATH', '请使用本机绝对路径，不允许网络路径、设备路径或备用数据流。');
  return path.resolve(value);
}
async function inspectAbsolute(value, kind, missing = false) {
  const target = absolute(value), parsed = path.parse(target);
  let cursor = parsed.root;
  const segments = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let position = -1; position < segments.length; position++) {
    if (position >= 0) cursor = path.join(cursor, segments[position]);
    let stat;
    try { stat = await fs.lstat(cursor, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT' && missing && position === segments.length - 1) return { path: path.join(await fs.realpath(path.dirname(target)), path.basename(target)), stat: null }; throw error; }
    const leaf = position === segments.length - 1;
    if (stat.isSymbolicLink() || (!leaf && !stat.isDirectory()) || (leaf && ((kind === 'directory' && !stat.isDirectory()) || (kind === 'file' && (!stat.isFile() || stat.nlink !== 1n))))) throw fail('UNSAFE_BACKUP_PATH', '路径包含链接、特殊文件或类型不符的节点。');
    if (leaf) return { path: await fs.realpath(cursor), stat };
  }
}
async function sameDirectory(root, original) {
  const current = await inspectAbsolute(root, 'directory');
  if (identity(current.stat) !== identity(original)) throw fail('SOURCE_CHANGED', '操作期间目录已被替换。');
}
function expectedIdentity(value) {
  if (value === undefined) return undefined;
  const invalid = () => fail('INVALID_BACKUP_OPTIONS', '备份目录身份必须包含规范路径及十进制 dev/ino 字符串。');
  let clean;
  try {
    if (!object(value) || Reflect.ownKeys(value).length !== 3) throw invalid();
    clean = {};
    for (const key of ['canonical', 'dev', 'ino']) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !Object.hasOwn(field, 'value')) throw invalid();
      clean[key] = field.value;
    }
    if (typeof clean.canonical !== 'string' || !clean.canonical.isWellFormed() || /[\0-\x1f\x7f]/u.test(clean.canonical)
      || clean.canonical.split(/[\\/]/u).includes('..') || !path.isAbsolute(clean.canonical)
      || ![clean.dev, clean.ino].every(part => typeof part === 'string' && /^(?:0|[1-9]\d{0,39})$/u.test(part)) || clean.ino === '0') throw invalid();
    clean.canonical = absolute(clean.canonical);
  } catch { throw invalid(); }
  return Object.freeze(clean);
}
const identityPath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
async function inspectBoundDirectory(location, expected) {
  let current;
  try { current = await inspectAbsolute(location, 'directory'); }
  catch (error) { if (expected && error.code === 'ENOENT') throw fail('SOURCE_CHANGED', '已绑定的备份目录不存在或已被替换。'); throw error; }
  if (expected && (identityPath(current.path) !== identityPath(expected.canonical)
    || String(current.stat.dev) !== expected.dev || String(current.stat.ino) !== expected.ino)) {
    throw fail('SOURCE_CHANGED', '备份目录身份与已注册工作区不符。');
  }
  return current;
}
function checkSensitivePath(relative) {
  if (relative.split(/[\\/]/u).some(isSensitiveSegment)) throw fail('SENSITIVE_PATH', '工作区包含禁止备份的敏感文件或目录；整个备份已拒绝。');
}
async function readBounded(file, limit, validateRoot) {
  await validateRoot?.();
  const before = await inspectAbsolute(file, 'file');
  if (before.stat.size > BigInt(limit)) throw fail('BACKUP_LIMIT', '文件或备份超过允许的容量限制。');
  const handle = await fs.open(before.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || fingerprint(opened) !== fingerprint(before.stat)) throw fail('SOURCE_CHANGED', '读取前文件已改变。');
    await validateRoot?.();
    const chunks = []; let size = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (!bytesRead) break;
      size += bytesRead; if (size > limit) throw fail('BACKUP_LIMIT', '读取内容超过允许的容量限制。');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    await validateRoot?.();
    const final = await inspectAbsolute(file, 'file');
    if (fingerprint(final.stat) !== fingerprint(opened) || fingerprint(await handle.stat({ bigint: true })) !== fingerprint(opened) || BigInt(size) !== opened.size) throw fail('SOURCE_CHANGED', '读取期间文件已改变。');
    const buffer = Buffer.concat(chunks, size);
    let decoded;
    try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); } catch { throw fail('UNSUPPORTED_BACKUP_FILE', '备份仅支持有效 UTF-8 文本；整个操作已拒绝。'); }
    if (buffer.includes(0)) throw fail('UNSUPPORTED_BACKUP_FILE', '备份不接受包含 NUL 的二进制文件；整个操作已拒绝。');
    return { content: decoded, sha256: hash(buffer), bytes: size, fingerprint: fingerprint(opened) };
  } finally { await handle.close(); }
}
async function workspaceSnapshot(root, budget, { validateRoot, denySensitivePaths = false } = {}) {
  await validateRoot?.();
  if (denySensitivePaths) checkSensitivePath(root);
  const original = await inspectAbsolute(root, 'directory');
  const entries = [], marks = new Map(), fileHashes = new Map(); let total = budget;
  async function namesIn(folder) {
    const names = [], directory = await fs.opendir(folder);
    for await (const item of directory) { names.push(item.name); if (names.length > BACKUP_LIMITS.entries) throw fail('BACKUP_LIMIT', '工作区目录项目数超过 10000。'); }
    return names.sort();
  }
  async function walk(relative) {
    await validateRoot?.();
    const folder = relative ? path.join(root, ...relative.split('/')) : root;
    const before = await inspectAbsolute(folder, 'directory');
    const names = await namesIn(folder);
    if (entries.length + names.length > BACKUP_LIMITS.entries) throw fail('BACKUP_LIMIT', '工作区项目数超过 10000。');
    marks.set(relative, { fingerprint: fingerprint(before.stat), names });
    for (const name of names) {
      await validateRoot?.();
      const child = relative ? `${relative}/${name}` : name;
      if (denySensitivePaths) checkSensitivePath(child);
      safeRelative(child);
      const file = path.join(folder, name); const stat = await fs.lstat(file, { bigint: true });
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1n)) throw fail('UNSAFE_BACKUP_PATH', '工作区包含链接或特殊文件；整个备份已拒绝。');
      if (++total > BACKUP_LIMITS.logicalBytes || entries.length >= BACKUP_LIMITS.entries) throw fail('BACKUP_LIMIT', '备份超过容量或项目数限制。');
      if (stat.isDirectory()) { entries.push({ path: child, type: 'directory', sha256: hash(`directory\0${child}`) }); await walk(child); }
      else {
        const value = await readBounded(file, BACKUP_LIMITS.fileBytes, validateRoot); total += value.bytes;
        if (total > BACKUP_LIMITS.logicalBytes) throw fail('BACKUP_LIMIT', '备份内容超过 64 MiB。');
        marks.set(child, value.fingerprint); fileHashes.set(child, value.sha256); entries.push({ path: child, type: 'file', bytes: value.bytes, sha256: value.sha256, content: value.content });
      }
    }
    const after = await inspectAbsolute(folder, 'directory');
    if (fingerprint(before.stat) !== fingerprint(after.stat)) throw fail('SOURCE_CHANGED', '扫描期间目录发生改变。');
  }
  await walk('');
  async function verify() {
    await validateRoot?.();
    await sameDirectory(root, original.stat);
    for (const [relative, mark] of marks) {
      const target = relative ? path.join(root, ...relative.split('/')) : root;
      if (typeof mark === 'string') {
        const value = await readBounded(target, BACKUP_LIMITS.fileBytes, validateRoot);
        if (value.fingerprint !== mark || value.sha256 !== fileHashes.get(relative)) throw fail('SOURCE_CHANGED', '快照期间工作区文件发生改变。');
      } else {
        const stat = (await inspectAbsolute(target, 'directory')).stat;
        const names = await namesIn(target);
        if (fingerprint(stat) !== mark.fingerprint || JSON.stringify(names) !== JSON.stringify(mark.names)) throw fail('SOURCE_CHANGED', '快照期间工作区目录发生改变。');
      }
    }
  }
  await verify(); return { entries, verify };
}
async function readLogicalData(dataDir, validateRoot) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const file = await inspectAbsolute(path.join(dataDir, `openaster.sqlite${suffix}`), 'file', suffix !== '');
    if (file.stat && file.stat.size > BigInt(BACKUP_LIMITS.sourceDatabaseBytes)) throw fail('BACKUP_LIMIT', '源数据库或边车文件超过 512 MiB 离线读取限制。');
  }
  await validateRoot?.();
  const db = new DatabaseSync(path.join(dataDir, 'openaster.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    // Usage is derived; schema 6 adds summary jobs, schema 7 the durable inbox.
    requireValue([1, 2, 3, 4, 5, 6, 7].includes(version));
    if (version >= 7) { try { validateSteeringTable(db); } catch { throw invalid(); } }
    for (const table of ['providers', 'sessions', 'audit', ...(version >= 2 ? ['run_history'] : []), ...(version >= 3 ? ['tool_artifacts'] : []), ...(version >= 6 ? ['summary_jobs'] : [])]) {
      const item = db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(table);
      requireValue(item?.type === 'table' && /^CREATE TABLE /i.test(item.sql) && !/\bVIRTUAL\b/i.test(item.sql));
    }
    if (version >= 2) {
      const columns = db.prepare("PRAGMA table_xinfo('run_history')").all();
      const names = ['session_id', 'run_id', 'started_at', 'summary_json', 'value'];
      requireValue(columns.length === names.length && columns.every((column, index) => column.name === names[index] && column.type.toUpperCase() === 'TEXT' && column.notnull === 1 && column.hidden === 0 && column.pk === (index < 2 ? index + 1 : 0)));
    }
    const artifactColumns = ['session_id', 'run_id', 'id', 'step_id', 'call_id', 'name', 'path', 'is_error', 'created_at', 'bytes', 'sha256', 'content'];
    if (version >= 3) {
      const columns = db.prepare("PRAGMA table_xinfo('tool_artifacts')").all();
      requireValue(columns.length === artifactColumns.length && columns.every((column, index) => column.name === artifactColumns[index]
        && column.type.toUpperCase() === (['is_error', 'bytes'].includes(column.name) ? 'INTEGER' : 'TEXT')
        && column.notnull === (column.name === 'path' ? 0 : 1) && column.hidden === 0 && column.pk === (index < 3 ? index + 1 : 0)));
    }
    const summaryColumns = ['session_id', 'id', 'created_at', 'status', 'value'];
    if (version >= 6) {
      const columns = db.prepare("PRAGMA table_xinfo('summary_jobs')").all();
      requireValue(columns.length === summaryColumns.length && columns.every((column, index) => column.name === summaryColumns[index]
        && column.type.toUpperCase() === 'TEXT' && column.notnull === 1 && column.hidden === 0 && column.pk === (index < 2 ? index + 1 : 0)));
      const keys = db.prepare("PRAGMA foreign_key_list('summary_jobs')").all();
      requireValue(keys.length === 1 && keys[0].table === 'sessions' && keys[0].from === 'session_id' && keys[0].to === 'id' && keys[0].on_delete === 'CASCADE');
    }
    let total = 0, artifactStorageBytes = 0;
    const tables = [['providers', ['id', 'value'], BACKUP_LIMITS.providers, 16384], ['sessions', ['id', 'updated_at', 'value'], BACKUP_LIMITS.sessions, BACKUP_LIMITS.sessionBytes + 200], ['audit', ['time', 'action', 'detail', 'session_id'], BACKUP_LIMITS.audit, 16000]];
    if (version >= 2) tables.push(['run_history', ['session_id', 'run_id', 'started_at', 'summary_json', 'value'], BACKUP_LIMITS.runHistory, BACKUP_LIMITS.sessionBytes + 4096]);
    if (version >= 3) tables.push(['tool_artifacts', artifactColumns, BACKUP_LIMITS.toolArtifacts, TOOL_ARTIFACT_LIMITS.maxBytes + 4096]);
    if (version >= 6) tables.push(['summary_jobs', summaryColumns, BACKUP_LIMITS.summaryJobs, SUMMARY_STORAGE_LIMITS.jobBytes + 400]);
    if (version >= 7) tables.push(['steering_inputs', STEERING_COLUMNS, STEERING_LIMITS.records, STEERING_LIMITS.recordBytes + 400]);
    for (const [table, columns, count, rowLimit] of tables) {
      const expression = columns.map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+');
      const size = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(${expression}),0) AS size, COALESCE(MAX(${expression}),0) AS largest FROM ${table}`).get();
      requireValue(size.n <= count && size.largest <= rowLimit); total += size.size; requireValue(total <= BACKUP_LIMITS.logicalBytes);
      if (table === 'tool_artifacts') artifactStorageBytes = size.size;
    }
    if (version >= 3) {
      requireValue(!db.prepare(`SELECT 1 FROM tool_artifacts WHERE typeof(content)<>'text'
        OR typeof(bytes)<>'integer' OR bytes<1 OR bytes>${TOOL_ARTIFACT_LIMITS.maxBytes}
        OR length(CAST(content AS BLOB))>${TOOL_ARTIFACT_LIMITS.maxBytes} LIMIT 1`).get());
      const expression = "json_object('id',id,'sessionId',session_id,'runId',run_id,'stepId',step_id,'callId',call_id,'name',name,'path',path,'isError',json(CASE WHEN is_error=1 THEN 'true' ELSE 'false' END),'createdAt',created_at,'bytes',bytes,'sha256',sha256,'content',content)";
      const serialized = db.prepare(`SELECT COALESCE(SUM(length(CAST(${expression} AS BLOB))),0) AS bytes FROM tool_artifacts`).get();
      total += serialized.bytes - artifactStorageBytes;
      requireValue(total <= BACKUP_LIMITS.logicalBytes);
    }
    const decode = value => { requireValue(value instanceof Uint8Array); try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value); } catch { throw invalid(); } };
    const parse = value => { try { return JSON.parse(decode(value)); } catch { throw invalid(); } };
    const providers = db.prepare('SELECT id,CAST(value AS BLOB) AS value FROM providers ORDER BY id').all().map(row => { const value = providerConfig(parse(row.value), true); requireValue(value.id === row.id); return value; });
    const sessions = db.prepare('SELECT id,updated_at,CAST(value AS BLOB) AS value FROM sessions ORDER BY id').all().map(row => { const value = parse(row.value); requireValue(value.id === row.id && value.updatedAt === row.updated_at); return value; });
    const audit = db.prepare('SELECT id,CAST(time AS BLOB) AS time,CAST(action AS BLOB) AS action,CAST(detail AS BLOB) AS detail,session_id AS sessionId FROM audit ORDER BY id').all().map(row => ({ ...row, time: decode(row.time), action: decode(row.action), detail: decode(row.detail) }));
    const runHistory = version === 1 ? sessions.map(createRunHistoryRecord).filter(Boolean) : db.prepare('SELECT session_id,run_id,started_at,CAST(summary_json AS BLOB) AS summary,CAST(value AS BLOB) AS value FROM run_history ORDER BY session_id,started_at,run_id').all().map(row => {
      const value = parse(row.value);
      try { validateRunHistoryRecord(value); } catch { throw invalid(); }
      requireValue(value?.sessionId === row.session_id && value.run?.id === row.run_id && (value.run.startedAt ?? '') === row.started_at);
      requireValue(isDeepStrictEqual(parse(row.summary), summarizeRunHistory(value)));
      return value;
    });
    const toolArtifacts = version < 3 ? [] : db.prepare(`SELECT ${artifactColumns.map(column => ['is_error', 'bytes'].includes(column) ? column : `CAST(${column} AS BLOB) AS ${column}`).join(',')} FROM tool_artifacts ORDER BY session_id,run_id,id`).all().map(row => {
      requireValue(row.is_error === 0 || row.is_error === 1);
      const value = { id: decode(row.id), sessionId: decode(row.session_id), runId: decode(row.run_id), stepId: decode(row.step_id), callId: decode(row.call_id), name: decode(row.name), path: row.path === null ? null : decode(row.path), isError: row.is_error === 1, createdAt: decode(row.created_at), bytes: row.bytes, sha256: decode(row.sha256), content: decode(row.content) };
      try { return validateToolArtifact(value); } catch { throw invalid(); }
    });
    const summaryJobs = version < 6 ? [] : db.prepare('SELECT session_id,id,created_at,status,CAST(value AS BLOB) AS value FROM summary_jobs ORDER BY session_id,created_at,id').all().map(row => {
      let draft; try { draft = validateSummaryDraft(parse(row.value)); } catch { throw invalid(); }
      requireValue(draft.sessionId === row.session_id && draft.id === row.id && draft.createdAt === row.created_at && draft.status === row.status);
      return draft;
    });
    const steeringInputs = version < 7 ? [] : db.prepare('SELECT session_id,request_id,sequence,status,CAST(value AS BLOB) AS value FROM steering_inputs ORDER BY session_id,sequence').all().map(row => {
      let value; try { value = validateSteeringRecord(parse(row.value)); } catch { throw invalid(); }
      requireValue(value.sessionId === row.session_id && value.requestId === row.request_id && value.sequence === row.sequence && value.status === row.status); return value;
    });
    return { providers, sessions, audit, runHistory, toolArtifacts, summaryJobs, steeringInputs };
  } finally { db.close(); }
}
async function unlinkOwned(file, original, root, rootIdentity) {
  if (root) await sameDirectory(root, rootIdentity);
  const current = await inspectAbsolute(file, 'file', true);
  if (current.stat && identity(current.stat) === identity(original)) await fs.unlink(file);
  else if (current.stat) throw fail('CLEANUP_REFUSED', '清理路径已被替换，已保留现场。');
}

export async function createBackup({ dataDir, output, workspace = path.join(dataDir, 'workspace'), expectedWorkspaceIdentity, expectedDataIdentity, denySensitivePaths = false }) {
  if (typeof denySensitivePaths !== 'boolean') throw fail('INVALID_BACKUP_OPTIONS', 'denySensitivePaths 必须为布尔值。');
  const expectedWork = expectedIdentity(expectedWorkspaceIdentity), expectedData = expectedIdentity(expectedDataIdentity);
  if (denySensitivePaths) checkSensitivePath(absolute(workspace));
  const source = await inspectBoundDirectory(dataDir, expectedData);
  const work = await inspectBoundDirectory(workspace, expectedWork);
  const validateRoot = async () => {
    const currentData = await inspectBoundDirectory(source.path, expectedData);
    const currentWork = await inspectBoundDirectory(work.path, expectedWork);
    if (identity(currentData.stat) !== identity(source.stat) || identity(currentWork.stat) !== identity(work.stat)) throw fail('SOURCE_CHANGED', '备份期间数据或工作区目录已被替换。');
  };
  const target = await inspectAbsolute(output, 'file', true);
  if (target.stat) throw fail('BACKUP_EXISTS', '备份输出已存在；不会覆盖。');
  if (within(work.path, source.path) || (within(source.path, work.path) && !within(path.join(source.path, 'workspace'), work.path)) || within(source.path, target.path) || within(work.path, target.path)) throw fail('UNSAFE_BACKUP_PATH', '源数据、工作区和输出路径存在不安全重叠。');
  const outputParent = await inspectAbsolute(path.dirname(target.path), 'directory');
  let release, handle, owned;
  try {
    await validateRoot();
    release = await acquireDataLock(source.path);
    const logical = await readLogicalData(source.path, validateRoot);
    const snapshot = await workspaceSnapshot(work.path, bytes(logical), { validateRoot, denySensitivePaths });
    const payload = validatePayload({ createdAt: new Date().toISOString(), ...logical, workspace: snapshot.entries });
    const envelope = { format: 'openaster-backup', version: 9, payload, sha256: hash(JSON.stringify(payload)) };
    const serialized = JSON.stringify(envelope);
    if (Buffer.byteLength(serialized) > BACKUP_LIMITS.archiveBytes) throw fail('BACKUP_LIMIT', 'JSON 备份超过 128 MiB。');
    await sameDirectory(source.path, source.stat); await snapshot.verify();
    await sameDirectory(outputParent.path, outputParent.stat);
    handle = await fs.open(target.path, 'wx', 0o600); owned = await handle.stat({ bigint: true });
    await handle.writeFile(serialized, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    await snapshot.verify(); await sameDirectory(source.path, source.stat);
    const finished = await inspectAbsolute(target.path, 'file');
    if (identity(finished.stat) !== identity(owned)) throw fail('SOURCE_CHANGED', '备份输出在写入期间被替换。');
    return { path: target.path, sha256: hash(serialized), payloadSha256: envelope.sha256, bytes: Buffer.byteLength(serialized), sessions: payload.sessions.length, runHistory: payload.runHistory.length, toolArtifacts: payload.toolArtifacts.length, summaryJobs: payload.summaryJobs.length, steeringInputs: payload.steeringInputs.length, audit: payload.audit.length, workspaceEntries: payload.workspace.length };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (owned) {
      try { await unlinkOwned(target.path, owned, outputParent.path, outputParent.stat); }
      catch { throw fail('BACKUP_CLEANUP_INCOMPLETE', '备份失败，输出路径发生变化或无法清理；已保留现场，请手动检查。'); }
    }
    throw error;
  } finally { await release?.(); }
}

function stoppedSession(value, now) {
  const result = structuredClone(value);
  for (const approval of result.approvals) if (approval.status === 'pending') { approval.status = 'denied'; approval.resolvedAt = now; approval.revoked = true; }
  if (result.run) {
    if (['running', 'awaiting_approval'].includes(result.run.status)) {
      result.run.status = 'cancelled'; result.run.finishedAt = now;
      result.run.error = { code: 'BACKUP_RESTORED', message: '任务来自离线备份，已安全停止；请重新发送消息。' };
      for (const step of result.run.steps ?? []) if (step.status === 'running') { step.status = 'cancelled'; step.finishedAt = now; if (step.type === 'model') step.phase = 'cancelled'; }
      if (result.run.output) result.run.output.status = 'interrupted';
    }
  }
  return result;
}
export async function restoreBackup({ input, dataDir }) {
  const source = await inspectAbsolute(input, 'file');
  const target = await inspectAbsolute(dataDir, 'directory', true);
  if (target.stat) throw fail('RESTORE_EXISTS', '恢复目标必须是尚不存在的新目录；不会覆盖。');
  if (overlap(source.path, target.path)) throw fail('UNSAFE_BACKUP_PATH', '备份输入与恢复目标不能重叠。');
  const parent = await inspectAbsolute(path.dirname(target.path), 'directory');
  const data = await readBounded(source.path, BACKUP_LIMITS.archiveBytes);
  let envelope;
  try { envelope = JSON.parse(data.content); } catch { throw invalid(); }
  shape(envelope, ['format', 'version', 'payload', 'sha256']);
    requireValue(envelope.format === 'openaster-backup' && [1, 2, 3, 4, 5, 6, 7, 8, 9].includes(envelope.version) && typeof envelope.sha256 === 'string' && HASH.test(envelope.sha256));
  if (hash(JSON.stringify(envelope.payload)) !== envelope.sha256) throw fail('BACKUP_HASH_MISMATCH', '备份 payload SHA256 不匹配；没有恢复任何内容。');
  const payload = validatePayload(envelope.payload, envelope.version);
  let rootStat, release, store, restoredHistoryCount = 0;
  const owned = new Map();
  async function remember(file, kind = 'file') { const item = await inspectAbsolute(file, kind); owned.set(file, { kind, stat: item.stat }); }
  async function reserve(file) {
    const handle = await fs.open(file, 'wx', 0o600);
    try { owned.set(file, { kind: 'file', stat: await handle.stat({ bigint: true }) }); } finally { await handle.close(); }
  }
  function captureCreatedSidecars(names) {
    // Call immediately after the operation that creates them, never during failure cleanup.
    for (const name of names) {
      const file = path.join(target.path, name); let stat;
      try { stat = lstatSync(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw fail('UNSAFE_BACKUP_PATH', '新数据库边车文件不安全。');
      owned.set(file, { kind: 'file', stat });
    }
  }
  async function cleanup() {
    if (!rootStat) return;
    await sameDirectory(target.path, rootStat);
    for (const [file, item] of [...owned].reverse()) {
      await sameDirectory(target.path, rootStat);
      try {
        if (item.kind === 'file') await unlinkOwned(file, item.stat, target.path, rootStat);
        else { const current = await inspectAbsolute(file, 'directory'); if (identity(current.stat) !== identity(item.stat)) throw fail('CLEANUP_REFUSED', '恢复目录已被替换。'); await fs.rmdir(file); }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await sameDirectory(target.path, rootStat); await fs.rmdir(target.path);
  }
  try {
    await sameDirectory(parent.path, parent.stat);
    await fs.mkdir(target.path, { mode: 0o700 }); rootStat = (await inspectAbsolute(target.path, 'directory')).stat;
    await reserve(path.join(target.path, '.instance.sqlite'));
    release = await acquireDataLock(target.path);
    captureCreatedSidecars(['.instance.sqlite-journal', '.instance.sqlite-wal', '.instance.sqlite-shm']);
    await reserve(path.join(target.path, 'openaster.sqlite'));
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const found = await inspectAbsolute(path.join(target.path, `openaster.sqlite${suffix}`), 'file', true);
      if (found.stat) throw fail('UNSAFE_BACKUP_PATH', '恢复过程中出现非本次创建的数据库边车文件。');
    }
    store = new Store(target.path);
    captureCreatedSidecars(['openaster.sqlite-wal', 'openaster.sqlite-shm', 'openaster.sqlite-journal']);
    const work = path.join(target.path, 'workspace'); await fs.mkdir(work, { mode: 0o700 }); await remember(work, 'directory');
    const ordered = [...payload.workspace].sort((left, right) => left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path));
    for (const entry of ordered) {
      await sameDirectory(target.path, rootStat);
      const file = path.join(work, ...entry.path.split('/'));
      await inspectAbsolute(file, entry.type === 'directory' ? 'directory' : 'file', true);
      if (entry.type === 'directory') { await fs.mkdir(file, { mode: 0o700 }); await remember(file, 'directory'); }
      else {
        const handle = await fs.open(file, 'wx', 0o600);
        owned.set(file, { kind: 'file', stat: await handle.stat({ bigint: true }) });
        try { await handle.writeFile(entry.content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      }
    }
    const restoredFiles = await workspaceSnapshot(work, 0);
    const expectedEntries = new Map(payload.workspace.map(entry => [entry.path, entry]));
    requireValue(restoredFiles.entries.length === expectedEntries.size && restoredFiles.entries.every(entry => entry.sha256 === expectedEntries.get(entry.path)?.sha256));
    store.db.exec('BEGIN IMMEDIATE; DELETE FROM steering_inputs; DELETE FROM summary_jobs; DELETE FROM tool_artifacts; DELETE FROM run_history; DELETE FROM providers; DELETE FROM sessions; DELETE FROM audit;');
    try {
      for (const provider of payload.providers) store.putProvider({ ...provider, enabled: provider.type === 'demo' });
      const now = new Date().toISOString();
      const byRun = new Map();
      for (const artifact of payload.toolArtifacts ?? []) {
        const key = `${artifact.sessionId}\0${artifact.runId}`;
        if (!byRun.has(key)) byRun.set(key, []);
        byRun.get(key).push(artifact);
      }
      for (const session of payload.sessions) store.putSession(stoppedSession(session, now), { artifacts: byRun.get(`${session.id}\0${session.run?.id}`) ?? [] });
      // putSession may backfill the latest terminal run. Explicit archive records
      // are authoritative and replace that projection once, within this transaction.
      for (const record of payload.runHistory ?? []) store.putRunHistory(record, { artifacts: byRun.get(`${record.sessionId}\0${record.run.id}`) ?? [] });
      for (const draft of payload.summaryJobs ?? []) store.putSummaryDraft(interruptSummaryDraft(draft, { code: 'BACKUP_RESTORED', message: '摘要草稿已从备份恢复；中断的请求不会自动重新发送。' }));
      for (const value of payload.steeringInputs ?? []) store.steeringInbox.import(value.status === 'pending' ? { ...value, status: 'failed', error: { code: 'BACKUP_RESTORED', message: '追加消息已从备份恢复且尚未处理，请明确重新发送；不会自动执行。' } } : value);
      const insert = store.db.prepare('INSERT INTO audit(id,time,action,detail,session_id) VALUES(?,?,?,?,?)');
      for (const entry of payload.audit) insert.run(entry.id, entry.time, entry.action, entry.detail, entry.sessionId);
      restoredHistoryCount = store.db.prepare('SELECT COUNT(*) AS n FROM run_history').get().n;
      store.db.exec('COMMIT;');
    } catch (error) { store.db.exec('ROLLBACK;'); throw error; }
    store.close(); store = null;
    await sameDirectory(target.path, rootStat);
    await release(); release = null;
    return { path: target.path, sessions: payload.sessions.length, runHistory: restoredHistoryCount, toolArtifacts: payload.toolArtifacts?.length ?? 0, summaryJobs: payload.summaryJobs?.length ?? 0, steeringInputs: payload.steeringInputs?.length ?? 0, audit: payload.audit.length, workspaceEntries: payload.workspace.length, disabledProviders: payload.providers.filter(value => value.type !== 'demo').length };
  } catch (error) {
    // If a second process claimed our newly visible directory before us, its OS lock
    // must remain intact. Unlinking a locked inode is possible on POSIX.
    if (rootStat && error.code === 'DATA_LOCKED') throw fail('RESTORE_CLEANUP_INCOMPLETE', '另一实例抢先占用新恢复目录，已保留目录和锁；请关闭该实例后手动检查。');
    try { store?.close(); } catch {}
    try { await release?.(); } catch {}
    try { await cleanup(); } catch { throw fail('RESTORE_CLEANUP_INCOMPLETE', '恢复失败，部分新建路径发生变化或无法清理；已停止，请手动检查新目标目录。'); }
    if (error.code === 'EEXIST') throw fail('RESTORE_EXISTS', '恢复目标已存在；没有覆盖。');
    throw error;
  }
}
