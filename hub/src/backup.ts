import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';

/** Everything except 1-second samples (spec §4) and login sessions (worthless after a restore). */
export const BACKUP_TABLES = ['samples_10s', 'samples_1h', 'energy_hourly', 'events', 'outages', 'push_subscriptions', 'kv'] as const;
const NAME = /^fossibot-\d{4}-\d{2}-\d{2}\.db$/;
const pad = (n: number) => String(n).padStart(2, '0');

export function backupName(nowSec: number): string {
  const d = new Date(nowSec * 1000);
  return `fossibot-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.db`;
}

export interface BackupFile {
  file: string;
  ts: number;
}

/** Backups in dir, newest first. */
export function listBackups(dir: string): BackupFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => NAME.test(f))
    .sort()
    .reverse()
    .map((file) => ({ file, ts: Math.floor(statSync(join(dir, file)).mtimeMs / 1000) }));
}

/**
 * Writes today's copy of the database at srcPath into dir and keeps the newest `keep` copies.
 * The copy is a fresh database with the same migrations, filled table by table, so the 1-second
 * samples (most of the size) are never read.
 */
export function makeBackup(srcPath: string, dir: string, nowSec: number, keep = 7): string {
  if (!existsSync(srcPath)) throw new Error(`no database at ${srcPath}`);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, backupName(nowSec));
  const tmp = `${target}.tmp`;
  rmSync(tmp, { force: true });
  try {
    const out = openDb(tmp);
    try {
      out.exec(`ATTACH DATABASE '${srcPath.replaceAll("'", "''")}' AS src`);
      out.exec('BEGIN');
      for (const t of BACKUP_TABLES) out.exec(`INSERT INTO main.${t} SELECT * FROM src.${t}`);
      out.exec('COMMIT');
      out.exec('DETACH DATABASE src');
      // A single self-contained file: readable without -wal/-shm companions.
      out.exec('PRAGMA journal_mode = DELETE');
    } finally {
      out.close();
    }
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    rmSync(`${tmp}-wal`, { force: true });
    rmSync(`${tmp}-shm`, { force: true });
    throw err;
  }
  for (const old of listBackups(dir).slice(keep)) rmSync(join(dir, old.file), { force: true });
  return target;
}

/** Once a day, after 04:00 local time. */
export function backupDue(dir: string, nowSec: number): boolean {
  return new Date(nowSec * 1000).getHours() >= 4 && !existsSync(join(dir, backupName(nowSec)));
}

/** Runs `node <this hub> backup <db> <dir>` in a child process so a long copy never blocks the hub. */
export function spawnBackup(dbPath: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.argv[1], 'backup', dbPath, dir], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `backup exited with ${code}`))));
  });
}
