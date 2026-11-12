import { createTransport } from 'nodemailer';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { VerificationMailer, VerificationMessage } from '../auth/contracts.ts';

export interface VerificationEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
}
export interface MailTransport {
  sendMail(message: VerificationEmail): Promise<unknown>;
}
const loopbackHost = (host: string) =>
  host === 'localhost' || (isIP(host) === 4 && host.split('.')[0] === '127');
/** Inject an already-approved mail transport. No provider discovery or credential loading. */
export class SmtpVerificationMailer implements VerificationMailer {
  private readonly transport: MailTransport;
  private readonly from: string;
  private readonly endpoint: string;
  constructor(transport: MailTransport, from: string, verificationEndpoint: string) {
    this.transport = transport;
    if (!z.email().safeParse(from).success)
      throw new Error('Invalid verification mail configuration.');
    let url: URL;
    try {
      url = new URL(verificationEndpoint);
    } catch {
      throw new Error('Invalid verification mail configuration.');
    }
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHost(url.hostname))) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/v1/auth/emails/verify'
    ) {
      throw new Error('Invalid verification mail configuration.');
    }
    this.from = from;
    this.endpoint = url.href;
  }
  async sendVerification(message: VerificationMessage): Promise<void> {
    if (
      !z.email().safeParse(message.email).success ||
      !/^email\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(message.token) ||
      !(message.expiresAt instanceof Date) ||
      !Number.isFinite(message.expiresAt.getTime())
    ) {
      throw new Error('Invalid verification message.');
    }
    try {
      await this.transport.sendMail({
        from: this.from,
        to: message.email,
        subject: 'Confirm your email address',
        // API-only product: no invented frontend or state-changing GET link. The
        // recipient submits this single-use token using the specified POST API.
        text: `Confirm your email by POSTing JSON to ${this.endpoint}\n${JSON.stringify({ token: message.token })}\nExpires: ${message.expiresAt.toISOString()}`,
      });
    } catch {
      throw new Error('Verification delivery unavailable.');
    }
  }
}

/** MailHog-only local factory; no credentials, remote host or insecure live fallback. */
export function createMailHogMailer(options: {
  host: string;
  port: number;
  from: string;
  verificationEndpoint: string;
}): VerificationMailer {
  if (
    (!loopbackHost(options.host) && options.host !== 'mailhog') ||
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  ) {
    throw new Error('Invalid local mail configuration.');
  }
  const transport = createTransport({
    host: options.host,
    port: options.port,
    secure: false,
    ignoreTLS: true,
    connectionTimeout: 3000,
    greetingTimeout: 3000,
    socketTimeout: 5000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return new SmtpVerificationMailer(transport, options.from, options.verificationEndpoint);
}

/** Historical SES seam only. Inject an approved adapter; no SDK/auth/client selected. */
export interface SesVerificationTransport {
  sendEmail(message: VerificationEmail): Promise<unknown>;
}
export function createSesVerificationMailer(
  transport: SesVerificationTransport,
  from: string,
  endpoint: string,
): VerificationMailer {
  return new SmtpVerificationMailer(
    { sendMail: (message) => transport.sendEmail(message) },
    from,
    endpoint,
  );
}
