import type { HubEvent } from '../../shared/events.ts';
import type { Db } from './db.ts';

export function insertEvent(db: Db, e: HubEvent): number {
  const r = db
    .prepare('INSERT INTO events (ts, type, source, data) VALUES (?, ?, ?, ?)')
    .run(e.ts, e.type, e.source, JSON.stringify(e.data));
  return Number(r.lastInsertRowid);
}
