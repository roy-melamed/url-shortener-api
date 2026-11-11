import { describe, expect, it, vi } from 'vitest';
import {
  DummyCaptchaProvider,
  enforceCaptcha,
  MAX_CAPTCHA_TOKEN_LENGTH,
  type CaptchaOptions,
  type RiskInputs,
  type RiskThresholds,
} from '../../src/abuse/captcha.ts';
import { AppError } from '../../src/platform/errors.ts';

// Test fixtures only; these values do not select a production policy.
const thresholds: RiskThresholds = {
  minAccountAgeMs: 1000,
  maxPriorFailures: 3,
  maxCreationsPerMinute: 10,
  minApiKeyAgeMs: 500,
};
const cleanRisk: RiskInputs = {
  accountAgeMs: 1000,
  priorFailures: 2,
  creationsInLastMinute: 9,
  apiKeyAgeMs: 500,
};

function fixture(overrides: Partial<CaptchaOptions> = {}) {
  const verify = vi.fn(async (_token: string) => true);
  const options: CaptchaOptions = {
    mode: 'suspicious',
    risk: { ...cleanRisk },
    thresholds: { ...thresholds },
    provider: { verify },
    ...overrides,
  };
  return { options, verify };
}

async function expectCaptchaError(options: unknown, code = 'CAPTCHA_INVALID') {
  const result = enforceCaptcha(options as CaptchaOptions);
  await expect(result).rejects.toBeInstanceOf(AppError);
  await expect(result).rejects.toMatchObject({ statusCode: 403, code });
}

