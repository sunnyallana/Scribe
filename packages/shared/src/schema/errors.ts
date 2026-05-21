export const serviceErrorCodes = [
  'unauthorized',
  'forbidden',
  'not_found',
  'validation_failed',
  'conflict',
  'rate_limited',
  'invite_expired',
  'invite_consumed',
  'storage_failed',
  'email_failed',
  'internal',
] as const;

export type ServiceErrorCode = (typeof serviceErrorCodes)[number];

export interface ServiceError {
  readonly code: ServiceErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function serviceError(
  code: ServiceErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): ServiceError {
  return details === undefined ? { code, message } : { code, message, details };
}
