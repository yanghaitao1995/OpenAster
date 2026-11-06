// SPDX-License-Identifier: Apache-2.0
import { CoreError } from './errors.mjs';
import { MAX_MODEL_OUTPUT_BYTES } from './model-limits.mjs';

export const PUBLIC_OUTPUT_BYTES = MAX_MODEL_OUTPUT_BYTES;
export const INTERRUPTED_OUTPUT_BYTES = 2 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new CoreError('INVALID_PROVIDER_PROGRESS', '模型公开输出记录无效。');
export function validatePublicOutput(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) throw invalid();
  if (Buffer.byteLength(value) > PUBLIC_OUTPUT_BYTES) throw new CoreError('MODEL_OUTPUT_LIMIT', '单段模型公开输出超过本地 1 MiB 保存上限。已保存内容仍可查看，但不代表完整答复。', 413);
  return value;
}

// Only documented display fields. Never infer reasoning from prose/tags or
// inspect signatures, redacted blocks, encrypted_content or arbitrary metadata.
export function publicReasoning(type, data) {
  let parts = [];
  if (type === 'openai') parts = [data?.choices?.[0]?.message?.reasoning_content].filter(value => value != null);
  else if (type === 'ollama') parts = [data?.message?.thinking].filter(value => value != null);
  else if (type === 'anthropic') parts = (data?.content ?? []).filter(item => item?.type === 'thinking').map(item => item.thinking ?? '');
  else if (type === 'responses') parts = (data?.output ?? []).filter(item => item?.type === 'reasoning').flatMap(item => {
    if (item.summary == null) return [];
    if (!Array.isArray(item.summary)) throw invalid();
    return item.summary.filter(part => part?.type === 'summary_text').map(part => part.text);
  });
  parts.forEach(validatePublicOutput);
  return validatePublicOutput(parts.join('\n'));
}

export function validateInterruptedOutputs(values) {
  if (!Array.isArray(values)) throw invalid();
  if (values.length > 256) throw new CoreError('MODEL_OUTPUT_LIMIT', '本轮中断输出已达 256 次保存上限。已接收内容仍保留，请新建任务后继续。', 413);
  let previous = 0, bytes = 0;
  for (const value of values) {
    if (!object(value) || Object.keys(value).some(key => !['attempt', 'content', 'publicReasoning'].includes(key))
      || !Number.isSafeInteger(value.attempt) || value.attempt <= previous || !Object.hasOwn(value, 'content')) throw invalid();
    previous = value.attempt;
    validatePublicOutput(value.content);
    if (Object.hasOwn(value, 'publicReasoning')) validatePublicOutput(value.publicReasoning);
    if (!value.content && !value.publicReasoning) throw invalid();
    bytes += Buffer.byteLength(value.content) + Buffer.byteLength(value.publicReasoning ?? '');
  }
  if (bytes > INTERRUPTED_OUTPUT_BYTES) throw new CoreError('MODEL_OUTPUT_LIMIT', '本轮中断输出已达 2 MiB 保存上限。已接收内容仍保留，请新建任务或缩小请求后继续。', 413);
  return values;
}
