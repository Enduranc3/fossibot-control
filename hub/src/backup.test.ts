import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { backupDue, backupName, listBackups, makeBackup } from './backup.ts';
import { kvSet, openDb, SAMPLE_COLUMNS } from './db.ts';
import { insertEvent } from './events-store.ts';

const at = (d: number, h: number) => Math.floor(new Date(2026, 9, d, h).getTime() / 1000);

function sourceDb() {
  const dir = mkdtempSync(join(tmpdir(), 'backup-src-'));
  const path = join(dir, 'hub.db');
  const db = openDb(path);
  const ins = (t: string) => db.prepare(`INSERT INTO ${t} (${SAMPLE_COLUMNS.join(',')}) VALUES (${SAMPLE_COLUMNS.map(() => '?').join(',')})`);
  ins('samples_1s').run(100, 50, 1, 1, 1, 1, 0, 0, 0, 2300, 30);
  ins('samples_10s').run(100, 50, 1, 1, 1, 1, 0, 0, 0, 2300, 30);
  insertEvent(db, { ts: 100, type: 'grid_lost', source: 'hub', data: { soc: 50 } });
  insertEvent(db, { ts: 200, type: 'grid_restored', source: 'hub', data: { soc: 60 } });
  kvSet(db, 'password_hash', 'scrypt$x');
  db.prepare("INSERT INTO sessions (id, token_hash, created_ts, last_seen_ts) VALUES ('s', 'h', 1, 1)").run();
  return { db, path };
}

describe('backups', () => {
  it('copies everything except 1-second samples and login sessions', () => {
    const { db, path } = sourceDb();
    const dir = mkdtempSync(join(tmpdir(), 'backup-out-'));
    const file = makeBackup(path, dir, at(6, 4));
    db.close();
    expect(file).toBe(join(dir, 'fossibot-2026-10-06.db'));
    const copy = new DatabaseSync(file, { readOnly: true });
    const count = (t: string) => (copy.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect([count('samples_1s'), count('sessions'), count('samples_10s'), count('events')]).toEqual([0, 0, 1, 2]);
    expect((copy.prepare("SELECT value FROM kv WHERE key = 'password_hash'").get() as { value: string }).value).toBe('"scrypt$x"');
    expect((copy.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id).toBe(2);
    expect((copy.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('delete');
    copy.close();
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('keeps the seven newest copies', () => {
    const { db, path } = sourceDb();
    const dir = mkdtempSync(join(tmpdir(), 'backup-keep-'));
    for (let d = 1; d <= 9; d++) makeBackup(path, dir, at(d, 5));
    db.close();
    expect(listBackups(dir).map((b) => b.file)).toEqual([9, 8, 7, 6, 5, 4, 3].map((d) => `fossibot-2026-10-0${d}.db`));
  });

  it('leaves no half-written file behind when the copy fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-fail-'));
    expect(() => makeBackup(join(dir, 'missing', 'hub.db'), dir, at(6, 4))).toThrow();
    expect(listBackups(dir)).toEqual([]);
    expect(existsSync(join(dir, `${backupName(at(6, 4))}.tmp`))).toBe(false);
  });

  it('is due once a day after 04:00', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-due-'));
    expect(backupDue(dir, at(6, 3))).toBe(false);
    expect(backupDue(dir, at(6, 4))).toBe(true);
    writeFileSync(join(dir, backupName(at(6, 4))), '');
    expect(backupDue(dir, at(6, 23))).toBe(false);
    expect(backupDue(dir, at(7, 4))).toBe(true);
  });
});
