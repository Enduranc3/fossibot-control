import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { Auth } from './auth.ts';
import type { Db } from './db.ts';

/** `hub.mjs passwd`: asks for the password twice on the console; returns the exit code. */
export async function runPasswd(db: Db, input: Readable = process.stdin, output: Writable = process.stdout): Promise<number> {
  const rl = createInterface({ input, terminal: false });
  // The iterator buffers lines, so piped input works as well as typing.
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string) => {
    output.write(prompt);
    const next = await lines.next();
    return next.done ? '' : String(next.value);
  };
  try {
    const first = await ask('Новий пароль (щонайменше 8 символів): ');
    const second = await ask('Ще раз: ');
    if (first !== second) {
      output.write('\nПаролі не збігаються, нічого не змінено.\n');
      return 1;
    }
    await new Auth(db).resetPassword(first);
    output.write('\nПароль задано. Усі сеанси завершено — увійдіть на сайті знову.\n');
    return 0;
  } catch (err) {
    if (err instanceof Error && err.message === 'password_too_short') {
      output.write('\nПароль має бути щонайменше 8 символів, нічого не змінено.\n');
      return 1;
    }
    throw err;
  } finally {
    rl.close();
  }
}
