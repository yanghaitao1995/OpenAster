import { validateImages } from '../core/image-attachments.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreError } from '../core/errors.mjs';
import { createRunHistoryRecord, validateRunHistoryRecord, summarizeRunHistory, validateRunArtifactLinks } from '../core/run-history.mjs';
import { validateToolArtifact, TOOL_ARTIFACT_LIMITS } from '../core/tool-artifacts.mjs';
import { isDeepStrictEqual } from 'node:util';
import { createUsageProjection, emptyUsageStats, mergeUsageStats, parseUsageStats, USAGE_OVERVIEW_LIMITS } from '../core/usage-overview.mjs';
import { validateBranchMetadata } from '../core/conversation-branch.mjs';
import { validateContextHandoff } from '../core/conversation-handoff.mjs';
import { validateSummaryDraft, interruptSummaryDraft } from '../core/summary-draft.mjs';

export const SUMMARY_STORAGE_LIMITS = Object.freeze({ jobBytes: 2 * 1024 * 1024, perSession: 100, jobs: 1000, bytes: 128 * 1024 * 1024 });
const summaryConflict = () => new CoreError('SUMMARY_JOB_ID_CONFLICT', '摘要草稿标识与已有记录冲突。', 409);
const summaryImmutable = () => new CoreError('SUMMARY_JOB_IMMUTABLE', '已保存的摘要草稿来源、计划或结果不能改写。', 409);
const summaryLimit = () => new CoreError('SUMMARY_JOB_LIMIT', '摘要草稿数量或存储空间已达上限，请导出并删除旧来源任务。', 413);
const summarySchema = () => new CoreError('INVALID_SUMMARY_JOBS', '摘要草稿表缺失或结构无效，请保留数据并检查数据库。', 503);
const summaryColumns = ['session_id', 'id', 'created_at', 'status', 'value'];
function validateSummaryTable(db) {
  const table = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name='summary_jobs'").get();
  if (table?.type !== 'table' || !/^CREATE TABLE /iu.test(table.sql) || /\bVIRTUAL\b/iu.test(table.sql)) throw summarySchema();
  const columns = db.prepare("PRAGMA table_xinfo('summary_jobs')").all();
  if (columns.length !== summaryColumns.length || !columns.every((column, index) => column.name === summaryColumns[index] && column.type.toUpperCase() === 'TEXT'
    && column.notnull === 1 && column.hidden === 0 && column.pk === (index < 2 ? index + 1 : 0))) throw summarySchema();
  const keys = db.prepare("PRAGMA foreign_key_list('summary_jobs')").all();
  if (keys.length !== 1 || keys[0].table !== 'sessions' || keys[0].from !== 'session_id' || keys[0].to !== 'id' || keys[0].on_delete !== 'CASCADE') throw summarySchema();
  const budget = db.prepare(`SELECT count(*) AS count, COALESCE(MAX(length(CAST(value AS BLOB))),0) AS largest,
    COALESCE(SUM(CASE WHEN status='running' THEN ? ELSE length(CAST(value AS BLOB)) END),0) AS bytes FROM summary_jobs`).get(SUMMARY_STORAGE_LIMITS.jobBytes);
  if (budget.count > SUMMARY_STORAGE_LIMITS.jobs || budget.largest > SUMMARY_STORAGE_LIMITS.jobBytes || budget.bytes > SUMMARY_STORAGE_LIMITS.bytes
    || db.prepare('SELECT 1 FROM summary_jobs GROUP BY session_id HAVING count(*)>? LIMIT 1').get(SUMMARY_STORAGE_LIMITS.perSession)) throw summarySchema();
}
function summaryProgress(previous, next) {
  for (const key of ['version', 'id', 'sessionId', 'requestHash', 'connection', 'preview', 'createdAt']) if (!isDeepStrictEqual(previous[key], next[key])) throw summaryImmutable();
  if (previous.status !== 'running') { if (!isDeepStrictEqual(previous, next)) throw summaryImmutable(); return; }
  if (next.steps.length < previous.steps.length) throw summaryImmutable();
  for (const [index, step] of previous.steps.entries()) {
    const value = next.steps[index];
    if (step.status !== 'running') { if (!isDeepStrictEqual(step, value)) throw summaryImmutable(); continue; }
    for (const key of ['id', 'type', 'stage', 'partIndex', 'startedAt', 'requestBytes', 'requestSha256']) if (!isDeepStrictEqual(step[key], value[key])) throw summaryImmutable();
    for (const key of ['usage', 'output', 'outputHash', 'error']) if (step[key] !== null && !isDeepStrictEqual(step[key], value[key])) throw summaryImmutable();
  }
}

const ARTIFACT_COLUMNS = 'session_id,run_id,id,step_id,call_id,name,path,is_error,created_at,bytes,sha256,content';
const ARTIFACT_METADATA = 'session_id,run_id,id,step_id,call_id,name,path,is_error,created_at,bytes,sha256';
const artifactJson = "json_object('id',id,'sessionId',session_id,'runId',run_id,'stepId',step_id,'callId',call_id,'name',name,'path',path,'isError',json(CASE WHEN is_error=1 THEN 'true' ELSE 'false' END),'createdAt',created_at,'bytes',bytes,'sha256',sha256,'content',content)";
const artifactFromRow = row => row ? { id: row.id, sessionId: row.session_id, runId: row.run_id, stepId: row.step_id, callId: row.call_id, name: row.name, path: row.path, isError: row.is_error === 1, createdAt: row.created_at, bytes: row.bytes, sha256: row.sha256, ...(Object.hasOwn(row, 'content') ? { content: row.content } : {}) } : null;
const artifactLimit = () => new CoreError('TOOL_ARTIFACT_LIMIT', '工具结果归档空间已达上限，请导出并删除旧任务或缩小操作范围。', 413);
const invalidArtifact = () => new CoreError('INVALID_TOOL_ARTIFACT', '工具结果归档或执行关联无效。');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(value);

