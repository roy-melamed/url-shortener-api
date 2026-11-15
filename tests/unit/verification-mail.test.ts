import { describe, expect, it, vi } from 'vitest';
import {
  createMailHogMailer,
  createSesVerificationMailer,
  SmtpVerificationMailer,
} from '../../src/platform/verification-mail.ts';
import type { VerificationEmail } from '../../src/platform/verification-mail.ts';
import { newOpaqueToken } from '../../src/auth/crypto.ts';

const endpoint = 'https://fixture.invalid/v1/auth/emails/verify';
const from = 'sender@example.invalid';
const message = {
  email: 'person@example.invalid',
  token: newOpaqueToken('email').raw,
  expiresAt: new Date('2026-01-01T01:00:00Z'),
};
describe('verification mail transport seams, no production provider selected', () => {
  it('delivers API-only confirmation instruction via injected SMTP transport', async () => {
    const sendMail = vi.fn(async (_message: VerificationEmail) => undefined);
    await new SmtpVerificationMailer({ sendMail }, from, endpoint).sendVerification(message);
    expect(sendMail).toHaveBeenCalledWith({
      from,
      to: message.email,
      subject: 'Confirm your email address',
      text: expect.stringContaining(JSON.stringify({ token: message.token })),
    });
    const text = sendMail.mock.calls[0]?.[0] as unknown as { text: string };
    expect(text.text).toContain('POST');
    expect(text.text).toContain(endpoint);
    expect(text.text).not.toContain('?token=');
  });
  it('adapts historical SES interface only, without SDK, credentials or network discovery', async () => {
    const sendEmail = vi.fn(async () => undefined);
    await createSesVerificationMailer({ sendEmail }, from, endpoint).sendVerification(message);
    expect(sendEmail).toHaveBeenCalledOnce();
  });
  it.each([
    'not-url',
    'http://outside.invalid/v1/auth/emails/verify',
    'https://user:private@fixture.invalid/v1/auth/emails/verify',
    endpoint + '?token=private',
    endpoint + '#private',
    'https://fixture.invalid/other',
  ])('rejects invalid endpoint without raw configuration echo %#', (bad) => {
    expect(() => new SmtpVerificationMailer({ sendMail: vi.fn() }, from, bad)).toThrow(
      'Invalid verification mail configuration.',
    );
  });
  it('validates from/recipient/token/expiry, and redacts provider errors', async () => {
    expect(() => new SmtpVerificationMailer({ sendMail: vi.fn() }, 'bad\nfrom', endpoint)).toThrow(
      'Invalid verification mail configuration.',
    );
    const sendMail = vi.fn().mockRejectedValue(new Error('private-provider-error'));
    const mail = new SmtpVerificationMailer({ sendMail }, from, endpoint);
    for (const bad of [
      { ...message, email: 'bad\nheader' },
      { ...message, token: 'private\nraw' },
      { ...message, expiresAt: new Date(NaN) },
    ]) {
      await expect(mail.sendVerification(bad)).rejects.toThrow('Invalid verification message.');
    }
    expect(sendMail).not.toHaveBeenCalled();
    await expect(mail.sendVerification(message)).rejects.toThrow(
      'Verification delivery unavailable.',
    );
  });
  it('MailHog factory accepts only explicit local targets, with no default network connection', () => {
    for (const host of ['localhost', '127.0.0.1', 'mailhog']) {
      expect(
        createMailHogMailer({
          host,
          port: 1025,
          from,
          verificationEndpoint: 'http://localhost/v1/auth/emails/verify',
        }),
      ).toBeInstanceOf(SmtpVerificationMailer);
    }
    for (const port of [0, 65536, 1.5, NaN])
      expect(() =>
        createMailHogMailer({ host: 'localhost', port, from, verificationEndpoint: endpoint }),
      ).toThrow('Invalid local mail configuration.');
    expect(() =>
      createMailHogMailer({
        host: 'remote.invalid',
        port: 1025,
        from,
        verificationEndpoint: endpoint,
      }),
    ).toThrow('Invalid local mail configuration.');
  });
});