describe('suspicious-mode CAPTCHA boundary', () => {
  it.each([undefined, '', 'ignored', 123, { secret: 'ignored' }])(
    'does not challenge clean requests or inspect their token (%j)',
    async (token) => {
      const { options, verify } = fixture();
      await expect(
        enforceCaptcha({ ...options, token } as CaptchaOptions),
      ).resolves.toBeUndefined();
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it('permits age threshold equality and counts strictly below their maxima', async () => {
    const { options, verify } = fixture();
    await enforceCaptcha(options);
    expect(verify).not.toHaveBeenCalled();
  });

  it.each<Partial<RiskInputs>>([
    { accountAgeMs: 999 },
    { priorFailures: 3 },
    { creationsInLastMinute: 10 },
    { apiKeyAgeMs: 499 },
    { accountAgeMs: 0 },
    { apiKeyAgeMs: 0 },
    { priorFailures: 4 },
    { creationsInLastMinute: 11 },
  ])('challenges each approved signal independently: %j', async (risk) => {
    const { options, verify } = fixture({ risk: { ...cleanRisk, ...risk } });
    await expectCaptchaError(options, 'CAPTCHA_REQUIRED');
    expect(verify).not.toHaveBeenCalled();
    await expect(enforceCaptcha({ ...options, token: 'test-token' })).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledExactlyOnceWith('test-token');
  });

  it('does not treat an absent API key as a young key', async () => {
    const { options, verify } = fixture({ risk: { ...cleanRisk, apiKeyAgeMs: null } });
    await enforceCaptcha(options);
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([undefined, null, ''])('requires a missing suspicious token (%j)', async (token) => {
    const { options, verify } = fixture({ risk: { ...cleanRisk, priorFailures: 3 } });
    await expectCaptchaError({ ...options, token }, 'CAPTCHA_REQUIRED');
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([123, false, {}, [], 'x'.repeat(MAX_CAPTCHA_TOKEN_LENGTH + 1)])(
    'rejects malformed or oversized suspicious tokens without provider calls (case %#)',
    async (token) => {
      const { options, verify } = fixture({ risk: { ...cleanRisk, priorFailures: 3 } });
      await expectCaptchaError({ ...options, token });
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it('accepts a bounded token only when the injected provider returns true', async () => {
    const token = 'x'.repeat(MAX_CAPTCHA_TOKEN_LENGTH);
    const { options, verify } = fixture({ risk: { ...cleanRisk, priorFailures: 3 }, token });
    await enforceCaptcha(options);
    expect(verify).toHaveBeenCalledExactlyOnceWith(token);
  });

  it.each([false, undefined, null, 1, 'true', {}])(
    'fails closed on any provider result other than boolean true (%j)',
    async (result) => {
      const { options } = fixture({ risk: { ...cleanRisk, priorFailures: 3 }, token: 'secret' });
      options.provider.verify = vi.fn().mockResolvedValue(result);
      await expectCaptchaError(options);
    },
  );

  it.each([undefined, null, {}, { verify: 'not callable' }])(
    'fails closed on a missing/malformed provider (%j)',
    async (provider) => {
      const { options } = fixture({ risk: { ...cleanRisk, priorFailures: 3 }, token: 'secret' });
      await expectCaptchaError({ ...options, provider });
    },
  );

  it.each([undefined, null, '', 'always', 'off', false])(
    'fails closed on missing or unsupported mode (%j)',
    async (mode) => {
      const { options, verify } = fixture();
      await expectCaptchaError({ ...options, mode });
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, [], 'invalid', {}])(
    'rejects malformed options (%j)',
    async (options) => {
      await expectCaptchaError(options);
    },
  );

  for (const field of Object.keys(cleanRisk) as (keyof RiskInputs)[]) {
    it.each([undefined, '1', true, NaN, Infinity, -Infinity, -1])(
      `rejects malformed risk field ${field} (%j) even with an accepting provider`,
      async (value) => {
        const { options, verify } = fixture({ token: 'secret' });
        await expectCaptchaError({ ...options, risk: { ...cleanRisk, [field]: value } });
        expect(verify).not.toHaveBeenCalled();
      },
    );
  }

  for (const field of Object.keys(thresholds) as (keyof RiskThresholds)[]) {
    it.each([undefined, null, '1', true, NaN, Infinity, -Infinity, -1])(
      `rejects malformed threshold ${field} (%j) without selecting defaults`,
      async (value) => {
        const { options, verify } = fixture();
        await expectCaptchaError({ ...options, thresholds: { ...thresholds, [field]: value } });
        expect(verify).not.toHaveBeenCalled();
      },
    );
  }

  it.each(['risk', 'thresholds'] as const)('requires a complete %s object', async (field) => {
    const { options } = fixture();
    for (const value of [undefined, null, {}, [], 'invalid']) {
      await expectCaptchaError({ ...options, [field]: value });
    }
  });

  it.each(['priorFailures', 'creationsInLastMinute'] as const)(
    'rejects fractional or unsafe risk counts: %s',
    async (field) => {
      const { options } = fixture();
      for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expectCaptchaError({ ...options, risk: { ...cleanRisk, [field]: value } });
      }
    },
  );

  it.each(['maxPriorFailures', 'maxCreationsPerMinute'] as const)(
    'requires positive safe integer count maxima: %s',
    async (field) => {
      const { options } = fixture();
      for (const value of [0, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expectCaptchaError({ ...options, thresholds: { ...thresholds, [field]: value } });
      }
    },
  );

  it('allows explicitly injected zero age minima', async () => {
    const { options, verify } = fixture({
      risk: { ...cleanRisk, accountAgeMs: 0, apiKeyAgeMs: 0 },
      thresholds: { ...thresholds, minAccountAgeMs: 0, minApiKeyAgeMs: 0 },
    });
    await enforceCaptcha(options);
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([new Error('secret-token account-private risk-private'), 'secret-token'])(
    'redacts synchronous and asynchronous provider failures (case %#)',
    async (failure) => {
      const { options } = fixture({
        risk: { ...cleanRisk, priorFailures: 3 },
        token: 'secret-token',
      });
      for (const verify of [
        vi.fn(() => {
          throw failure;
        }),
        vi.fn().mockRejectedValue(failure),
      ]) {
        try {
          await enforceCaptcha({ ...options, provider: { verify } });
          expect.unreachable('provider failure must reject');
        } catch (error) {
          expect(error).toBeInstanceOf(AppError);
          expect(error).toMatchObject({
            statusCode: 403,
            code: 'CAPTCHA_INVALID',
            message: 'CAPTCHA verification failed.',
          });
          expect(error).not.toHaveProperty('cause');
          expect(JSON.stringify(error)).not.toMatch(/secret-token|account-private|risk-private/);
          expect(String(error)).not.toMatch(/secret-token|account-private|risk-private/);
        }
      }
    },
  );

  it('redacts malformed risk input instead of echoing it', async () => {
    const { options } = fixture();
    await expect(
      enforceCaptcha({
        ...options,
        risk: { ...cleanRisk, accountAgeMs: 'account-secret' },
      } as unknown as CaptchaOptions),
    ).rejects.toMatchObject({ message: 'CAPTCHA verification failed.', details: undefined });
  });

  it('ships only an always-rejecting dummy with no default provider wiring', async () => {
    const provider = new DummyCaptchaProvider();
    for (const token of ['', 'dummy', 'test-token']) {
      await expect(provider.verify(token)).resolves.toBe(false);
    }
    const { options } = fixture({
      risk: { ...cleanRisk, priorFailures: 3 },
      token: 'dummy',
      provider,
    });
    await expectCaptchaError(options);
  });
});
