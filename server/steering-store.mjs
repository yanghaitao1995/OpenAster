// SPDX-License-Identifier: Apache-2.0
import { CoreError } from '../core/errors.mjs';
import { STEERING_LIMITS, validateSteeringRecord, steeringRequestIdentity } from '../core/steering-input.mjs';
import { isDeepStrictEqual } from 'node:util';

export const STEERING_COLUMNS = ['session_id', 'request_id', 'sequence', 'status', 'value'];
export const STEERING_TABLE_SQL = `CREATE TABLE IF NOT EXISTS steering_inputs (
  session_id TEXT NOT NULL, request_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  status TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(session_id,request_id),
  UNIQUE(session_id,sequence), FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);`;
const fail = (code, message, status = 409) => { throw new CoreError(code, message, status); };
export function validateSteeringTable(db) {
  const schema = () => fail('INVALID_STEERING_STORAGE', '追加消息存储结构无效，请保留原始数据。', 503);
  const table = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name='steering_inputs'").get();
  if (table?.type !== 'table' || !/^CREATE TABLE /iu.test(table.sql) || /\bVIRTUAL\b/iu.test(table.sql)) schema();
  const columns = db.prepare("PRAGMA table_xinfo('steering_inputs')").all();
  if (columns.length !== STEERING_COLUMNS.length || columns.some((column, index) => column.name !== STEERING_COLUMNS[index]
    || column.type.toUpperCase() !== (column.name === 'sequence' ? 'INTEGER' : 'TEXT') || column.notnull !== 1 || column.hidden !== 0 || column.pk !== (index < 2 ? index + 1 : 0))) schema();
  const keys = db.prepare("PRAGMA foreign_key_list('steering_inputs')").all();
  if (keys.length !== 1 || keys[0].table !== 'sessions' || keys[0].from !== 'session_id' || keys[0].to !== 'id' || keys[0].on_delete !== 'CASCADE') schema();
  const size = db.prepare('SELECT count(*) AS count,COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes,COALESCE(MAX(length(CAST(value AS BLOB))),0) AS largest FROM steering_inputs').get();
  if (size.count > STEERING_LIMITS.records || size.bytes > STEERING_LIMITS.bytes || size.largest > STEERING_LIMITS.recordBytes
    || db.prepare('SELECT 1 FROM steering_inputs GROUP BY session_id HAVING count(*)>? OR sum(length(CAST(value AS BLOB)))>? LIMIT 1').get(STEERING_LIMITS.perSession, STEERING_LIMITS.sessionBytes)
    || db.prepare('SELECT 1 FROM steering_inputs GROUP BY session_id,sequence HAVING count(*)>1 LIMIT 1').get()) schema();
}
export function steeringFromRow(row) {
  if (!row) return null;
  let value;
  try { value = validateSteeringRecord(JSON.parse(row.value)); }
  catch { fail('INVALID_STEERING_STORAGE', '追加消息存储记录无效，请保留原始数据。', 503); }
  if (value.sessionId !== row.session_id || value.requestId !== row.request_id || value.sequence !== row.sequence || value.status !== row.status) fail('INVALID_STEERING_STORAGE', '追加消息索引与记录不一致。', 503);
  return value;
}
export function createSteeringStore(store) {
  const db = store.db;
  const get = (sessionId, requestId) => steeringFromRow(db.prepare('SELECT * FROM steering_inputs WHERE session_id=? AND request_id=?').get(sessionId, requestId));
  const list = (sessionId, { status } = {}) => {
    if (status !== undefined && !['pending', 'consumed', 'failed'].includes(status)) fail('INVALID_STEERING_INPUT', '追加消息状态无效。', 400);
    return (status === undefined ? db.prepare('SELECT * FROM steering_inputs WHERE session_id=? ORDER BY sequence').all(sessionId)
      : db.prepare('SELECT * FROM steering_inputs WHERE session_id=? AND status=? ORDER BY sequence').all(sessionId, status)).map(steeringFromRow);
  };
  const write = value => db.prepare('INSERT INTO steering_inputs(session_id,request_id,sequence,status,value) VALUES(?,?,?,?,?) ON CONFLICT(session_id,request_id) DO UPDATE SET status=excluded.status,value=excluded.value')
    .run(value.sessionId, value.requestId, value.sequence, value.status, JSON.stringify(value));
  function capacity(value) {
    const size = db.prepare(`SELECT count(*) AS count, COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes,
      COALESCE(SUM(CASE WHEN session_id=? THEN 1 ELSE 0 END),0) AS sessionCount,
      COALESCE(SUM(CASE WHEN session_id=? THEN length(CAST(value AS BLOB)) ELSE 0 END),0) AS sessionBytes,
      COALESCE(SUM(CASE WHEN session_id=? AND status='pending' THEN 1 ELSE 0 END),0) AS pending
      FROM steering_inputs WHERE NOT(session_id=? AND request_id=?)`).get(value.sessionId, value.sessionId, value.sessionId, value.sessionId, value.requestId);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (size.count + 1 > STEERING_LIMITS.records || size.bytes + bytes > STEERING_LIMITS.bytes || size.sessionCount + 1 > STEERING_LIMITS.perSession
      || size.sessionBytes + bytes > STEERING_LIMITS.sessionBytes || value.status === 'pending' && size.pending + 1 > STEERING_LIMITS.pending) fail('STEERING_LIMIT', '追加消息队列或存储已达到上限，请先处理现有消息。', 413);
  }
  return { get, list,
    enqueue(sessionId, source) {
      return store.transaction(() => {
        const sequence = db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM steering_inputs WHERE session_id=?').get(sessionId).next;
        const value = validateSteeringRecord({ ...source, sessionId, sequence, status: 'pending', runId: null, error: null });
        const previous = get(sessionId, value.requestId);
        if (previous) {
          if (!isDeepStrictEqual(steeringRequestIdentity(previous), steeringRequestIdentity(value)) || previous.providerId !== value.providerId || previous.skillId !== value.skillId
            || !isDeepStrictEqual(previous.contextFiles, value.contextFiles)) fail('STEERING_ID_CONFLICT', '该消息标识已用于不同内容；没有覆盖原消息。');
          return { input: previous, duplicate: true };
        }
        const row = db.prepare('SELECT value FROM sessions WHERE id=?').get(sessionId), session = row && JSON.parse(row.value);
        if (!session) fail('SESSION_NOT_FOUND', '任务不存在。', 404);
        if (session.run?.id !== value.expectedRunId || session.providerId !== value.providerId) fail('STEERING_RUN_CHANGED', '任务执行已改变，请核对当前状态后重新发送。');
        if (session.messages?.some(message => message.id === value.requestId)) fail('STEERING_ID_CONFLICT', '该消息标识已存在于任务历史中。');
        capacity(value); write(value); return { input: value, duplicate: false };
      });
    },
    fail(sessionId, requestId, error) {
      return store.transaction(() => {
        const value = get(sessionId, requestId);
        if (!value) fail('STEERING_NOT_FOUND', '追加消息不存在。', 404);
        if (value.status !== 'pending') return value;
        const next = validateSteeringRecord({ ...value, status: 'failed', error }); capacity(next); write(next); return next;
      });
    },
    consume(session, metadata) {
      if (!metadata || !Array.isArray(metadata.requestIds) || !metadata.requestIds.length || metadata.requestIds.length > STEERING_LIMITS.pending
        || Object.keys(metadata).some(key => !['requestIds', 'runId'].includes(key)) || new Set(metadata.requestIds).size !== metadata.requestIds.length
        || session.run?.id !== metadata.runId || session.run.requestMessageId !== metadata.requestIds.at(-1)) fail('STEERING_CONSUME_CONFLICT', '追加消息与本次执行的提交不一致。');
      const records = metadata.requestIds.map(id => get(session.id, id));
      if (records.some((value, index) => !value || value.status === 'failed' || value.status === 'consumed' && value.runId !== metadata.runId || index && value.sequence <= records[index - 1].sequence)) fail('STEERING_CONSUME_CONFLICT', '追加消息已处理或顺序发生变化。');
      if (new Set(records.map(value => value.status)).size !== 1 || records.some(value => value.expectedRunId === metadata.runId)) fail('STEERING_CONSUME_CONFLICT', '追加消息必须在新的独立执行中统一提交。');
      if (records[0].status === 'pending' && !isDeepStrictEqual(list(session.id, { status: 'pending' }).slice(0, records.length).map(value => value.requestId), metadata.requestIds)) fail('STEERING_CONSUME_CONFLICT', '追加消息必须按接收顺序处理。');
      for (const value of records) {
        const matches = session.messages.filter(message => message.id === value.requestId), message = matches[0];
        if (matches.length !== 1 || message.role !== 'user' || message.content !== value.content || !isDeepStrictEqual(message.images ?? [], value.images)
          || !isDeepStrictEqual(message.contextFiles ?? [], value.contextFiles) || session.providerId !== value.providerId) fail('STEERING_CONSUME_CONFLICT', '保存的用户消息不匹配待处理内容。');
        const next = validateSteeringRecord({ ...value, status: 'consumed', runId: metadata.runId }); capacity(next); write(next);
      }
    },
    import(value) {
      const safe = validateSteeringRecord(value);
      if (get(safe.sessionId, safe.requestId) || db.prepare('SELECT 1 FROM steering_inputs WHERE session_id=? AND sequence=?').get(safe.sessionId, safe.sequence)) fail('STEERING_ID_CONFLICT', '追加消息导入标识重复。');
      capacity(safe); write(safe); return safe;
    },
    interruptPending(error) {
      for (const row of db.prepare("SELECT * FROM steering_inputs WHERE status='pending'").all()) {
        const value = steeringFromRow(row); const next = validateSteeringRecord({ ...value, status: 'failed', error }); write(next);
      }
    },
  };
}
