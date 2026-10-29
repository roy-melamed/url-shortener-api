/**
 * Consistent JSON error envelope — URL-7 (scaffolding).
 *
 * Implements the FR-7.2 error contract from design §5.1: every error response
 * — including 401/404/410/429 — uses one machine-readable shape that carries a
 * stable machine `code`, a human `message`, the `requestId` for correlation,
 * and optional per-field `details`.
 *
 * Platform-level only (no cloud SDK imports, design §3.9) so it runs on Lambda
 * and locally.
 */

/** Machine-readable error codes (design §5.1). */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'EMAIL_NOT_VERIFIED',
  'FORBIDDEN',
  'NOT_FOUND',
  'GONE',
  'CONFLICT',
  'IDEMPOTENCY_IN_PROGRESS',
  'IDEMPOTENCY_PAYLOAD_MISMATCH',
  'RATE_LIMITED',
  'CAPTCHA_REQUIRED',
  'CAPTCHA_INVALID',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorDetail {
  field: string;
  issue: string;
}

/** The `error` object carried by every error response (design §5.1). */
export interface ErrorBody {
  code: ErrorCode;
  message: string;
  requestId: string;
  details?: ErrorDetail[];
}

/** Full error response body. */
export interface ErrorEnvelope {
  error: ErrorBody;
}

/** Map an HTTP status to the design §5.1 machine code it should surface. */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'VALIDATION_ERROR';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 410:
      return 'GONE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL' : 'VALIDATION_ERROR';
  }
}

/**
 * Application error that carries an explicit HTTP status and machine code.
 * Domain/handlers throw this to control the §5.1 envelope precisely; anything
 * else is mapped by the app error handler to a safe `INTERNAL` response.
 */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: ErrorDetail[];

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: ErrorDetail[],
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * Build the §5.1 error envelope for a response.
 *
 * @param code Machine-readable error code.
 * @param message Human-readable summary (never a stack trace — design §6.4).
 * @param requestId Correlation id echoed from the request.
 * @param details Optional per-field validation/collision details.
 */
export function buildErrorEnvelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: ErrorDetail[],
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      requestId,
      ...(details && details.length > 0 ? { details } : {}),
    },
  };
}
