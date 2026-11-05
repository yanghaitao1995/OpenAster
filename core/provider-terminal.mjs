// SPDX-License-Identifier: Apache-2.0
// Completion semantics shared by full JSON and incremental protocol collectors.
// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/retrieve
// https://developers.openai.com/api/reference/resources/responses/methods/create
// https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
// https://docs.ollama.com/api/chat
import { CoreError } from './errors.mjs';

// An explicit unacceptable terminal is not a broken connection; replay may repeat billing.
const incomplete = () => Object.assign(new CoreError('MODEL_RESPONSE_INCOMPLETE', '模型返回了未完成或不可接受的结束状态，请检查任务与模型设置。', 502), { retryable: false });
const outputLimit = () => new CoreError('MODEL_OUTPUT_LIMIT', '模型达到输出或上下文上限，请缩小任务范围。', 502);

/**
 * Tools always require an explicit successful terminal. Legacy full-JSON text
 * replies may omit terminal metadata, but an explicit failure is never ignored.
 * Stream collectors still enforce their protocol's global end marker separately.
 */
export function validateTerminal(type, data, { hasTools = false, allowMissingText = false } = {}) {
  if (data.error != null || data.type === 'error') throw new CoreError('PROVIDER_RESPONSE_ERROR', '模型服务返回错误，响应未被接受。', 502);
  if (type === 'openai') {
    const reason = data.choices?.[0]?.finish_reason;
    if (reason === 'length') throw outputLimit();
    if (hasTools ? reason !== 'tool_calls' : reason !== 'stop' && !(allowMissingText && reason === undefined)) throw incomplete();
  } else if (type === 'anthropic') {
    const reason = data.stop_reason;
    if (['max_tokens', 'model_context_window_exceeded'].includes(reason)) throw outputLimit();
    if (hasTools ? reason !== 'tool_use' : !['end_turn', 'stop_sequence', 'refusal'].includes(reason) && !(allowMissingText && reason === undefined)) throw incomplete();
  } else if (type === 'responses') {
    if (data.incomplete_details != null || (data.status !== 'completed' && !(allowMissingText && !hasTools && data.status === undefined))) throw incomplete();
    // Function-call status is optional in the official schema; a completed
    // response is sufficient only when no output item explicitly contradicts it.
    if (data.output?.some(item => item?.status != null && item.status !== 'completed')) throw incomplete();
  } else if (type === 'ollama') {
    if (data.done_reason === 'length') throw outputLimit();
    if (data.done !== undefined && data.done !== true) throw incomplete();
    if (hasTools) {
      if (data.done !== true || data.done_reason !== 'stop') throw incomplete();
    } else if (data.done_reason !== 'stop' && !(data.done_reason === undefined && (allowMissingText || data.done === true))) throw incomplete();
  } else throw incomplete();
}
