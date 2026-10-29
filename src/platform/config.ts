/**
 * Environment configuration contract — URL-18 (foundation bootstrap).
 *
 * Rules (design §6.2, §9.4; ticket scope "env contract"):
 *  - Endpoints and secrets are environment-specific and NEVER hardcoded:
 *    cloud values are injected at deploy time (Secrets Manager / CDK outputs),
 *    local values come from a gitignored `.env` (see `.env.example`).
 *  - `loadConfig` is pure and injectable (takes an env object) so it is
 *    unit-testable without dotenv side effects.
 *
 * REDIRECT_STATUS rule (F-24/X-11, D7 wording — approved on the ticket):
 *  default 302 — fixed by AD-1/AC-FR-4.1; changing it requires a new human
 *  decision. Config validation BLOCKS any non-302 value unless the explicit
 *  override flag `REDIRECT_STATUS_ALLOW_NON_DEFAULT=true` is set (and even
 *  then it warns loudly). This does not resolve X-11; it enforces the design.
 */
import { z } from 'zod';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Database (design §9.4: tiny per-container pool; local = direct connection,
  // deployed = through RDS Proxy — the pool abstraction is the seam).
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(2),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DB_SSL_MODE: z.enum(['disable', 'require', 'verify-full']).default('disable'),

  // Deployed data path — placeholders only; injected at deploy time.
  RDS_PROXY_ENDPOINT: z.string().default(''),
  SECRET_ARN_DB: z.string().default(''),
  SECRET_ARN_JWT: z.string().default(''),
  SECRET_ARN_OAUTH: z.string().default(''),
  SECRET_ARN_CAPTCHA: z.string().default(''),

  // Redirect status — fixed at 302 by AD-1/AC-FR-4.1 (see module doc).
  REDIRECT_STATUS: z.coerce
    .number()
    .int()
    .refine((v) => v === 301 || v === 302, {
      message: 'REDIRECT_STATUS must be 301 or 302',
    })
    .default(302),
  REDIRECT_STATUS_ALLOW_NON_DEFAULT: z.enum(['true', 'false']).default('false'),

  // Observability (FR-10): local OTLP → Jaeger; deployed → ADOT → CloudWatch.
  OTLP_ENDPOINT: z.string().default(''),

  // GeoIP database file (AD-2 Option B, design §3.2/§3.9): local path to the
  // transient GeoIP database; vendor/license open (§10.9), never a secret.
  GEO_DB_PATH: z.string().default(''),

  // Email (FR-1.2, design §3.8): local = MailHog SMTP; deployed = AWS SES.
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),

  // CAPTCHA (AD-3): trigger mode 'suspicious'; provider vendor open (§10.8).
  CAPTCHA_MODE: z.string().default('suspicious'),

  // OAuth clients (AD-14: Google + GitHub only). Deployed values come from
  // Secrets Manager; local placeholders via .env.
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GITHUB_CLIENT_ID: z.string().default(''),
  GITHUB_CLIENT_SECRET: z.string().default(''),
});

export type NodeEnv = 'development' | 'test' | 'production';

export interface AppConfig {
  nodeEnv: NodeEnv;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  port: number;
  database: {
    url: string;
    poolMax: number;
    statementTimeoutMs: number;
    idleTimeoutMs: number;
    sslMode: 'disable' | 'require' | 'verify-full';
  };
  rdsProxyEndpoint: string;
  secrets: { dbArn: string; jwtArn: string; oauthArn: string; captchaArn: string };
  redirectStatus: 301 | 302;
  otlpEndpoint: string;
  geoDbPath: string;
  smtp: { host: string; port: number; user: string; password: string };
  captchaMode: string;
  oauth: {
    google: { clientId: string; clientSecret: string };
    github: { clientId: string; clientSecret: string };
  };
}

export interface LoadConfigOptions {
  /** Warning sink (default console.warn) — injectable for tests. */
  warn?: (message: string) => void;
}

/**
 * Validate an environment object into an {@link AppConfig}.
 *
 * @param env Environment source (default: `process.env`).
 * @throws {ConfigError} when the environment is invalid — including any
 *   non-302 `REDIRECT_STATUS` not accompanied by the explicit override flag.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  options: LoadConfigOptions = {},
): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration: ${issues}`);
  }
  const raw = parsed.data;
  const warn = options.warn ?? console.warn;

  // REDIRECT_STATUS guard (F-24/X-11, D7 wording): block non-302 unless the
  // explicit override flag is set — and warn loudly when it is.
  if (raw.REDIRECT_STATUS !== 302) {
    if (raw.REDIRECT_STATUS_ALLOW_NON_DEFAULT !== 'true') {
      throw new ConfigError(
        `REDIRECT_STATUS=${raw.REDIRECT_STATUS} is blocked: the redirect status is fixed at ` +
          '302 by AD-1/AC-FR-4.1 — changing it requires a new human decision. ' +
          'Set REDIRECT_STATUS_ALLOW_NON_DEFAULT=true only alongside a recorded human decision.',
      );
    }
    warn(
      `WARNING: REDIRECT_STATUS=${raw.REDIRECT_STATUS} deviates from the fixed AD-1 default ` +
        'of 302 (AC-FR-4.1). Only valid with an explicit, recorded human decision ' +
        '(override flag REDIRECT_STATUS_ALLOW_NON_DEFAULT=true is set).',
    );
  }

  return {
    nodeEnv: raw.NODE_ENV,
    logLevel: raw.LOG_LEVEL,
    port: raw.PORT,
    database: {
      url: raw.DATABASE_URL,
      poolMax: raw.DB_POOL_MAX,
      statementTimeoutMs: raw.DB_STATEMENT_TIMEOUT_MS,
      idleTimeoutMs: raw.DB_IDLE_TIMEOUT_MS,
      sslMode: raw.DB_SSL_MODE,
    },
    rdsProxyEndpoint: raw.RDS_PROXY_ENDPOINT,
    secrets: {
      dbArn: raw.SECRET_ARN_DB,
      jwtArn: raw.SECRET_ARN_JWT,
      oauthArn: raw.SECRET_ARN_OAUTH,
      captchaArn: raw.SECRET_ARN_CAPTCHA,
    },
    redirectStatus: raw.REDIRECT_STATUS,
    otlpEndpoint: raw.OTLP_ENDPOINT,
    geoDbPath: raw.GEO_DB_PATH,
    smtp: {
      host: raw.SMTP_HOST,
      port: raw.SMTP_PORT,
      user: raw.SMTP_USER,
      password: raw.SMTP_PASSWORD,
    },
    captchaMode: raw.CAPTCHA_MODE,
    oauth: {
      google: { clientId: raw.GOOGLE_CLIENT_ID, clientSecret: raw.GOOGLE_CLIENT_SECRET },
      github: { clientId: raw.GITHUB_CLIENT_ID, clientSecret: raw.GITHUB_CLIENT_SECRET },
    },
  };
}
