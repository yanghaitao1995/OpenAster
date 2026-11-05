export class CoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.status = status;
  }
}

export function publicError(error) {
  return error instanceof CoreError
    ? { code: error.code, message: error.message }
    : { code: 'INTERNAL_ERROR', message: '操作失败，请稍后重试。' };
}

export function checkAbort(signal) {
  if (signal?.aborted) throw new CoreError('CANCELLED', '任务已取消。', 409);
}
