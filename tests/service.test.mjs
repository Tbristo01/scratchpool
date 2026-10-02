// Tests for skills/scratchpool/scripts/lib/service.mjs. Dry-run only: nothing here ever
// executes launchctl, systemctl or schtasks.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.SCRATCHPOOL_SERVICE_DRYRUN = '1';

const {
  installService, uninstallService, serviceStatus,
  buildPlist, buildSystemdService, buildCrontabLine, buildWindowsTaskRun, buildWindowsWrapper, schedulerPath, _internal,
} = await import('../skills/scratchpool/scripts/lib/service.mjs');

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'scratchpool svc home '));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const dry = (h) => path.join(h, 'service-dryrun');
const readCommands = (h) => JSON.parse(fs.readFileSync(path.join(dry(h), 'commands.json'), 'utf8'));
const read = (f) => fs.readFileSync(f, 'utf8');

const posixPaths = {
  nodePath: '/Users/Jane Doe/.nvm/versions/node/v22.0.0/bin/node',
  scriptPath: '/Users/Jane Doe/My Projects/scratchpool & co/skills/scratchpool/scripts/scratchpool.mjs',
  sfPath: '/opt/sf cli/bin/sf',
};

// ------------------------------------------------------------------ macOS

describe('darwin (launchd)', () => {
  const base = () => ({ home, platform: 'darwin', intervalMinutes: 15, ...posixPaths });

  test('install writes plist and records bootout + bootstrap', () => {
    const r = installService(base());
    assert.equal(r.installed, true);
    assert.equal(r.platform, 'darwin');
    const plist = path.join(dry(home), 'dev.scratchpool.tick.plist');
    assert.deepEqual(r.files, [plist]);
    const uid = process.getuid();
    assert.deepEqual(r.commands, [
      ['launchctl', 'bootout', `gui/${uid}/dev.scratchpool.tick`],
      ['launchctl', 'bootstrap', `gui/${uid}`, plist],
    ]);
    assert.deepEqual(readCommands(home), r.commands);
    assert.ok(fs.existsSync(path.join(home, 'logs')), 'logs dir created');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(home, 'logs')).mode & 0o777, 0o700, 'logs dir is private');
      assert.equal(fs.statSync(path.join(home, 'logs', 'launchd.log')).mode & 0o777, 0o600, 'launchd.log pre-created 0600');
    }

    const xml = read(plist);
    assert.match(xml, /<key>Label<\/key>\s*<string>dev\.scratchpool\.tick<\/string>/);
    assert.match(xml, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/);
    assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
    const log = _internal.xmlEscape(path.join(home, 'logs', 'launchd.log'));
    assert.ok(xml.includes(`<key>StandardOutPath</key>\n  <string>${log}</string>`));
    assert.ok(xml.includes(`<key>StandardErrorPath</key>\n  <string>${log}</string>`));
  });

  test('ProgramArguments and PATH survive spaces and XML metacharacters', () => {
    installService(base());
    const xml = read(path.join(dry(home), 'dev.scratchpool.tick.plist'));
    assert.ok(!xml.includes('scratchpool & co'), 'raw & must be escaped');
    assert.ok(xml.includes('scratchpool &amp; co'));
    const arr = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)[1];
    const args = [...arr.matchAll(/<string>(.*?)<\/string>/g)].map((m) => _internal.xmlUnescape(m[1]));
    assert.deepEqual(args, [posixPaths.nodePath, posixPaths.scriptPath, 'tick', '--json']);
    const pathVal = _internal.xmlUnescape(/<key>PATH<\/key>\s*<string>(.*?)<\/string>/.exec(xml)[1]);
    assert.equal(pathVal, '/Users/Jane Doe/.nvm/versions/node/v22.0.0/bin:/opt/sf cli/bin:/usr/bin:/bin');
    const spHome = _internal.xmlUnescape(/<key>SCRATCHPOOL_HOME<\/key>\s*<string>(.*?)<\/string>/.exec(xml)[1]);
    assert.equal(spHome, path.resolve(home));
  });

  test('plist passes plutil -lint when available', { skip: process.platform !== 'darwin' }, () => {
    installService(base());
    const r = spawnSync('plutil', ['-lint', path.join(dry(home), 'dev.scratchpool.tick.plist')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test('re-install is idempotent and picks up a new interval', () => {
    const a = installService(base());
    const first = read(a.files[0]);
    const b = installService(base());
    assert.equal(read(b.files[0]), first);
    assert.deepEqual(b.commands, a.commands);
    assert.equal(fs.readdirSync(dry(home)).filter((f) => f.endsWith('.plist')).length, 1);
    assert.equal(readCommands(home).length, 4, 'commands.json accumulates history');
    installService({ ...base(), intervalMinutes: 30 });
    assert.equal(serviceStatus({ home, platform: 'darwin' }).intervalMinutes, 30);
  });

  test('status before install, after install, after uninstall', () => {
    assert.deepEqual(
      { ...serviceStatus({ home, platform: 'darwin' }), detail: undefined },
      { installed: false, platform: 'darwin', intervalMinutes: null, detail: undefined },
    );
    installService(base());
    const s = serviceStatus({ home, platform: 'darwin' });
    assert.equal(s.installed, true);
    assert.equal(s.intervalMinutes, 15);
    assert.equal(typeof s.detail, 'string');

    const u = uninstallService({ home, platform: 'darwin' });
    assert.equal(u.installed, false);
    assert.deepEqual(u.files, [path.join(dry(home), 'dev.scratchpool.tick.plist')]);
    assert.deepEqual(u.commands, [['launchctl', 'bootout', `gui/${process.getuid()}/dev.scratchpool.tick`]]);
    assert.equal(serviceStatus({ home, platform: 'darwin' }).installed, false);
    // uninstall twice is harmless
    assert.deepEqual(uninstallService({ home, platform: 'darwin' }).files, []);
  });

  test('missing sfPath still produces a valid PATH', () => {
    const xml = buildPlist({ ...base(), sfPath: null, home: '/h' });
    assert.ok(xml.includes('<string>/Users/Jane Doe/.nvm/versions/node/v22.0.0/bin:/usr/bin:/bin</string>'));
  });
});

// ------------------------------------------------------------------ Linux

describe('linux (systemd --user)', () => {
  const base = () => ({ home, platform: 'linux', intervalMinutes: 15, ...posixPaths, scriptPath: '/home/jane/my 100% "odd" $dir\\x/scratchpool.mjs' });

  test('install writes service + timer and records systemctl commands', () => {
    const r = installService(base());
    assert.equal(r.installed, true);
    assert.equal(r.platform, 'linux');
    const svc = path.join(dry(home), 'scratchpool-tick.service');
    const tmr = path.join(dry(home), 'scratchpool-tick.timer');
    assert.deepEqual(r.files, [svc, tmr]);
    assert.deepEqual(r.commands.slice(0, 2), [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'scratchpool-tick.timer'],
    ]);
    assert.deepEqual(readCommands(home), r.commands);

    const service = read(svc);
    assert.match(service, /^Type=oneshot$/m);
    // Detached _worker creates must survive tick's exit: only the main process is killed, not the cgroup.
    assert.match(service, /^KillMode=process$/m);
    const timer = read(tmr);
    assert.match(timer, /^OnBootSec=2min$/m);
    assert.match(timer, /^OnUnitActiveSec=15min$/m);
    assert.match(timer, /^Persistent=true$/m);
    assert.match(timer, /^Unit=scratchpool-tick\.service$/m);
    assert.match(timer, /^WantedBy=timers\.target$/m);
  });

  test('ExecStart and Environment quote spaces, %, $, quotes and backslashes', () => {
    installService(base());
    const service = read(path.join(dry(home), 'scratchpool-tick.service'));
    const exec = /^ExecStart=(.*)$/m.exec(service)[1];
    assert.equal(
      exec,
      '"/Users/Jane Doe/.nvm/versions/node/v22.0.0/bin/node" "/home/jane/my 100%% \\"odd\\" $$dir\\\\x/scratchpool.mjs" tick --json',
    );
    // round trip each quoted word
    const words = [...exec.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => _internal.systemdUnquote(`"${m[1]}"`));
    assert.deepEqual(words, [posixPaths.nodePath, base().scriptPath]);
    assert.match(service, /^Environment="PATH=\/Users\/Jane Doe\/\.nvm\/versions\/node\/v22\.0\.0\/bin:\/opt\/sf cli\/bin:\/usr\/bin:\/bin"$/m);
    assert.ok(service.includes(`Environment="SCRATCHPOOL_HOME=${path.resolve(home)}"`));
  });

  test('re-install is idempotent', () => {
    const a = installService(base());
    const before = a.files.map(read);
    const b = installService(base());
    assert.deepEqual(b.files.map(read), before);
    assert.deepEqual(b.commands, a.commands);
  });

  test('status and uninstall', () => {
    assert.equal(serviceStatus({ home, platform: 'linux' }).installed, false);
    installService({ ...base(), intervalMinutes: 20 });
    const s = serviceStatus({ home, platform: 'linux' });
    assert.equal(s.installed, true);
    assert.equal(s.intervalMinutes, 20);
    assert.equal(s.platform, 'linux');

    const u = uninstallService({ home, platform: 'linux' });
    assert.equal(u.installed, false);
    assert.equal(u.files.length, 2);
    assert.deepEqual(u.commands, [
      ['systemctl', '--user', 'disable', '--now', 'scratchpool-tick.timer'],
      ['systemctl', '--user', 'daemon-reload'],
    ]);
    assert.ok(!fs.existsSync(path.join(dry(home), 'scratchpool-tick.timer')));
    assert.equal(serviceStatus({ home, platform: 'linux' }).installed, false);
  });

  test('no systemd --user -> SERVICE_UNSUPPORTED with a crontab line, nothing written', () => {
    assert.throws(
      () => installService({ ...base(), systemdAvailable: false }),
      (err) => {
        assert.equal(err.code, 'SERVICE_UNSUPPORTED');
        assert.equal(typeof err.crontab, 'string');
        assert.ok(err.message.includes(err.crontab));
        assert.ok(err.crontab.startsWith('*/15 * * * * '));
        assert.ok(err.crontab.includes("'/Users/Jane Doe/.nvm/versions/node/v22.0.0/bin/node'"));
        assert.ok(err.crontab.includes('tick --json'));
        assert.ok(err.crontab.includes('my 100\\% '), '% must be escaped for crontab');
        return true;
      },
    );
    assert.ok(!fs.existsSync(path.join(dry(home), 'scratchpool-tick.timer')));
    assert.ok(!fs.existsSync(path.join(dry(home), 'commands.json')));
  });

  test('crontab line runs correctly under /bin/sh (quoting round trip)', { skip: process.platform === 'win32' }, () => {
    const line = buildCrontabLine({ home: '/h o/me', nodePath: '/bin/echo', scriptPath: "/a b/it's.mjs", sfPath: null, intervalMinutes: 5 });
    assert.ok(line.startsWith('*/5 * * * * '));
    const cmd = line.slice('*/5 * * * * '.length).replace(/\\%/g, '%').replace(/>>.*$/, '');
    const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
    assert.equal(r.stdout, "/a b/it's.mjs tick --json\n");
  });

  test('crontab schedules for hourly intervals', () => {
    const o = { home: '/h', nodePath: '/n/node', scriptPath: '/s.mjs', sfPath: null };
    assert.ok(buildCrontabLine({ ...o, intervalMinutes: 120 }).startsWith('0 */2 * * * '));
    assert.ok(buildCrontabLine({ ...o, intervalMinutes: 90 }).startsWith('0 * * * * '));
  });

  test('buildSystemdService is exported and stable', () => {
    const s = buildSystemdService({ home: '/h', nodePath: '/n/node', scriptPath: '/s.mjs', sfPath: '/sf/bin/sf' });
    assert.match(s, /^ExecStart="\/n\/node" "\/s\.mjs" tick --json$/m);
  });
});

// ------------------------------------------------------------------ Windows

describe('win32 (Task Scheduler)', () => {
  const winPaths = {
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    scriptPath: 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\scratchpool\\skills\\scratchpool\\scripts\\scratchpool.mjs',
    sfPath: 'C:\\Program Files\\sf\\bin\\sf.cmd',
  };
  const base = () => ({ home, platform: 'win32', intervalMinutes: 15, ...winPaths });

  test('install records schtasks /Create running a wrapper that pins SCRATCHPOOL_HOME and PATH', () => {
    const r = installService(base());
    assert.equal(r.installed, true);
    assert.equal(r.platform, 'win32');
    const wrapper = path.join(home, 'scratchpool-tick.cmd');
    const tr = `"${wrapper}"`;
    assert.equal(buildWindowsTaskRun({ home }), tr);
    assert.deepEqual(r.commands, [
      ['schtasks', '/Create', '/F', '/SC', 'MINUTE', '/MO', '15', '/TN', 'scratchpool-tick', '/TR', tr],
    ]);
    assert.deepEqual(readCommands(home), r.commands);
    assert.equal(r.files.length, 2);
    assert.equal(r.files[0], wrapper);
    const cmd = read(wrapper);
    assert.match(cmd, /^@echo off\r\n/);
    assert.ok(cmd.includes(`set "SCRATCHPOOL_HOME=${home}"`));
    assert.ok(cmd.includes('set "PATH=C:\\Program Files\\nodejs;C:\\Program Files\\sf\\bin;%PATH%"'));
    assert.ok(cmd.includes(`"C:\\Program Files\\nodejs\\node.exe" "${winPaths.scriptPath}" tick --json >> `));
    assert.equal(JSON.parse(read(r.files[1])).intervalMinutes, 15);
  });

  test('wrapper doubles a literal % (batch-file escaping)', () => {
    const cmd = buildWindowsWrapper({ home: 'C:\\Users\\a%b%\\sp', ...winPaths });
    assert.ok(cmd.includes('set "SCRATCHPOOL_HOME=C:\\Users\\a%%b%%\\sp"'));
  });

  test('re-install is idempotent (/F overwrites)', () => {
    const a = installService(base());
    const b = installService(base());
    assert.deepEqual(b.commands, a.commands);
    assert.deepEqual(b.files, a.files);
  });

  test('status and uninstall', () => {
    assert.equal(serviceStatus({ home, platform: 'win32' }).installed, false);
    installService({ ...base(), intervalMinutes: 10 });
    const s = serviceStatus({ home, platform: 'win32' });
    assert.deepEqual([s.installed, s.platform, s.intervalMinutes], [true, 'win32', 10]);
    const u = uninstallService({ home, platform: 'win32' });
    assert.equal(u.installed, false);
    assert.ok(!fs.existsSync(path.join(home, 'scratchpool-tick.cmd')), 'wrapper removed');
    assert.deepEqual(u.commands, [['schtasks', '/Delete', '/F', '/TN', 'scratchpool-tick']]);
    assert.equal(serviceStatus({ home, platform: 'win32' }).installed, false);
  });

  test('over-long /TR is refused', () => {
    assert.throws(
      () => installService({ ...base(), home: path.join(home, 'x'.repeat(270)) }),
      (e) => e.code === 'SERVICE_UNSUPPORTED',
    );
  });
});

// ------------------------------------------------------------------ cross-cutting

describe('general', () => {
  test('SCRATCHPOOL_PLATFORM selects the platform when none is passed', () => {
    process.env.SCRATCHPOOL_PLATFORM = 'linux';
    try {
      const r = installService({ home, intervalMinutes: 15, ...posixPaths });
      assert.equal(r.platform, 'linux');
    } finally {
      delete process.env.SCRATCHPOOL_PLATFORM;
    }
  });

  test('env dry-run wins even if dryRun:false is passed', () => {
    const r = installService({ home, platform: 'darwin', intervalMinutes: 15, dryRun: false, ...posixPaths });
    assert.ok(r.files[0].startsWith(dry(home)));
  });

  test('unsupported platform', () => {
    assert.throws(() => installService({ home, platform: 'aix', intervalMinutes: 15, ...posixPaths }), (e) => e.code === 'SERVICE_UNSUPPORTED');
    assert.equal(serviceStatus({ home, platform: 'aix' }).installed, false);
  });

  test('interval validation', () => {
    for (const bad of [0, -1, 1.5, 1440, 'abc']) {
      assert.throws(() => installService({ home, platform: 'darwin', intervalMinutes: bad, ...posixPaths }), (e) => e.code === 'USAGE');
    }
    assert.equal(installService({ home, platform: 'darwin', ...posixPaths }).installed, true, 'defaults to 15');
    assert.equal(serviceStatus({ home, platform: 'darwin' }).intervalMinutes, 15);
  });

  test('schedulerPath dedupes', () => {
    assert.equal(schedulerPath('/usr/bin/node', '/usr/bin/sf'), '/usr/bin:/bin');
  });
});

test('install refuses paths with control characters (no directive injection into units)', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const bad of [{ home: `${home}\nExecStartPre=/bin/evil` }, { nodePath: '/usr/bin/node\r\nX=1' }, { scriptPath: '/a/b\u0000.mjs' }]) {
      assert.throws(() => installService({ home, platform, dryRun: true, intervalMinutes: 15, ...posixPaths, ...bad }), (e) => e.code === 'USAGE', `${platform} ${JSON.stringify(bad)}`);
    }
  }
});
