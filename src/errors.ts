export type NeedleErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_ENVIRONMENT'
  | 'MODEL_NOT_FOUND'
  | 'INVALID_MODEL'
  | 'ENGINE_ERROR'
  | 'INVALID_RESPONSE'
  | 'WORKER_ERROR'
  | 'CLOSED'
  | 'DOWNLOAD_FAILED'
  | 'INTEGRITY_ERROR';

export class NeedleError extends Error {
  override readonly name = 'NeedleError';

  constructor(
    readonly code: NeedleErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new NeedleError('INVALID_ARGUMENT', `${label} must be a string without null bytes.`);
  }
}

export function validateInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new NeedleError(
      'INVALID_ARGUMENT',
      `${label} must be an integer between ${min} and ${max}.`,
    );
  }
  return value;
}
