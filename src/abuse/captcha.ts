import { AppError } from '../platform/errors.ts';

export interface CaptchaProvider {
  verify(token: string): Promise<boolean>;
}

export interface RiskInputs {
  accountAgeMs: number;
  priorFailures: number;
  creationsInLastMinute: number;
  apiKeyAgeMs: number | null;
}

/** Required policy injection: no production risk thresholds are selected here. */
export interface RiskThresholds {
  minAccountAgeMs: number;
  maxPriorFailures: number;
  maxCreationsPerMinute: number;
  minApiKeyAgeMs: number;
}

export interface CaptchaOptions {
  mode: 'suspicious';
  risk: RiskInputs;
  thresholds: RiskThresholds;
  provider: CaptchaProvider;
  token?: string;
}

/** Local input-size guard, not a vendor contract or risk-policy threshold. */
export const MAX_CAPTCHA_TOKEN_LENGTH = 4096;

function invalidCaptcha(): AppError {
  return new AppError(403, 'CAPTCHA_INVALID', 'CAPTCHA verification failed.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isCount(value: unknown): value is number {
  return isNonnegativeNumber(value) && Number.isSafeInteger(value);
}

function validRisk(value: unknown): value is RiskInputs {
  return (
    isRecord(value) &&
    isNonnegativeNumber(value.accountAgeMs) &&
    isCount(value.priorFailures) &&
    isCount(value.creationsInLastMinute) &&
    (value.apiKeyAgeMs === null || isNonnegativeNumber(value.apiKeyAgeMs))
  );
}

function validThresholds(value: unknown): value is RiskThresholds {
  return (
    isRecord(value) &&
    isNonnegativeNumber(value.minAccountAgeMs) &&
    isCount(value.maxPriorFailures) &&
    value.maxPriorFailures > 0 &&
    isCount(value.maxCreationsPerMinute) &&
    value.maxCreationsPerMinute > 0 &&
    isNonnegativeNumber(value.minApiKeyAgeMs)
  );
}

/** Pure risk evaluation plus injected verification; never performs application writes. */
export async function enforceCaptcha(options: CaptchaOptions): Promise<void> {
  if (
    !isRecord(options) ||
    options.mode !== 'suspicious' ||
    !validRisk(options.risk) ||
    !validThresholds(options.thresholds)
  ) {
    throw invalidCaptcha();
  }

  const { risk, thresholds } = options;
  const suspicious =
    risk.accountAgeMs < thresholds.minAccountAgeMs ||
    risk.priorFailures >= thresholds.maxPriorFailures ||
    risk.creationsInLastMinute >= thresholds.maxCreationsPerMinute ||
    (risk.apiKeyAgeMs !== null && risk.apiKeyAgeMs < thresholds.minApiKeyAgeMs);

  // Clean requests ignore tokens entirely, including malformed tokens.
  if (!suspicious) return;

  const { token } = options;
  if (token === undefined || token === null || token === '') {
    throw new AppError(403, 'CAPTCHA_REQUIRED', 'CAPTCHA verification required.');
  }
  if (typeof token !== 'string' || token.length > MAX_CAPTCHA_TOKEN_LENGTH) {
    throw invalidCaptcha();
  }

  // Do not propagate provider errors, causes, tokens, or risk/account details.
  try {
    if ((await options.provider.verify(token)) !== true) throw invalidCaptcha();
  } catch {
    throw invalidCaptcha();
  }
}

/** Unwired placeholder only: never accepts a token and has no vendor/network behavior. */
export class DummyCaptchaProvider implements CaptchaProvider {
  verify(_token: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}
