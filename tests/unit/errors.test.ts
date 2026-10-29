import { describe, expect, it } from 'vitest';
import {
  AppError,
  buildErrorEnvelope,
  codeForStatus,
  ERROR_CODES,
} from '../../src/platform/errors.ts';

describe('error envelope (FR-7.2, design §5.1)', () => {
  it('builds the consistent error shape with requestId', () => {
    const envelope = buildErrorEnvelope('NOT_FOUND', 'Route not found.', '01JABC');
    expect(envelope).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found.', requestId: '01JABC' },
    });
  });

  it('omits empty details', () => {
    const envelope = buildErrorEnvelope('INTERNAL', 'boom', 'req');
    expect(envelope.error).not.toHaveProperty('details');
  });

  it('maps HTTP statuses to machine codes', () => {
    expect(codeForStatus(400)).toBe('VALIDATION_ERROR');
    expect(codeForStatus(401)).toBe('UNAUTHENTICATED');
    expect(codeForStatus(403)).toBe('FORBIDDEN');
    expect(codeForStatus(404)).toBe('NOT_FOUND');
    expect(codeForStatus(409)).toBe('CONFLICT');
    expect(codeForStatus(410)).toBe('GONE');
    expect(codeForStatus(429)).toBe('RATE_LIMITED');
    expect(codeForStatus(500)).toBe('INTERNAL');
    expect(codeForStatus(503)).toBe('INTERNAL');
    expect(codeForStatus(418)).toBe('VALIDATION_ERROR');
  });

  it('declares the design §5.1 code set', () => {
    expect(ERROR_CODES).toContain('RATE_LIMITED');
    expect(ERROR_CODES).toContain('IDEMPOTENCY_IN_PROGRESS');
    expect(ERROR_CODES).toContain('CAPTCHA_INVALID');
  });
});

describe('AppError', () => {
  it('carries status, code and details', () => {
    const error = new AppError(409, 'CONFLICT', 'Slug taken.', [
      { field: 'slug', issue: 'taken' },
    ]);
    expect(error.name).toBe('AppError');
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe('CONFLICT');
    expect(error.details).toEqual([{ field: 'slug', issue: 'taken' }]);
    expect(error).toBeInstanceOf(Error);
  });

  it('defaults details to undefined', () => {
    const error = new AppError(500, 'INTERNAL', 'Internal server error.');
    expect(error.details).toBeUndefined();
  });
});
