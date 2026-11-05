// SPDX-License-Identifier: Apache-2.0
import { CoreError, checkAbort } from './errors.mjs';
import { withAbort } from './provider-stream.mjs';
import { providerActivityTimeout } from './provider-timeout.mjs';

const TRANSIENT_MESSAGES = Object.freeze({
  PROVIDER_UNAVAILABLE: '暂时无法连接模型服务。',
  PROVIDER_TIMEOUT: '模型服务本次请求超时。',
  PROVIDER_RATE_LIMIT: '模型服务暂时限流。',
  MODEL_RESPONSE_INCOMPLETE: '模型响应在完整结束前中断。',
});

const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Canonical durable metadata; only public status, never response headers/bodies. */
export function validateProviderConnection(value) {
  const fail = () => { throw new CoreError('INVALID_PROVIDER_PROGRESS', '模型连接过程记录无效。'); };
  const required = ['attempt', 'retryCount', 'startedAt', 'elapsedMs', 'nextRetryAt'];
  const allowed = [...required, 'delayMs', 'lastError'];
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail();
  if (!Number.isSafeInteger(value.attempt) || value.attempt < 1 || !Number.isSafeInteger(value.retryCount) || ![value.attempt - 1, value.attempt].includes(value.retryCount)
    || !timestamp(value.startedAt) || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 || !(value.nextRetryAt === null || timestamp(value.nextRetryAt))) fail();
  if (Object.hasOwn(value, 'delayMs') && (!Number.isSafeInteger(value.delayMs) || value.delayMs < 1 || value.delayMs > 300000)) fail();
  if (Object.hasOwn(value, 'lastError')) {
    const error = value.lastError;
    if (!object(error) || Object.keys(error).length !== 2 || !['PROVIDER_HTTP_ERROR', ...Object.keys(TRANSIENT_MESSAGES)].includes(error.code)
      || typeof error.message !== 'string' || !error.message.isWellFormed() || error.message.includes('\0') || error.message.length > 256) fail();
  }
  return value;
}

/** Classify only explicit transport failures, never arbitrary tool/store errors. */
export function retryableProviderError(error) {
  if (!(error instanceof CoreError)) return null;
  if (error.retryable === false) return null;
  if (Object.hasOwn(TRANSIENT_MESSAGES, error.code)) return { code: error.code, message: TRANSIENT_MESSAGES[error.code] };
  if (error.code === 'PROVIDER_HTTP_ERROR' && (error.providerStatus === 408 || error.providerStatus === 425 || (error.providerStatus >= 500 && error.providerStatus <= 599))) {
    return { code: error.code, message: `模型服务暂时不可用（HTTP ${error.providerStatus}）。` };
  }
  // Authentication, malformed requests, output limits, safety refusals, unknown
  // stream errors and invalid protocols need correction, not repeated billing.
  return null;
}

export function abortableRetryDelay(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new CoreError('CANCELLED', '任务已取消。', 409)); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Retry only a not-yet-accepted model response. Never put tool execution here. */
export async function retryProviderRequest(operation, {
  signal, onAttempt = async () => {}, onRetry = async () => {},
  baseDelayMs = 2000, maxDelayMs = 30000, attemptTimeoutMs = 120000,
  connectionTimeoutMs = attemptTimeoutMs, idleTimeoutMs = attemptTimeoutMs,
  random = Math.random, wait = abortableRetryDelay, clock = Date.now,
} = {}) {
  for (const value of [baseDelayMs, maxDelayMs, attemptTimeoutMs]) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid provider retry limit');
  if (baseDelayMs > maxDelayMs || maxDelayMs > 300000 || attemptTimeoutMs > 2147483647) throw new TypeError('Invalid provider retry delay');
  const started = clock();
  let attempt = 0;
  while (true) {
    checkAbort(signal);
    attempt = Math.min(Number.MAX_SAFE_INTEGER, attempt + 1);
    const state = { attempt, retryCount: attempt - 1, startedAt: new Date(started).toISOString(), elapsedMs: Math.max(0, clock() - started), nextRetryAt: null };
    await onAttempt(state);
    checkAbort(signal);
    const timeout = providerActivityTimeout({ connectionTimeoutMs, idleTimeoutMs });
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    let failure;
    try {
      return await withAbort(Promise.resolve().then(() => operation({ signal: combined, attempt, onActivity: timeout.activity })), combined);
    } catch (error) {
      checkAbort(signal);
      failure = timeout.signal.aborted ? new CoreError('PROVIDER_TIMEOUT', '模型服务本次请求超时。', 504) : error;
    } finally { timeout.close(); }
    const lastError = retryableProviderError(failure);
    if (!lastError) throw failure;
    // Equal jitter prevents synchronized clients without allowing zero-delay loops.
    const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt - 1, 30));
    const sample = random();
    const jitter = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
    const localDelay = Math.max(1, Math.floor(exponential * (0.75 + jitter * 0.25)));
    const serverDelay = Number.isSafeInteger(failure.retryAfterMs) && failure.retryAfterMs > 0 ? Math.min(300000, failure.retryAfterMs) : 0;
    const delayMs = Math.max(localDelay, serverDelay);
    await onRetry({ ...state, retryCount: attempt, elapsedMs: Math.max(0, clock() - started), nextRetryAt: new Date(clock() + delayMs).toISOString(), delayMs, lastError });
    checkAbort(signal);
    await withAbort(wait(delayMs, signal), signal);
  }
}