function sessionHandoff(session) {
  let result;
  for (const [index, message] of (session.messages ?? []).entries()) {
    if (!message || typeof message !== 'object' || !Object.hasOwn(message, 'contextHandoff')) continue;
    const descriptor = Object.getOwnPropertyDescriptor(message, 'contextHandoff');
    if (index !== 0 || message.role !== 'user' || !validId(message.id) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new CoreError('INVALID_CONTEXT_HANDOFF', '交接摘要只能保存在首条用户消息中。');
    const value = validateContextHandoff(descriptor.value);
    if (value.sourceSessionId === session.id) throw new CoreError('INVALID_CONTEXT_HANDOFF', '交接来源不能指向当前任务。');
    result = { messageId: message.id, value };
  }
  return result;
}

function invalidCursor() { return new CoreError('INVALID_CURSOR', '执行历史分页位置无效，请重新加载。'); }
function encodeCursor(sessionId, row) {
  return Buffer.from(JSON.stringify({ sessionId, startedAt: row.started_at, id: row.run_id })).toString('base64url');
}
function decodeCursor(cursor, sessionId) {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw invalidCursor();
  let value;
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw invalidCursor(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.sessionId !== sessionId || typeof value.startedAt !== 'string' || typeof value.id !== 'string'
    || encodeCursor(sessionId, { started_at: value.startedAt, run_id: value.id }) !== cursor) throw invalidCursor();
  return value;
}

/** SQLite is confined to the trusted process. Secrets never enter this database. */
export class Store {
  #artifactReservations = new Map();
  #usageSummary;
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    for(const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        const info=lstatSync(join(dataDir,`openaster.sqlite${suffix}`));
        if(!info.isFile()||info.isSymbolicLink()||info.nlink>1)throw Object.assign(new Error('数据库路径不安全。'),{code:'UNSAFE_DATA_DIR',status:403});
      }catch(error){if(error.code!=='ENOENT')throw error;}
    }
    this.db = new DatabaseSync(join(dataDir, 'openaster.sqlite'));
    this.savepointSequence = 0;
    try {
      // A newer application may own this file. Reject before any writable pragma
      // or schema operation, rather than silently downgrading its version.
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (![0, 1, 2, 3, 4, 5, 6].includes(version)) throw new CoreError('UNSUPPORTED_DATABASE_VERSION', '此数据库由更新版本创建，请使用兼容的应用版本。', 503);
      if (version >= 6) validateSummaryTable(this.db);
      if (version >= 4 && (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='usage_runs'").get()
        || !this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='usage_meta'").get())) throw new CoreError('INVALID_USAGE_PROJECTION', '用量投影表缺失，请保留数据并检查数据库。', 503);
      this.db.aggregate('openaster_usage_stats', { start: emptyUsageStats,
        step: (state, value) => mergeUsageStats(state, parseUsageStats(value)), result: state => JSON.stringify(state) });
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      this.transaction(() => {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, session_id TEXT);
      CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC);
      CREATE TABLE IF NOT EXISTS run_history (
        session_id TEXT NOT NULL, run_id TEXT NOT NULL, started_at TEXT NOT NULL,
        summary_json TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(session_id,run_id),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS run_history_order ON run_history(session_id,started_at DESC,run_id DESC);
      CREATE TABLE IF NOT EXISTS tool_artifacts (
        session_id TEXT NOT NULL, run_id TEXT NOT NULL, id TEXT NOT NULL, step_id TEXT NOT NULL,
        call_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT, is_error INTEGER NOT NULL,
        created_at TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, content TEXT NOT NULL,
        PRIMARY KEY(session_id,run_id,id), FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS usage_runs (
        session_id TEXT NOT NULL, run_id TEXT NOT NULL, source TEXT NOT NULL,
        group_key TEXT NOT NULL, connection_json TEXT NOT NULL, stats_json TEXT NOT NULL,
        PRIMARY KEY(session_id,run_id), FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS usage_runs_groups ON usage_runs(group_key,session_id,run_id);
      CREATE TABLE IF NOT EXISTS summary_jobs (
        session_id TEXT NOT NULL, id TEXT NOT NULL, created_at TEXT NOT NULL,
        status TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(session_id,id), FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS summary_jobs_order ON summary_jobs(session_id,created_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS usage_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL, identity TEXT NOT NULL);`);
        if (version < 4) this.db.prepare("INSERT OR IGNORE INTO usage_meta(id,revision,identity) VALUES(1,'0',?)").run(randomUUID());
        this.#usageRevision();
        if (!this.db.prepare('SELECT id FROM providers LIMIT 1').get()) this.putProvider({ id: 'demo', name: '本地演示', type: 'demo', model: 'deterministic-demo', baseUrl: '', enabled: true });
        // Only migrations backfill terminal current runs. An explicit imported
        // history record must not be overwritten on every ordinary restart.
        if (version < 2) {
          for (const { value } of this.db.prepare("SELECT value FROM sessions WHERE json_extract(value,'$.run.status') IN ('completed','failed','cancelled')").iterate()) {
            this.putRunHistory(createRunHistoryRecord(JSON.parse(value)));
          }
        }
        // A restart cannot resume an external request or an approval. Preserve
        // interrupted output and distinguish revoked consent from user denial.
        for (const { value } of this.db.prepare("SELECT value FROM sessions WHERE json_extract(value,'$.run.status') IN ('running','awaiting_approval')").all()) {
          const session = JSON.parse(value);
          const stoppedAt = new Date().toISOString();
          session.run.status = 'cancelled';
          session.run.finishedAt = stoppedAt;
          session.updatedAt = stoppedAt;
          session.run.error = '服务已重启，任务已安全停止。请重新发送消息。';
          if (session.run.output) session.run.output.status = 'interrupted';
          for (const step of session.run.steps || []) if (step.status === 'running') { step.status = 'cancelled'; step.finishedAt = stoppedAt; if (step.type === 'model') step.phase = 'cancelled'; }
          for (const approval of session.approvals || []) if (approval.status === 'pending') {
            approval.status = 'denied'; approval.revoked = true; approval.resolvedAt = stoppedAt;
          }
          this.putSession(session);
        }
        if (version < 4) {
          // Derived data is rebuilt from canonical records, one bounded record at
          // a time. History wins over a duplicate current run, including imports.
          this.db.exec('DELETE FROM usage_runs;');
          for (const { value } of this.db.prepare('SELECT value FROM run_history').iterate()) {
            const record = validateRunHistoryRecord(JSON.parse(value));
            this.#putUsage(record.sessionId, record.run, 'history');
          }
          for (const { id, run } of this.db.prepare("SELECT id,json_extract(value,'$.run') AS run FROM sessions WHERE json_type(value,'$.run')='object'").iterate()) this.#putUsage(id, JSON.parse(run), 'current');
        }
        // Interrupted summary requests have an uncertain remote billing outcome.
        // Their durable receipt is cancelled in place; opening never sends again.
        for (const row of this.db.prepare("SELECT session_id,id,created_at,status,value FROM summary_jobs WHERE status='running'").all()) {
          const value = this.#summaryFromRow(row);
          this.putSummaryDraft(interruptSummaryDraft(value, { code: 'SERVICE_RESTARTED', message: '服务已重启，摘要生成已停止；已发出的请求可能已产生用量，请勿自动重试。' }));
        }
        // Version 6 protects independent summary receipts and their usage from
        // older writers. It does not rewrite ordinary task or run history data.
        this.db.exec('PRAGMA user_version=6;');
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  transaction(action) {
    const name = `openaster_store_${++this.savepointSequence}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = action();
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);
      throw error;
    }
  }
  listProviders() { return this.db.prepare('SELECT value FROM providers ORDER BY rowid').all().map(row => JSON.parse(row.value)); }
  getProvider(id) { const row = this.db.prepare('SELECT value FROM providers WHERE id=?').get(id); return row ? JSON.parse(row.value) : null; }
  putProvider(provider) {
    const { apiKey, hasKey, ...safe } = provider;
    this.db.prepare('INSERT OR REPLACE INTO providers(id,value) VALUES(?,?)').run(safe.id, JSON.stringify(safe));
    return safe;
  }
  deleteProvider(id) { this.db.prepare('DELETE FROM providers WHERE id=?').run(id); }
  reassignProvider(previous,next) { this.db.prepare("UPDATE sessions SET value=json_set(value,'$.providerId',?) WHERE json_extract(value,'$.providerId')=?").run(next,previous); }
  listSessions({maxBytes=32*1024*1024}={}) {
    const bytes=this.db.prepare('SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes FROM sessions').get().bytes;
    if(bytes>maxBytes)throw Object.assign(new Error('全部任务超过 32 MiB 导出上限。请在任务内分别导出，或停止应用后备份数据目录。'),{code:'EXPORT_LIMIT',status:413});
    return this.db.prepare('SELECT value FROM sessions ORDER BY updated_at DESC').all().map(row => JSON.parse(row.value));
  }
  exportSessionsWithHistory({ maxBytes = 32 * 1024 * 1024 } = {}) {
    return this.transaction(() => {
      const budget = this.db.prepare(`SELECT
        (SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) FROM sessions)
        + (SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) FROM run_history)
        + (SELECT COALESCE(SUM(length(CAST(${artifactJson} AS BLOB))),0) FROM tool_artifacts)
        + (SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) FROM summary_jobs) AS bytes,
        (SELECT count(*) FROM run_history) AS historyCount,
        (SELECT count(*) FROM tool_artifacts) AS artifactCount,
        (SELECT count(*) FROM summary_jobs) AS summaryCount`).get();
      if (budget.bytes > maxBytes || budget.historyCount > 200000 || budget.artifactCount > 200000 || budget.summaryCount > SUMMARY_STORAGE_LIMITS.jobs) throw new CoreError('EXPORT_TOO_LARGE', '任务、执行历史、工具结果与摘要草稿超过导出上限。请停止应用后使用离线备份。', 413);
      return {
        sessions: this.db.prepare('SELECT value FROM sessions ORDER BY updated_at DESC').all().map(row => JSON.parse(row.value)),
        runHistory: this.db.prepare('SELECT value FROM run_history ORDER BY session_id,started_at DESC,run_id DESC').all().map(row => JSON.parse(row.value)),
        toolArtifacts: this.db.prepare(`SELECT ${ARTIFACT_COLUMNS} FROM tool_artifacts ORDER BY session_id,run_id,id`).all().map(artifactFromRow),
        summaryJobs: this.db.prepare('SELECT session_id,id,created_at,status,value FROM summary_jobs ORDER BY session_id,created_at,id').all().map(row => this.#summaryFromRow(row)),
      };
    });
  }
  listSessionSummaries() {
    return this.db.prepare(`SELECT id,
      json_extract(value,'$.title') AS title, json_extract(value,'$.providerId') AS providerId,
      json_extract(value,'$.createdAt') AS createdAt, updated_at AS updatedAt,
      json_array_length(value,'$.messages') AS messageCount,
      CASE WHEN json_extract(value,'$.run') IS NOT NULL THEN json_object(
        'id',json_extract(value,'$.run.id'),'status',json_extract(value,'$.run.status'),
        'startedAt',json_extract(value,'$.run.startedAt'),'finishedAt',json_extract(value,'$.run.finishedAt')
      ) END AS run
      FROM sessions ORDER BY updated_at DESC`).all().map(row=>({...row,run:row.run?JSON.parse(row.run):null,messages:[],approvals:[]}));
  }
  getSession(id) { const row = this.db.prepare('SELECT value FROM sessions WHERE id=?').get(id); return row ? JSON.parse(row.value) : null; }
  hasSession(id) { return Boolean(this.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(id)); }
  putRunHistory(record, { artifacts = [] } = {}) {
    const safe = validateRunHistoryRecord(record);
    const summary = summarizeRunHistory(safe);
    this.transaction(() => {
      this.#assertNoSummaryId(safe.sessionId, safe.run.id);
      this.#saveArtifacts(safe.sessionId, safe.run, artifacts);
      this.db.prepare(`INSERT INTO run_history(session_id,run_id,started_at,summary_json,value) VALUES(?,?,?,?,?)
      ON CONFLICT(session_id,run_id) DO UPDATE SET started_at=excluded.started_at,summary_json=excluded.summary_json,value=excluded.value
      WHERE run_history.value<>excluded.value`).run(safe.sessionId, safe.run.id, safe.run.startedAt ?? '', JSON.stringify(summary), JSON.stringify(safe));
      this.#putUsage(safe.sessionId, safe.run, 'history');
    });
    return safe;
  }
  getRunHistory(sessionId, runId) {
    const row = this.db.prepare('SELECT value FROM run_history WHERE session_id=? AND run_id=?').get(sessionId, runId);
    return row ? JSON.parse(row.value) : null;
  }
  listRunHistory(sessionId, { limit = 10, cursor = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new CoreError('INVALID_LIMIT', '每页执行历史数量必须是 1 到 50 的整数。');
    let after = null;
    if (cursor !== null) {
      after = decodeCursor(cursor, sessionId);
      const row = this.db.prepare('SELECT started_at FROM run_history WHERE session_id=? AND run_id=?').get(sessionId, after.id);
      if (!row || row.started_at !== after.startedAt) throw invalidCursor();
    }
    const rows = after
      ? this.db.prepare(`SELECT run_id,started_at,summary_json FROM run_history
          WHERE session_id=? AND (started_at<? OR (started_at=? AND run_id<?))
          ORDER BY started_at DESC,run_id DESC LIMIT ?`).all(sessionId, after.startedAt, after.startedAt, after.id, limit + 1)
      : this.db.prepare(`SELECT run_id,started_at,summary_json FROM run_history WHERE session_id=?
          ORDER BY started_at DESC,run_id DESC LIMIT ?`).all(sessionId, limit + 1);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return { runs: rows.map(row => JSON.parse(row.summary_json)), nextCursor: hasMore ? encodeCursor(sessionId, rows.at(-1)) : null };
  }
  getSessionOutput(id) {
    // SQLite reads the stored JSON, but only this projection crosses into JS/HTTP.
    // Streaming refreshes must not deserialize and send an entire long conversation.
    const row = this.db.prepare(`SELECT id AS sessionId, updated_at AS updatedAt,
      json_type(value,'$.run') AS runType,
      json_extract(value,'$.run.id') AS runId, json_extract(value,'$.run.status') AS runStatus,
      json_type(value,'$.run.output') AS outputType,
      json_extract(value,'$.run.output.stepId') AS stepId,
      json_extract(value,'$.run.output.content') AS content,
      json_extract(value,'$.run.output.status') AS outputStatus,
      json_type(value,'$.run.output.publicReasoning') AS reasoningType,
      json_extract(value,'$.run.output.publicReasoning') AS publicReasoning
      FROM sessions WHERE id=?`).get(id);
    if (!row) return null;
    const output = row.outputType === 'object' ? { stepId: row.stepId, content: row.content, status: row.outputStatus, ...(row.reasoningType === 'text' ? { publicReasoning: row.publicReasoning } : {}) } : null;
    return { sessionId: row.sessionId, updatedAt: row.updatedAt,
      run: row.runType === 'object' ? { id: row.runId, status: row.runStatus, output } : null };
  }
  putSession(session, { artifacts = [], reservation, createOnly = false } = {}) {
    if (typeof createOnly !== 'boolean') throw new CoreError('INVALID_SESSION', '任务保存选项无效。');
    const handoff = sessionHandoff(session);
    if (Object.hasOwn(session, 'branch')) {
      validateBranchMetadata(session.branch);
      if (session.id === session.branch.sourceSessionId || !Array.isArray(session.messages) || session.branch.retainedMessages >= session.messages.length
        || session.messages[session.branch.retainedMessages]?.role !== 'user' || session.branch.createdAt !== session.createdAt) throw new CoreError('INVALID_BRANCH_REQUEST', '分支来源或保留消息数量无效。');
    }
    for(const message of session.messages??[])if(Object.hasOwn(message,'images')){if(message.role!=='user')throw new CoreError('INVALID_IMAGES','仅用户消息可以包含输入图片。');validateImages(message.images);}
    const json=JSON.stringify(session);
    if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw Object.assign(new Error('会话已达到存储上限，请创建新任务。'), { code: 'SESSION_LIMIT', status: 413 });
    const history = createRunHistoryRecord(session);
    this.transaction(() => {
      if (session.run?.id) this.#assertNoSummaryId(session.id, session.run.id);
      if (createOnly) {
        if (this.hasSession(session.id)) throw new CoreError('BRANCH_ID_CONFLICT', '新任务标识已存在，未覆盖任何任务。', 409);
        if (this.db.prepare('SELECT count(*) AS n FROM sessions').get().n >= 1000) throw new CoreError('SESSION_LIMIT', '任务数量已达上限，请先导出并删除旧任务。', 409);
      }
      const original = this.db.prepare(`SELECT json_extract(value,'$.branch') AS branch,
        json_type(value,'$.messages[0].contextHandoff') AS handoffType,
        json_extract(value,'$.messages[0].contextHandoff') AS handoff,
        json_extract(value,'$.messages[0].id') AS handoffMessageId
        FROM sessions WHERE id=?`).get(session.id);
      if (original && !isDeepStrictEqual(original.branch ? JSON.parse(original.branch) : undefined, session.branch)) throw new CoreError('BRANCH_IMMUTABLE', '已保存的分支来源不能修改。', 409);
      if (original) {
        if (original.handoffType !== null && original.handoffType !== 'object') throw new CoreError('INVALID_CONTEXT_HANDOFF', '已保存的交接摘要格式无效。');
        const previous = original.handoffType === null ? undefined : { messageId: original.handoffMessageId, value: JSON.parse(original.handoff) };
        if (!isDeepStrictEqual(previous, handoff)) throw new CoreError('CONTEXT_HANDOFF_IMMUTABLE', '已保存的交接摘要不能添加、删除或修改，请创建新续接任务。', 409);
      }
      this.db.prepare('INSERT INTO sessions(id,updated_at,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,value=excluded.value').run(session.id, session.updatedAt, json);
      this.#saveArtifacts(session.id, session.run, artifacts, reservation);
      if (history) this.putRunHistory(history);
      else this.#putUsage(session.id, session.run, 'current');
      const removed = this.db.prepare("DELETE FROM usage_runs WHERE session_id=? AND source='current' AND run_id<>?").run(session.id, session.run?.id ?? '').changes;
      if (removed) this.#bumpUsage();
    });
    if (reservation !== undefined) this.releaseArtifact(reservation);
    return session;
  }
  #assertNoSummaryId(sessionId, runId) {
    if (this.db.prepare('SELECT 1 FROM summary_jobs WHERE session_id=? AND id=?').get(sessionId, runId)) throw summaryConflict();
  }
  #summaryFromRow(row) {
    let safe;
    try { safe = validateSummaryDraft(JSON.parse(row.value)); } catch { throw summarySchema(); }
    if (safe.sessionId !== row.session_id || safe.id !== row.id || safe.createdAt !== row.created_at || safe.status !== row.status) throw summarySchema();
    return safe;
  }
  putSummaryDraft(draft, { createOnly = false } = {}) {
    if (typeof createOnly !== 'boolean') throw new CoreError('INVALID_SUMMARY_DRAFT', '摘要草稿保存选项无效。');
    const safe = validateSummaryDraft(draft), json = JSON.stringify(safe);
    if (Buffer.byteLength(json) > SUMMARY_STORAGE_LIMITS.jobBytes) throw summaryLimit();
    this.transaction(() => {
      if (!this.hasSession(safe.sessionId)) throw new CoreError('SESSION_NOT_FOUND', '摘要来源任务不存在。', 404);
      if (this.db.prepare('SELECT 1 FROM run_history WHERE session_id=? AND run_id=?').get(safe.sessionId, safe.id)
        || this.db.prepare("SELECT 1 FROM sessions WHERE id=? AND json_extract(value,'$.run.id')=?").get(safe.sessionId, safe.id)) throw summaryConflict();
      const row = this.db.prepare('SELECT session_id,id,created_at,status,value FROM summary_jobs WHERE session_id=? AND id=?').get(safe.sessionId, safe.id);
      if (row && createOnly) throw summaryConflict();
      if (row) summaryProgress(this.#summaryFromRow(row), safe);
      // Reserve a full record for every active request before dispatch. Another
      // job cannot consume the bytes needed to save a response or cancellation.
      const budget = this.db.prepare(`SELECT count(*) AS count,
        COALESCE(SUM(CASE WHEN session_id=? THEN 1 ELSE 0 END),0) AS sessionCount,
        COALESCE(SUM(CASE WHEN status='running' THEN ? ELSE length(CAST(value AS BLOB)) END),0) AS bytes
        FROM summary_jobs WHERE NOT(session_id=? AND id=?)`).get(safe.sessionId, SUMMARY_STORAGE_LIMITS.jobBytes, safe.sessionId, safe.id);
      const occupied = safe.status === 'running' ? SUMMARY_STORAGE_LIMITS.jobBytes : Buffer.byteLength(json);
      if (budget.count + 1 > SUMMARY_STORAGE_LIMITS.jobs || budget.sessionCount + 1 > SUMMARY_STORAGE_LIMITS.perSession
        || budget.bytes + occupied > SUMMARY_STORAGE_LIMITS.bytes) throw summaryLimit();
      this.db.prepare(`INSERT INTO summary_jobs(session_id,id,created_at,status,value) VALUES(?,?,?,?,?)
        ON CONFLICT(session_id,id) DO UPDATE SET status=excluded.status,value=excluded.value WHERE summary_jobs.value<>excluded.value`)
        .run(safe.sessionId, safe.id, safe.createdAt, safe.status, json);
      this.#putUsage(safe.sessionId, { id: safe.id, status: safe.status, connection: safe.connection, steps: safe.steps }, 'summary');
    });
    return safe;
  }
  getSummaryDraft(sessionId, id) {
    const row = this.db.prepare('SELECT session_id,id,created_at,status,value FROM summary_jobs WHERE session_id=? AND id=?').get(sessionId, id);
    return row ? this.#summaryFromRow(row) : null;
  }
  listSummaryDrafts(sessionId, { limit = 20, cursor = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new CoreError('INVALID_LIMIT', '每页摘要草稿数量必须是 1 到 50 的整数。');
    let after = null;
    if (cursor !== null) {
      after = decodeCursor(cursor, sessionId);
      const row = this.db.prepare('SELECT created_at FROM summary_jobs WHERE session_id=? AND id=?').get(sessionId, after.id);
      if (!row || row.created_at !== after.startedAt) throw invalidCursor();
    }
    const rows = after
      ? this.db.prepare('SELECT session_id,id,created_at,status,value FROM summary_jobs WHERE session_id=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?').all(sessionId, after.startedAt, after.startedAt, after.id, limit + 1)
      : this.db.prepare('SELECT session_id,id,created_at,status,value FROM summary_jobs WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(sessionId, limit + 1);
    const page = rows.slice(0, limit), last = page.at(-1);
    return { drafts: page.map(row => this.#summaryFromRow(row)), nextCursor: rows.length > limit ? encodeCursor(sessionId, { started_at: last.created_at, run_id: last.id }) : null };
  }
  #usageRevision() {
    const value = this.db.prepare('SELECT revision FROM usage_meta WHERE id=1').get()?.revision;
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,39})$/u.test(value)) throw new CoreError('INVALID_USAGE_PROJECTION', '用量快照版本无效，请保留数据并检查数据库。', 503);
    return value;
  }
  getStorageIdentity() {
    // This is the existing persistent database identity, not a credential. A
    // logical restore constructs a new Store and therefore receives a new ID.
    const identity = this.db.prepare('SELECT identity FROM usage_meta WHERE id=1').get()?.identity;
    if (typeof identity !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(identity)) {
      throw new CoreError('INVALID_STORAGE_IDENTITY', '本地数据身份无效，请保留原数据并检查数据库。', 503);
    }
    return identity;
  }
  #bumpUsage() {
    this.db.prepare('UPDATE usage_meta SET revision=? WHERE id=1').run((BigInt(this.#usageRevision()) + 1n).toString());
    this.#usageSummary = undefined;
  }
  #putUsage(sessionId, run, source) {
    const value = createUsageProjection(sessionId, run);
    if (!value) return;
    const changed = this.db.prepare(`INSERT INTO usage_runs(session_id,run_id,source,group_key,connection_json,stats_json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(session_id,run_id) DO UPDATE SET source=excluded.source,group_key=excluded.group_key,connection_json=excluded.connection_json,stats_json=excluded.stats_json
      WHERE (usage_runs.source<>'history' OR excluded.source='history')
        AND (usage_runs.source<>excluded.source OR usage_runs.group_key<>excluded.group_key OR usage_runs.connection_json<>excluded.connection_json OR usage_runs.stats_json<>excluded.stats_json)`)
      .run(sessionId, value.runId, source, value.groupKey, JSON.stringify(value.connection), JSON.stringify(value.stats)).changes;
    if (changed) this.#bumpUsage();
  }
  getUsageOverview({ limit = USAGE_OVERVIEW_LIMITS.page, cursor = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > USAGE_OVERVIEW_LIMITS.maxPage) throw new CoreError('INVALID_USAGE_QUERY', '用量概览每页分组数量必须是 1 到 50 的整数。');
    return this.transaction(() => {
      const revision = this.#usageRevision();
      const identity = this.db.prepare('SELECT identity FROM usage_meta WHERE id=1').get()?.identity;
      if (typeof identity !== 'string' || !/^[a-f0-9-]{36}$/u.test(identity)) throw new CoreError('INVALID_USAGE_PROJECTION', '用量快照身份无效，请保留数据并检查数据库。', 503);
      const encode = key => Buffer.from(JSON.stringify({ version: 1, identity, revision, key })).toString('base64url');
      let after = '';
      if (cursor !== null) {
        const invalid = () => new CoreError('INVALID_USAGE_CURSOR', '用量分页位置无效，请重新加载概览。');
        if (typeof cursor !== 'string' || !cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw invalid();
        let value; try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw invalid(); }
        if (!value || value.version !== 1 || value.identity !== identity || typeof value.revision !== 'string' || !/^(?:0|[1-9]\d{0,39})$/u.test(value.revision)
          || typeof value.key !== 'string' || !/^(?:unknown|[a-f0-9]{64})$/u.test(value.key)
          || Buffer.from(JSON.stringify({ version: 1, identity, revision: value.revision, key: value.key })).toString('base64url') !== cursor) throw invalid();
        if (value.revision !== revision) throw new CoreError('USAGE_SNAPSHOT_CHANGED', '已保存的运行用量已变化，请从第一页重新加载。', 409);
        if (!this.db.prepare('SELECT 1 FROM usage_runs WHERE group_key=? LIMIT 1').get(value.key)) throw invalid();
        after = value.key;
      }
      const budget = this.db.prepare(`SELECT count(*) AS n,
        COALESCE(SUM(length(CAST(session_id AS BLOB))+length(CAST(run_id AS BLOB))+length(CAST(source AS BLOB))
          +length(CAST(group_key AS BLOB))+length(CAST(stats_json AS BLOB))+length(CAST(connection_json AS BLOB))),0) AS bytes,
        COALESCE(MAX(length(CAST(session_id AS BLOB))+length(CAST(run_id AS BLOB))+length(CAST(source AS BLOB))
          +length(CAST(group_key AS BLOB))+length(CAST(stats_json AS BLOB))+length(CAST(connection_json AS BLOB))),0) AS largest FROM usage_runs`).get();
      if (budget.n > USAGE_OVERVIEW_LIMITS.runs || budget.bytes > USAGE_OVERVIEW_LIMITS.projectionBytes || budget.largest > USAGE_OVERVIEW_LIMITS.rowBytes) throw new CoreError('USAGE_OVERVIEW_LIMIT', '已保存运行超过用量概览的读取范围，未返回部分累计。请保留原始数据。', 413);
      if (this.#usageSummary?.revision !== revision) {
        const row = this.db.prepare('SELECT openaster_usage_stats(stats_json) AS stats FROM usage_runs').get();
        this.#usageSummary = { revision, generatedAt: new Date().toISOString(), summary: row.stats ? JSON.parse(row.stats) : emptyUsageStats() };
      }
      const rows = this.db.prepare(`SELECT group_key,MIN(connection_json) AS connection_json,openaster_usage_stats(stats_json) AS stats
        FROM usage_runs WHERE group_key>? GROUP BY group_key ORDER BY group_key LIMIT ?`).all(after, limit + 1);
      const hasMore = rows.length > limit; if (hasMore) rows.pop();
      return { version: 1, scope: 'retained-workspace-runs', snapshotId: revision, generatedAt: this.#usageSummary.generatedAt,
        summary: structuredClone(this.#usageSummary.summary),
        groups: rows.map(row => ({ key: row.group_key, connection: JSON.parse(row.connection_json), stats: JSON.parse(row.stats) })),
        nextCursor: hasMore ? encode(rows.at(-1).group_key) : null };
    });
  }
  getToolArtifact(sessionId, runId, id) {
    return artifactFromRow(this.db.prepare(`SELECT ${ARTIFACT_COLUMNS} FROM tool_artifacts WHERE session_id=? AND run_id=? AND id=?`).get(sessionId, runId, id));
  }
  reserveArtifact({ sessionId, runId, id }) {
    if (![sessionId, runId, id].every(validId)) throw invalidArtifact();
    const session = this.getSession(sessionId);
    if (!session || session.run?.id !== runId || !['running', 'awaiting_approval'].includes(session.run.status)) throw invalidArtifact();
    if (this.db.prepare('SELECT 1 FROM tool_artifacts WHERE session_id=? AND run_id=? AND id=?').get(sessionId, runId, id)
      || [...this.#artifactReservations.values()].some(value => value.sessionId === sessionId && value.runId === runId && value.id === id)) throw invalidArtifact();
    this.#checkArtifactBudget(sessionId, runId, TOOL_ARTIFACT_LIMITS.maxBytes, 1);
    const token = Object.freeze({});
    this.#artifactReservations.set(token, { sessionId, runId, id });
    return token;
  }
  releaseArtifact(token) { this.#artifactReservations.delete(token); }
  #checkArtifactBudget(sessionId, runId, bytes, count, excluding) {
    const totals = this.db.prepare(`SELECT COALESCE(SUM(length(CAST(content AS BLOB))),0) AS bytes,
      COALESCE(SUM(CASE WHEN session_id=? AND run_id=? THEN length(CAST(content AS BLOB)) ELSE 0 END),0) AS runBytes,
      COALESCE(SUM(CASE WHEN session_id=? AND run_id=? THEN 1 ELSE 0 END),0) AS runCount FROM tool_artifacts`).get(sessionId, runId, sessionId, runId);
    let reserved = 0, reservedRun = 0, reservedCount = 0;
    for (const [token, value] of this.#artifactReservations) if (token !== excluding) {
      reserved += TOOL_ARTIFACT_LIMITS.maxBytes;
      if (value.sessionId === sessionId && value.runId === runId) { reservedRun += TOOL_ARTIFACT_LIMITS.maxBytes; reservedCount++; }
    }
    if (totals.bytes + reserved + bytes > TOOL_ARTIFACT_LIMITS.storeBytes
      || totals.runBytes + reservedRun + bytes > TOOL_ARTIFACT_LIMITS.runBytes
      || totals.runCount + reservedCount + count > TOOL_ARTIFACT_LIMITS.maxPerRun) throw artifactLimit();
  }
  #saveArtifacts(sessionId, run, values, reservation) {
    if (!Array.isArray(values) || values.length > TOOL_ARTIFACT_LIMITS.maxPerRun) throw invalidArtifact();
    const incoming = new Map();
    for (const value of values) {
      const artifact = validateToolArtifact(value);
      if (artifact.sessionId !== sessionId || artifact.runId !== run?.id || incoming.has(artifact.id)) throw invalidArtifact();
      incoming.set(artifact.id, artifact);
    }
    const held = reservation === undefined ? undefined : this.#artifactReservations.get(reservation);
    if (reservation !== undefined && (!held || held.sessionId !== sessionId || held.runId !== run?.id
      || incoming.size !== 1 || !incoming.has(held.id))) throw invalidArtifact();
    const cache = new Map(incoming);
    const getArtifact = id => {
      if (!cache.has(id)) cache.set(id, artifactFromRow(this.db.prepare(`SELECT ${ARTIFACT_METADATA} FROM tool_artifacts WHERE session_id=? AND run_id=? AND id=?`).get(sessionId, run.id, id)));
      return cache.get(id);
    };
    const linked = validateRunArtifactLinks(run, { sessionId, getArtifact, isBoundary: (artifact, offset) => {
      if (offset === 0 || offset === artifact.bytes) return true;
      if (Object.hasOwn(artifact, 'content')) return (Buffer.from(artifact.content)[offset] & 0xc0) !== 0x80;
      const row = this.db.prepare('SELECT hex(substr(CAST(content AS BLOB),?,1)) AS byte FROM tool_artifacts WHERE session_id=? AND run_id=? AND id=?').get(offset + 1, sessionId, run.id, artifact.id);
      return Boolean(row?.byte) && (Number.parseInt(row.byte, 16) & 0xc0) !== 0x80;
    } });
    if (run) for (const row of this.db.prepare('SELECT id FROM tool_artifacts WHERE session_id=? AND run_id=?').all(sessionId, run.id)) {
      if (!linked?.has(row.id)) throw invalidArtifact();
    }
    let addedBytes = 0, addedCount = 0;
    const additions = [];
    for (const artifact of incoming.values()) {
      if (!linked?.has(artifact.id)) throw invalidArtifact();
      const previous = this.getToolArtifact(sessionId, run.id, artifact.id);
      if (previous) { if (!isDeepStrictEqual(previous, artifact)) throw invalidArtifact(); }
      else { additions.push(artifact); addedBytes += artifact.bytes; addedCount++; }
    }
    if (additions.length) this.#checkArtifactBudget(sessionId, run.id, addedBytes, addedCount, reservation);
    for (const artifact of additions) this.db.prepare(`INSERT INTO tool_artifacts(${ARTIFACT_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(artifact.sessionId, artifact.runId, artifact.id, artifact.stepId, artifact.callId, artifact.name, artifact.path, Number(artifact.isError), artifact.createdAt, artifact.bytes, artifact.sha256, artifact.content);
  }
  createSession({ title = '新任务', providerId = 'demo' } = {}) {
    if (this.db.prepare('SELECT count(*) AS n FROM sessions').get().n >= 1000) throw Object.assign(new Error('任务数量已达上限，请先导出并删除旧任务。'), { code: 'SESSION_LIMIT', status: 409 });
    const now = new Date().toISOString();
    return this.putSession({ id: randomUUID(), title, providerId, createdAt: now, updatedAt: now, messages: [], approvals: [], run: null });
  }
  deleteSession(id, { audit } = {}) {
    this.transaction(() => {
      const counted = Boolean(this.db.prepare('SELECT 1 FROM usage_runs WHERE session_id=? LIMIT 1').get(id));
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
      if (counted) this.#bumpUsage();
      // HTTP deletion and its audit insertion/pruning must commit together.
      // A failed audit must not leave the task and its retained usage deleted.
      if (audit !== undefined) this.audit(audit);
    });
    for (const [token, value] of this.#artifactReservations) if (value.sessionId === id) this.#artifactReservations.delete(token);
  }
  audit({ action, detail = '', sessionId = null }) {
    this.db.prepare('INSERT INTO audit(time,action,detail,session_id) VALUES(?,?,?,?)').run(new Date().toISOString(), String(action).slice(0,100), typeof detail === 'string' ? detail.slice(0,2000) : JSON.stringify(detail).slice(0,2000), sessionId);
    this.db.exec('DELETE FROM audit WHERE id <= (SELECT COALESCE(MAX(id),0)-10000 FROM audit)');
  }
  listAudit() { return this.db.prepare('SELECT id,time,action,detail,session_id AS sessionId FROM audit ORDER BY id DESC LIMIT 300').all(); }
  close() { this.#artifactReservations.clear(); this.db.close(); }
}
