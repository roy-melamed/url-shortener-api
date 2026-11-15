/** URL-9 password-account unit; external auth/API-key middleware belongs to URL-22. */
export interface Account {
  id: string;
  email: string;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
}
export interface EmailTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  purpose: string;
  expiresAt: Date;
  usedAt: Date | null;
}
export interface RefreshRecord {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}
export interface AccountTransaction {
  createAccount(email: string, passwordHash: string): Promise<Account>;
  lockAccount(id: string): Promise<Account | null>;
  insertEmailToken(record: EmailTokenRecord): Promise<void>;
  emailToken(id: string): Promise<EmailTokenRecord | null>;
  useEmailToken(id: string, now: Date): Promise<void>;
  verifyEmail(userId: string, now: Date): Promise<void>;
  insertRefresh(record: RefreshRecord): Promise<void>;
  refreshToken(id: string): Promise<RefreshRecord | null>;
  revokeRefresh(id: string, now: Date): Promise<void>;
  revokeFamily(familyId: string, now: Date): Promise<void>;
  deleteAccount(userId: string): Promise<void>;
}
export interface AccountStore {
  credentials(email: string): Promise<Account | null>;
  transaction<T>(work: (tx: AccountTransaction) => Promise<T>): Promise<T>;
}
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** Null hashes take a dummy verification path, including unknown/social-only accounts. */
  verify(password: string, encoded: string | null): Promise<boolean>;
}
export interface AccessTokens {
  issue(userId: string, now: Date): Promise<string>;
  /** Strictly verify this unit's session JWT; no API-key or OAuth resolver. */
  verify(token: string, now: Date): Promise<string>;
}
export interface VerificationMessage {
  email: string;
  token: string;
  expiresAt: Date;
}
export interface VerificationMailer {
  sendVerification(message: VerificationMessage): Promise<void>;
}
