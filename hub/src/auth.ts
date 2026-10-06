import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { kvGet, kvSet, type Db } from './db.ts';

export interface Session {
  id: string;
  createdTs: number;
  lastSeenTs: number;
  userAgent: string;
}

interface SessionRow {
  id: string;
  token_hash: string;
  created_ts: number;
  last_seen_ts: number;
  user_agent: string;
}

export class RateLimitError extends Error {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super('too_many_attempts');
    this.retryAfterSec = retryAfterSec;
  }
}

const SESSION_TTL_SEC = 365 * 86_400;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MIN_PASSWORD = 8;

function scryptAsync(password: string, salt: Buffer, keylen: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32, 16384, 8, 1);
  return `scrypt$16384$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltHex, keyHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length, Number(n), Number(r), Number(p));
  return timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const toSession = (r: SessionRow): Session => ({
  id: r.id,
  createdTs: r.created_ts,
  lastSeenTs: r.last_seen_ts,
  userAgent: r.user_agent,
});

export class Auth {
  private readonly db: Db;
  private readonly now: () => number;
  private failures: number[] = [];
  private lockedUntil = 0;
  private loginChain: Promise<unknown> = Promise.resolve();

  constructor(db: Db, opts: { now?: () => number } = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
  }

  isSetUp(): boolean {
    return kvGet<string>(this.db, 'password_hash') !== undefined;
  }

  async setup(password: string, userAgent = ''): Promise<string> {
    if (this.isSetUp()) throw new Error('already_set_up');
    if (password.length < MIN_PASSWORD) throw new Error('password_too_short');
    kvSet(this.db, 'password_hash', await hashPassword(password));
    return this.createSession(userAgent);
  }
  /** Sets a new password (first set-up or a forgotten one) and ends every session. */
  async resetPassword(password: string): Promise<void> {
    if (password.length < MIN_PASSWORD) throw new Error('password_too_short');
    kvSet(this.db, 'password_hash', await hashPassword(password));
    this.db.prepare('DELETE FROM sessions').run();
  }


  /**
   * Logins run one at a time so that parallel requests are counted against the limit before
   * the next scrypt check starts (otherwise all of them would slip past the lock).
   */
  login(password: string, userAgent = ''): Promise<string | null> {
    const run = () => this.loginOnce(password, userAgent);
    const result = this.loginChain.then(run, run);
    this.loginChain = result.catch(() => undefined);
    return result;
  }

  private async loginOnce(password: string, userAgent: string): Promise<string | null> {
    const nowMs = this.now();
    if (nowMs < this.lockedUntil) throw new RateLimitError(Math.ceil((this.lockedUntil - nowMs) / 1000));
    const stored = kvGet<string>(this.db, 'password_hash');
    if (stored && (await verifyPassword(password, stored))) {
      this.failures = [];
      return this.createSession(userAgent);
    }
    this.failures = this.failures.filter((t) => t > nowMs - FAILURE_WINDOW_MS);
    this.failures.push(nowMs);
    if (this.failures.length >= 5) {
      const minutes = Math.min(60, 2 ** (this.failures.length - 5));
      this.lockedUntil = nowMs + minutes * 60_000;
    }
    return null;
  }

  verify(token: string | undefined): Session | null {
    if (!token) return null;
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token)) as SessionRow | undefined;
    if (!row) return null;
    const nowSec = Math.floor(this.now() / 1000);
    if (nowSec - row.last_seen_ts > SESSION_TTL_SEC) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
      return null;
    }
    if (nowSec - row.last_seen_ts > 60) {
      try {
        this.db.prepare('UPDATE sessions SET last_seen_ts = ? WHERE id = ?').run(nowSec, row.id);
        row.last_seen_ts = nowSec;
      } catch {
        // Best effort: a full or locked database must not lock the owner out of a working hub.
      }
    }
    return toSession(row);
  }

  logout(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  listSessions(): Session[] {
    return (this.db.prepare('SELECT * FROM sessions ORDER BY last_seen_ts DESC').all() as unknown as SessionRow[]).map(toSession);
  }

  revoke(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes) > 0;
  }

  private createSession(userAgent: string): string {
    const token = randomBytes(32).toString('base64url');
    const nowSec = Math.floor(this.now() / 1000);
    this.db
      .prepare('INSERT INTO sessions (id, token_hash, created_ts, last_seen_ts, user_agent) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), sha256(token), nowSec, nowSec, userAgent.slice(0, 200));
    return token;
  }
}
