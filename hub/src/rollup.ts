import { SAMPLE_COLUMNS, kvGet, kvSet, type Db } from './db.ts';

export const ROLLUP_KEY = 'rollup.1h.next';
/** The recorder writes 10-second rows every ~10 s, so an hour is complete a little after it ends. */
const SETTLE_SEC = 120;
const VALUE_COLUMNS = SAMPLE_COLUMNS.filter((c) => c !== 'ts');

/** First hour that has not been rolled up yet; null before the first run. */
export function rolledUntil(db: Db): number | null {
  return kvGet<number>(db, ROLLUP_KEY) ?? null;
}

/** Writes hourly averages of finished hours into samples_1h; returns how many hours were written. */
export function rollupHours(db: Db, nowSec: number): number {
  const end = Math.floor((nowSec - SETTLE_SEC) / 3600) * 3600;
  let start = rolledUntil(db);
  if (start === null) {
    const { t } = db.prepare('SELECT min(ts) AS t FROM samples_10s').get() as { t: number | null };
    if (t === null) return 0;
    start = Math.floor(t / 3600) * 3600;
  }
  if (start >= end) return 0;
  const averages = VALUE_COLUMNS.map((c) => `CAST(round(avg(${c})) AS INTEGER)`).join(', ');
  db.exec('BEGIN');
  try {
    const written = db
      .prepare(
        `INSERT OR REPLACE INTO samples_1h (${SAMPLE_COLUMNS.join(', ')})
         SELECT (ts / 3600) * 3600 AS h, ${averages} FROM samples_10s WHERE ts >= ? AND ts < ? GROUP BY h`,
      )
      .run(start, end).changes;
    kvSet(db, ROLLUP_KEY, end);
    db.exec('COMMIT');
    return Number(written);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
