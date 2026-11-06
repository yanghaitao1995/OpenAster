// SPDX-License-Identifier: Apache-2.0
// Completion semantics shared by full JSON and incremental protocol collectors.
// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/retrieve
// https://developers.openai.com/api/reference/resources/responses/methods/create
// https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
// https://docs.ollama.com/api/chat
import { CoreError } from './errors.mjs';

// An explicit unacceptable terminal is not a broken connection; replay may repeat billing.
const incomplete = () => Object.assign(new CoreError('MODEL_RESPONSE_INCOMPLETE', '模型返回了未完成或不可接受的结束状态，请检查任务与模型设置。', 502), { retryable: false });
const outputLimit = continuationSafe => Object.assign(new CoreError('MODEL_OUTPUT_LIMIT', '模型已达到本次回复的令牌上限，已接收内容会保留。可在模型设置中提高输出上限，或继续完成剩余内容；服务商的上下文限制仍然适用。', 502), { retryable: false, ...(continuationSafe ? { continuationSafe: true } : {}) });
const contextLimit = () => Object.assign(new CoreError('MODEL_CONTEXT_LIMIT', '模型已达到上下文窗口上限，已接收内容会保留。需要压缩较早的上下文后继续。', 502), { retryable: false });

/**
 * Tools always require an explicit successful terminal. Legacy full-JSON text
 * replies may omit terminal metadata, but an explicit failure is never ignored.
 * Stream collectors still enforce their protocol's global end marker separately.
 */
export function validateTerminal(type, data, { hasTools = false, allowMissingText = false, allowContinuation = !hasTools } = {}) {
  if (data.error != null || data.type === 'error') throw new CoreError('PROVIDER_RESPONSE_ERROR', '模型服务返回错误，响应未被接受。', 502);
  if (type === 'openai') {
    const reason = data.choices?.[0]?.finish_reason;
    if (reason === 'length') throw outputLimit(!hasTools && allowContinuation);
    if (hasTools ? reason !== 'tool_calls' : reason !== 'stop' && !(allowMissingText && reason === undefined)) throw incomplete();
  } else if (type === 'anthropic') {
    const reason = data.stop_reason;
    if (reason === 'max_tokens') throw outputLimit(!hasTools && allowContinuation);
    if (reason === 'model_context_window_exceeded') throw contextLimit();
    if (hasTools ? reason !== 'tool_use' : !['end_turn', 'stop_sequence', 'refusal'].includes(reason) && !(allowMissingText && reason === undefined)) throw incomplete();
  } else if (type === 'responses') {
    if (data.incomplete_details?.reason === 'max_output_tokens') throw outputLimit(!hasTools && allowContinuation && data.status === 'incomplete');
    if (data.incomplete_details != null || (data.status !== 'completed' && !(allowMissingText && !hasTools && data.status === undefined))) throw incomplete();
    // Function-call status is optional in the official schema; a completed
    // response is sufficient only when no output item explicitly contradicts it.
    if (data.output?.some(item => item?.status != null && item.status !== 'completed')) throw incomplete();
  } else if (type === 'ollama') {
    if (data.done_reason === 'length') throw outputLimit(!hasTools && allowContinuation && data.done === true);
    if (data.done !== undefined && data.done !== true) throw incomplete();
    if (hasTools) {
      if (data.done !== true || data.done_reason !== 'stop') throw incomplete();
    } else if (data.done_reason !== 'stop' && !(data.done_reason === undefined && (allowMissingText || data.done === true))) throw incomplete();
  } else throw incomplete();
}
