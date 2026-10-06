import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kvGet, kvSet, openDb, usedBytes } from './db.ts';

describe('openDb', () => {
  it('creates every table from the spec', () => {
    const db = openDb(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
      .map((r) => r.name)
      .filter((n) => !n.startsWith('sqlite_'));
    expect(tables).toEqual([
      'energy_hourly',
      'events',
      'kv',
      'outages',
      'push_subscriptions',
      'samples_10s',
      'samples_1h',
      'samples_1s',
      'sessions',
    ]);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
  });

  it('keeps data and version when reopened from a file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hubdb-')), 'hub.db');
    const a = openDb(path);
    kvSet(a, 'x', { n: 1 });
    a.close();
    const b = openDb(path);
    expect(kvGet<{ n: number }>(b, 'x')).toEqual({ n: 1 });
    expect((b.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    b.close();
  });

  it('kv overwrites and returns undefined for missing keys', () => {
    const db = openDb(':memory:');
    expect(kvGet(db, 'missing')).toBeUndefined();
    kvSet(db, 'k', 1);
    kvSet(db, 'k', 2);
    expect(kvGet<number>(db, 'k')).toBe(2);
    expect(usedBytes(db)).toBeGreaterThan(0);
  });
});
