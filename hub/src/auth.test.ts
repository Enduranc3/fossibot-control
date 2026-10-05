import { describe, expect, it } from 'vitest';
import { Auth, RateLimitError, hashPassword, verifyPassword } from './auth.ts';
import { openDb } from './db.ts';

function clock(startMs = 1_759_700_000_000) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('password hashing', () => {
  it('verifies the right password only', async () => {
    const h = await hashPassword('correct horse');
    expect(h.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('Auth', () => {
  it('sets the password once and returns a working session', async () => {
    const auth = new Auth(openDb(':memory:'));
    expect(auth.isSetUp()).toBe(false);
    await expect(auth.setup('short')).rejects.toThrow('password_too_short');
    const token = await auth.setup('long enough', 'iPhone');
    expect(auth.isSetUp()).toBe(true);
    expect(auth.verify(token)).toMatchObject({ userAgent: 'iPhone' });
    await expect(auth.setup('another one')).rejects.toThrow('already_set_up');
  });

  it('logs in with the right password and rejects a wrong one', async () => {
    const auth = new Auth(openDb(':memory:'));
    await auth.setup('long enough');
    expect(await auth.login('nope nope')).toBeNull();
    const token = await auth.login('long enough');
    expect(token).toBeTypeOf('string');
    expect(auth.verify(token!)).not.toBeNull();
    expect(auth.verify('forged')).toBeNull();
    expect(auth.verify(undefined)).toBeNull();
  });

  it('logs out, lists and revokes sessions', async () => {
    const auth = new Auth(openDb(':memory:'));
    const a = await auth.setup('long enough', 'A');
    const b = (await auth.login('long enough', 'B'))!;
    expect(auth.listSessions().map((s) => s.userAgent).sort()).toEqual(['A', 'B']);
    auth.logout(a);
    expect(auth.verify(a)).toBeNull();
    const [only] = auth.listSessions();
    expect(auth.revoke(only.id)).toBe(true);
    expect(auth.verify(b)).toBeNull();
    expect(auth.revoke('missing')).toBe(false);
  });

  it('locks after 5 failures within 15 minutes and unlocks later', async () => {
    const c = clock();
    const auth = new Auth(openDb(':memory:'), { now: c.now });
    await auth.setup('long enough');
    for (let i = 0; i < 5; i++) expect(await auth.login('bad password')).toBeNull();
    const err = await auth.login('long enough').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSec).toBe(60);
    c.advance(61_000);
    expect(await auth.login('long enough')).toBeTypeOf('string');
  });

  it('counts parallel attempts: only 5 run scrypt, the rest are refused at once', async () => {
    const auth = new Auth(openDb(':memory:'));
    await auth.setup('long enough');
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => auth.login('bad password')));
    expect(results.filter((r) => r.status === 'fulfilled' && r.value === null)).toHaveLength(5);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof RateLimitError)).toHaveLength(5);
    await expect(auth.login('long enough')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('still verifies sessions when the database cannot be written', async () => {
    const c = clock();
    const db = openDb(':memory:');
    const auth = new Auth(db, { now: c.now });
    const token = await auth.setup('long enough');
    c.advance(5 * 60_000); // last_seen is stale, so verify() wants to touch it
    db.exec('PRAGMA query_only = 1');
    expect(auth.verify(token)).not.toBeNull();
  });

  it('expires sessions unused for a year', async () => {
    const c = clock();
    const auth = new Auth(openDb(':memory:'), { now: c.now });
    const token = await auth.setup('long enough');
    c.advance(366 * 86_400_000);
    expect(auth.verify(token)).toBeNull();
  });
});
