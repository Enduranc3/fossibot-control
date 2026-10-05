import { homedir } from 'node:os';
import { join } from 'node:path';
import { startHub } from './hub.ts';

const env = process.env;
const hub = await startHub({
  dataDir: env.FOSSIBOT_DATA_DIR ?? join(homedir(), '.fossibot'),
  httpHost: env.FOSSIBOT_HTTP_HOST ?? '127.0.0.1',
  httpPort: Number(env.FOSSIBOT_HTTP_PORT ?? 8080),
  stationHost: env.FOSSIBOT_STATION_HOST ?? '0.0.0.0',
  stationPort: Number(env.FOSSIBOT_STATION_PORT ?? 8058),
  allowedStationPrefix: env.FOSSIBOT_STATION_ALLOW ?? '192.168.8.',
  allowedOrigins: (env.FOSSIBOT_ORIGINS ?? '').split(',').filter(Boolean),
});
console.log(`[hub] listening: http 127.0.0.1:${hub.httpPort}, station :${hub.stationPort}`);

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
