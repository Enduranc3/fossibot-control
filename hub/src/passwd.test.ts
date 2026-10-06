import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Auth } from './auth.ts';
import { openDb } from './db.ts';
import { runPasswd } from './passwd.ts';

function run(lines: string[]) {
  const db = openDb(':memory:');
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = '';
  output.on('data', (d: Buffer) => (printed += d.toString()));
  input.end(lines.map((l) => `${l}\n`).join(''));
  return runPasswd(db, input, output).then((code) => ({ code, printed, auth: new Auth(db) }));
}

describe('passwd', () => {
  it('sets the password when both entries match', async () => {
    const { code, printed, auth } = await run(['new long password', 'new long password']);
    expect(code).toBe(0);
    expect(printed).toContain('Пароль задано');
    expect(await auth.login('new long password')).not.toBeNull();
  });

  it('refuses mismatched or short passwords', async () => {
    const mismatch = await run(['new long password', 'other long password']);
    expect(mismatch.code).toBe(1);
    expect(mismatch.printed).toContain('не збігаються');
    expect(mismatch.auth.isSetUp()).toBe(false);
    const short = await run(['short', 'short']);
    expect(short.code).toBe(1);
    expect(short.printed).toContain('щонайменше 8');
  });
});
