import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
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
  const health = join(root, 'health');
  // A fake runit: `up` publishes the running version on the health "URL" (releases v2.* never start);
  // stopping takes a second, like a hub closing its database, so the updater has to wait for it.
  writeFileSync(
    sv,
    [
      '#!/bin/sh',
      `echo "$@" >> ${svLog}`,
      'cmd=$1; [ "$cmd" = "-w" ] && { shift 2; cmd=$1; }',
      'case "$cmd" in',
      `  up) v=$(cat "${join(home, 'fossibot-hub')}/current/VERSION"); case "$v" in v2*) ;; *) printf '{"ok":true,"version":"%s"}' "$v" > ${health} ;; esac ;;`,
      `  down|force-stop) (sleep 1; rm -f ${health}) & ;;`,
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(sv, 0o755);
  const env = {
    ...process.env,
    HOME: home,
    PREFIX: prefix,
    FOSSIBOT_BASE: join(home, 'fossibot-hub'),
    FOSSIBOT_DATA_DIR: join(home, '.fossibot'),
    FOSSIBOT_SV: sv,
    FOSSIBOT_HEALTH_URL: `file://${health}`,
    FOSSIBOT_START_WAIT: '3',
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

const svCommands = (log: string) =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.replace(/^-w \d+ /, '').split(' ')[0]);

function unpack(t: ReturnType<typeof termux>, file: string) {
  const x = mkdtempSync(join(t.root, 'x-'));
  execFileSync('tar', ['-xzf', file, '-C', x]);
  return x;
}

describe('install.sh', () => {
  it('installs a release as a runit service that starts after boot', () => {
    const t = termux();
    const r = sh('install.sh', [unpack(t, release(t.root, 'v1.0.0'))], { ...t.env, FOSSIBOT_ORIGINS: 'https://hub.example.ts.net' });
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

  it('replaces its commands with new files, never rewriting the running updater in place', () => {
    const t = termux();
    expect(sh('install.sh', [unpack(t, release(t.root, 'v1.0.0'))], t.env).status).toBe(0);
    const before = statSync(join(t.prefix, 'bin/fossibot-update')).ino;
    expect(sh('install.sh', [unpack(t, release(t.root, 'v1.1.0'))], t.env).status).toBe(0);
    expect(statSync(join(t.prefix, 'bin/fossibot-update')).ino).not.toBe(before);
    expect(readdirSync(join(t.prefix, 'bin')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('fossibot-update', () => {
  function installed(version: string) {
    const t = termux();
    expect(sh('install.sh', [unpack(t, release(t.root, version))], t.env).status).toBe(0);
    writeFileSync(join(t.home, '.fossibot/hub.db'), 'db before update');
    writeFileSync(t.health, `{"ok":true,"version":"${version}"}`); // the running hub
    return t;
  }

  it('waits for the hub to stop, copies the database, switches release and checks the new version answers', () => {
    const t = installed('v1.0.0');
    writeFileSync(join(t.home, '.fossibot/hub.db.before-v0.9.0'), 'old copy');
    const r = sh('fossibot-update', [release(t.root, 'v1.1.0')], t.env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('v1.1.0');
    expect(readlinkSync(join(t.base, 'current'))).toBe(join(t.base, 'releases/v1.1.0'));
    expect(readFileSync(join(t.home, '.fossibot/hub.db.before-v1.1.0'), 'utf8')).toBe('db before update');
    expect(existsSync(join(t.home, '.fossibot/hub.db.before-v0.9.0'))).toBe(false); // one copy is enough
    expect(svCommands(t.svLog)).toEqual(['force-stop', 'up']);
    expect(readFileSync(t.health, 'utf8')).toContain('v1.1.0');
  });

  it('rolls back to the previous release and database when the new one does not start', () => {
    const t = installed('v1.0.0');
    const r = sh('fossibot-update', [release(t.root, 'v2.0.0')], t.env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('відкат');
    expect(readlinkSync(join(t.base, 'current'))).toBe(join(t.base, 'releases/v1.0.0'));
    expect(readFileSync(join(t.home, '.fossibot/hub.db'), 'utf8')).toBe('db before update');
    expect(svCommands(t.svLog)).toEqual(['force-stop', 'up', 'force-stop', 'up']);
    expect(readFileSync(t.health, 'utf8')).toContain('v1.0.0');
  });

  it('brings the old release back up when the update fails half-way', () => {
    const t = installed('v1.0.0');
    const broken = join(t.root, 'broken');
    mkdirSync(broken);
    execFileSync('tar', ['-xzf', release(t.root, 'v1.2.0'), '-C', broken]);
    writeFileSync(join(broken, 'deploy/termux/install.sh'), 'exit 3\n');
    const file = join(t.root, 'broken.tar.gz');
    execFileSync('tar', ['-czf', file, '-C', broken, '.']);
    const r = sh('fossibot-update', [file], t.env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('перервано');
    expect(readlinkSync(join(t.base, 'current'))).toBe(join(t.base, 'releases/v1.0.0'));
    expect(svCommands(t.svLog).at(-1)).toBe('up');
    expect(readFileSync(t.health, 'utf8')).toContain('v1.0.0');
    expect(readFileSync(join(t.home, '.fossibot/hub.db'), 'utf8')).toBe('db before update');
  });
});
