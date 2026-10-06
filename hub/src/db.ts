import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export const SAMPLE_COLUMNS = [
  'ts',
  'soc',
  'in_w',
  'out_w',
  'ac_in_w',
  'ac_out_w',
  'solar_w',
  'dc_w',
  'usb_w',
  'ac_v_dv',
  'temp_c',
] as const;

const sampleTable = (name: string) => `
  CREATE TABLE ${name} (
    ts INTEGER PRIMARY KEY, soc INTEGER, in_w INTEGER, out_w INTEGER, ac_in_w INTEGER, ac_out_w INTEGER,
    solar_w INTEGER, dc_w INTEGER, usb_w INTEGER, ac_v_dv INTEGER, temp_c INTEGER
  ) WITHOUT ROWID;`;

/** Index = schema version - 1. Never edit an applied migration; append a new one. */
const MIGRATIONS: string[] = [
  `${sampleTable('samples_1s')}
   ${sampleTable('samples_10s')}
   CREATE TABLE energy_hourly (
     hour_ts INTEGER PRIMARY KEY,
     grid_in_wh REAL NOT NULL DEFAULT 0, solar_in_wh REAL NOT NULL DEFAULT 0, out_wh REAL NOT NULL DEFAULT 0,
     ac_out_wh REAL NOT NULL DEFAULT 0, dc_out_wh REAL NOT NULL DEFAULT 0, usb_out_wh REAL NOT NULL DEFAULT 0
   ) WITHOUT ROWID;
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL,
     source TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
   );
   CREATE INDEX events_ts ON events (ts);
   CREATE INDEX events_type_ts ON events (type, ts);
   CREATE TABLE outages (
     id INTEGER PRIMARY KEY AUTOINCREMENT, start_ts INTEGER NOT NULL, end_ts INTEGER,
     soc_start INTEGER, soc_end INTEGER, out_wh REAL NOT NULL DEFAULT 0
   );
   CREATE INDEX outages_start ON outages (start_ts);
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_ts INTEGER NOT NULL,
     last_seen_ts INTEGER NOT NULL, user_agent TEXT NOT NULL DEFAULT ''
   );
   CREATE TABLE push_subscriptions (
     id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL,
     auth TEXT NOT NULL, created_ts INTEGER NOT NULL
   );
   CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // 2: hourly averages for charts over long ranges (filled from samples_10s by rollup.ts).
  sampleTable('samples_1h'),
];

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  // auto_vacuum only takes effect before the first table is created.
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

export function kvGet<T>(db: Db, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function kvSet(db: Db, key: string, value: unknown): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

/** Bytes actually used by the database (free pages excluded). */
export function usedBytes(db: Db): number {
  const pages = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  const free = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
  const size = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  return (pages - free) * size;
}
