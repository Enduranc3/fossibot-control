import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBackup } from './backup.ts';
import { openDb } from './db.ts';
import { startHub } from './hub.ts';
import { runPasswd } from './passwd.ts';

const env = process.env;
const dataDir = env.FOSSIBOT_DATA_DIR ?? join(homedir(), '.fossibot');
const [command, ...args] = process.argv.slice(2);

if (command === 'passwd') {
  const db = openDb(join(dataDir, 'hub.db'));
  const code = await runPasswd(db);
  db.close();
  process.exit(code);
}

if (command === 'backup') {
  const [dbPath, dir] = args;
  if (!dbPath || !dir) {
    console.error('usage: hub.mjs backup <db> <dir>');
    process.exit(2);
  }
  console.log(makeBackup(dbPath, dir, Math.floor(Date.now() / 1000)));
  process.exit(0);
}

// dist/hub/hub.mjs → dist/web; override with FOSSIBOT_WEB_DIR.
const defaultWeb = fileURLToPath(new URL('../web/', import.meta.url));
const webDir = env.FOSSIBOT_WEB_DIR ?? (existsSync(defaultWeb) ? defaultWeb : undefined);
// Shared storage (after termux-setup-storage) survives a Termux reinstall; otherwise keep copies next to the data.
const shared = join(homedir(), 'storage', 'shared');
const backupDir = env.FOSSIBOT_BACKUP_DIR ?? (existsSync(shared) ? join(shared, 'fossibot-backups') : join(dataDir, 'backups'));
const origins = (env.FOSSIBOT_ORIGINS ?? '').split(',').filter(Boolean);
const hub = await startHub({
  dataDir,
  httpHost: env.FOSSIBOT_HTTP_HOST ?? '127.0.0.1',
  httpPort: Number(env.FOSSIBOT_HTTP_PORT ?? 8080),
  stationHost: env.FOSSIBOT_STATION_HOST ?? '0.0.0.0',
  stationPort: Number(env.FOSSIBOT_STATION_PORT ?? 8058),
  allowedStationPrefix: env.FOSSIBOT_STATION_ALLOW ?? '192.168.8.',
  allowedOrigins: origins,
  webDir,
  backupDir,
  pushSubject: env.FOSSIBOT_PUSH_SUBJECT ?? origins.find((o) => o.startsWith('https://')),
});
console.log(`[hub] listening: http 127.0.0.1:${hub.httpPort}, station :${hub.stationPort}, backups → ${backupDir}`);

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`[hub] ${signal}, stopping`);
  hub.stop().then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
