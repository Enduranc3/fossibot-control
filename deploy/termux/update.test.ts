import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DEPLOY = resolve(import.meta.dirname);

/** A fake Termux: PREFIX with svlogger, a logging `sv`, HOME, data dir and a health file. */
function termux() {
  const root = mkdtempSync(join(tmpdir(), 'termux-'));
  const prefix = join(root, 'usr');
  const home = join(root, 'home');
  for (const d of [join(prefix, 'bin'), join(prefix, 'share/termux-services'), join(prefix, 'etc/profile.d'), home, join(home, '.fossibot')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(prefix, 'share/termux-services/svlogger'), '#!/bin/sh\n');
  const svLog = join(root, 'sv.log');
  const sv = join(root, 'sv');
  writeFileSync(sv, `#!/bin/sh\necho "$@" >> ${svLog}\n`);
  chmodSync(sv, 0o755);
  const health = join(root, 'health');
  const env = {
    ...process.env,
    HOME: home,
    PREFIX: prefix,
    FOSSIBOT_BASE: join(home, 'fossibot-hub'),
    FOSSIBOT_DATA_DIR: join(home, '.fossibot'),
    FOSSIBOT_SV: sv,
    FOSSIBOT_HEALTH_URL: `file://${health}`,
    FOSSIBOT_START_WAIT: '2',
  };
  return { root, prefix, home, env, svLog, health, base: env.FOSSIBOT_BASE };
}

/** A release archive laid out like scripts/pack-release.sh makes it. */
function release(root: string, version: string): string {
  const dir = join(root, `rel-${version}`);
  mkdirSync(join(dir, 'hub'), { recursive: true });
  mkdirSync(join(dir, 'web'), { recursive: true });
  writeFileSync(join(dir, 'VERSION'), `${version}\n`);
  writeFileSync(join(dir, 'hub/hub.mjs'), `// ${version}\n`);
  writeFileSync(join(dir, 'web/index.html'), version);
  mkdirSync(join(dir, 'deploy'), { recursive: true });
  cpSync(DEPLOY, join(dir, 'deploy/termux'), { recursive: true });
  const file = join(root, `fossibot-hub-${version}.tar.gz`);
  execFileSync('tar', ['-czf', file, '-C', dir, '.']);
  return file;
}

const sh = (script: string, args: string[], env: NodeJS.ProcessEnv) => spawnSync('sh', [join(DEPLOY, script), ...args], { env, encoding: 'utf8' });

describe('install.sh', () => {
  it('installs a release as a runit service that starts after boot', () => {
    const t = termux();
    const file = release(t.root, 'v1.0.0');
    const x = join(t.root, 'x');
    mkdirSync(x);
    execFileSync('tar', ['-xzf', file, '-C', x]);
    const r = sh('install.sh', [x], { ...t.env, FOSSIBOT_ORIGINS: 'https://hub.example.ts.net' });
    expect(r.status, r.stderr).toBe(0);
    expect(readlinkSync(join(t.base, 'current'))).toBe(join(t.base, 'releases/v1.0.0'));
    const run = readFileSync(join(t.prefix, 'var/service/fossibot-hub/run'), 'utf8');
    expect(run).toContain(`exec ${t.prefix}/bin/node ${t.base}/current/hub/hub.mjs`);
    expect(run).toContain('.fossibot/hub.env');
    expect(readlinkSync(join(t.prefix, 'var/service/fossibot-hub/log/run'))).toBe(join(t.prefix, 'share/termux-services/svlogger'));
    expect(readFileSync(join(t.prefix, 'var/log/sv/fossibot-hub/config'), 'utf8')).toBe('s10485760\nn5\n');
    expect(readFileSync(join(t.home, '.fossibot/hub.env'), 'utf8')).toContain("export FOSSIBOT_ORIGINS='https://hub.example.ts.net'");
    expect(readFileSync(join(t.home, '.termux/boot/start-services'), 'utf8')).toContain('termux-wake-lock');
    expect(existsSync(join(t.prefix, 'bin/fossibot-update'))).toBe(true);
    expect(existsSync(join(t.prefix, 'bin/fossibot-passwd'))).toBe(true);
  });
});

describe('fossibot-update', () => {
  function installed(version: string) {
    const t = termux();
    const x = join(t.root, 'x');
    mkdirSync(x);
    execFileSync('tar', ['-xzf', release(t.root, version), '-C', x]);
    expect(sh('install.sh', [x], t.env).status).toBe(0);
    writeFileSync(join(t.home, '.fossibot/hub.db'), 'db before update');
    return t;
  }

  it('switches to the new release, keeps a copy of the database and restarts the service', () => {
    const t = installed('v1.0.0');
    writeFileSync(t.health, 'ok');
    const r = sh('fossibot-update', [release(t.root, 'v1.1.0')], t.env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('v1.1.0');
    expect(readlinkSync(join(t.base, 'current'))).toBe(join(t.base, 'releases/v1.1.0'));
    expect(readFileSync(join(t.home, '.fossibot/hub.db.before-v1.1.0'), 'utf8')).toBe('db before update');
    expect(readFileSync(t.svLog, 'utf8').trim().split('\n').map((l) => l.split(' ')[0])).toEqual(['down', 'up']);
  });

  it('rolls back to the previous release and database when the new one does not start', () => {
    const t = installed('v1.0.0');
    const r = sh('fossibot-update', [release(t.root, 'v2.0.0')], t.env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('відкат');
    expect(readlinkSync(join(t.base, 'current'))).toBe(join(t.base, 'releases/v1.0.0'));
    expect(readFileSync(join(t.home, '.fossibot/hub.db'), 'utf8')).toBe('db before update');
    expect(readFileSync(t.svLog, 'utf8').trim().split('\n').map((l) => l.split(' ')[0])).toEqual(['down', 'up', 'down', 'up']);
  });
});
