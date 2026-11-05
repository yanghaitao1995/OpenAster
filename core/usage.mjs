// SPDX-License-Identifier: Apache-2.0
// Protocol references (checked 2026-10-27):
// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/retrieve
// https://developers.openai.com/api/reference/resources/responses/methods/create
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching#how-do-i-calculate-total-input-tokens-from-the-usage-fields
// https://docs.ollama.com/api/chat

const MAX_TOKENS = 1_000_000_000_000;
const FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens'];

// Read only own data properties. Injected providers need not be JSON objects;
// statistics must never invoke a getter or let a malformed field break a reply.
function property(value, key) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return Object.getOwnPropertyDescriptor(value, key);
  } catch { return undefined; }
}
const read = (value, key) => property(value, key)?.value;
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKENS ? (value === 0 ? 0 : value) : null;
const sum = (...values) => values.every(value => value !== null) ? count(values.reduce((total, value) => total + value, 0)) : null;

/**
 * Return only the six supported counters, with unknown/invalid values as null.
 * Do not infer missing counters here: in particular a conflicting reported total
 * stays unknown when the result is sanitized again by runtime or restored later.
 */
export function sanitizeUsage(value) {
  const result = Object.fromEntries(FIELDS.map(key => [key, count(read(value, key))]));
  const { inputTokens, outputTokens } = result;
  if (result.totalTokens !== null && (
    (inputTokens !== null && outputTokens !== null && result.totalTokens !== inputTokens + outputTokens) ||
    (inputTokens !== null && result.totalTokens < inputTokens) ||
    (outputTokens !== null && result.totalTokens < outputTokens)
  )) result.totalTokens = null;
  for (const key of ['cachedInputTokens', 'cacheWriteInputTokens']) {
    if (inputTokens !== null && result[key] !== null && result[key] > inputTokens) result[key] = null;
  }
  if (outputTokens !== null && result.reasoningOutputTokens !== null && result.reasoningOutputTokens > outputTokens) result.reasoningOutputTokens = null;
  // Even an unknown parent has a lower bound from its known subsets. Use max,
  // not addition: cache reads/writes need not be mutually exclusive across APIs.
  const minimumInput = Math.max(inputTokens ?? 0, result.cachedInputTokens ?? 0, result.cacheWriteInputTokens ?? 0);
  const minimumOutput = Math.max(outputTokens ?? 0, result.reasoningOutputTokens ?? 0);
  if (result.totalTokens !== null && result.totalTokens < minimumInput + minimumOutput) result.totalTokens = null;
  return FIELDS.some(key => result[key] !== null) ? result : null;
}

/** Map an entire provider response to protocol-independent token counts. */
export function normalizeProviderUsage(type, data) {
  const usage = type === 'ollama' ? data : read(data, 'usage');
  let inputTokens = null;
  let outputTokens = null;
  let cachedInputTokens = null;
  let cacheWriteInputTokens = null;
  let reasoningOutputTokens = null;
  let totalTokens = null;
  if (type === 'openai' || type === 'responses') {
    const chat = type === 'openai';
    const inputDetails = read(usage, chat ? 'prompt_tokens_details' : 'input_tokens_details');
    const outputDetails = read(usage, chat ? 'completion_tokens_details' : 'output_tokens_details');
    inputTokens = count(read(usage, chat ? 'prompt_tokens' : 'input_tokens'));
    outputTokens = count(read(usage, chat ? 'completion_tokens' : 'output_tokens'));
    cachedInputTokens = count(read(inputDetails, 'cached_tokens'));
    cacheWriteInputTokens = count(read(inputDetails, 'cache_write_tokens'));
    reasoningOutputTokens = count(read(outputDetails, 'reasoning_tokens'));
    // Absence permits a sum of known parents. An explicit invalid/null total is
    // not silently repaired; it remains unknown and does not taint valid parents.
    totalTokens = property(usage, 'total_tokens') ? count(read(usage, 'total_tokens')) : sum(inputTokens, outputTokens);
  } else if (type === 'anthropic') {
    cachedInputTokens = count(read(usage, 'cache_read_input_tokens'));
    cacheWriteInputTokens = count(read(usage, 'cache_creation_input_tokens'));
    // Anthropic input_tokens excludes cache reads and writes. Missing cache
    // counters are unknown, not zero: never report a partial input as its total.
    inputTokens = sum(count(read(usage, 'input_tokens')), cachedInputTokens, cacheWriteInputTokens);
    outputTokens = count(read(usage, 'output_tokens'));
    totalTokens = sum(inputTokens, outputTokens);
  } else if (type === 'ollama') {
    inputTokens = count(read(usage, 'prompt_eval_count'));
    outputTokens = count(read(usage, 'eval_count'));
    cachedInputTokens = count(read(usage, 'prompt_eval_cached_count'));
    totalTokens = sum(inputTokens, outputTokens);
  } else return null;
  return sanitizeUsage({ inputTokens, outputTokens, totalTokens, cachedInputTokens, cacheWriteInputTokens, reasoningOutputTokens });
}
