import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, HUB, assertNoSecrets } from './helpers.mjs';

test('init: resolves default hub, writes config with absolute paths, runs one tick', () => {
  const t = makeEnv();
  try {
    const r = t.run(['init', '--no-service', '--json']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.schema, 'scratchpool/v1');
    assert.equal(r.json.command, 'init');
    assert.equal(r.json.status, 'ok');
    assert.equal(r.json.pool, 'my-app');
    assert.equal(r.json.config.hub, 'devhub');
    assert.equal(r.json.config.hubUsername, HUB.username);
    assert.ok(Array.isArray(r.json.pools), 'init output includes the initial tick result');
    assert.equal(r.json.pools[0].started, 1);

    const keys = t.callKeys();
    assert.ok(keys.includes('config get target-dev-hub'));
    assert.ok(t.ran('org display -o devhub').length === 1);
    assert.ok(!t.calls().some((c) => c.argv.includes('--verbose')), 'never --verbose');

    const c = t.config();
    assert.equal(c.schema, 1);
    assert.ok(path.isAbsolute(c.nodePath) && path.isAbsolute(c.sfPath) && path.isAbsolute(c.scriptPath));
    assert.equal(c.intervalMinutes, 15);
    const p = c.pools['my-app'];
    assert.equal(p.projectDir, t.project);
    assert.equal(p.size, 1);
    assert.equal(p.definitionFile, 'config/project-scratch-def.json');
    assert.equal(p.snapshot, null);
    assert.equal(p.durationDays, null);
    assert.equal(p.coldDurationDays, 1);
    assert.equal(p.setupHook, false);
    assert.equal(p.dailyFloor, 2);
    assert.equal(p.teamCapPct, 25);
    assert.equal(p.claimMinLifeHours, 24);
    assert.equal(p.activeReserve, 1);
    assert.equal(p.paused, false);

    const st = t.state();
    assert.equal(st.entries.length, 1);
    assert.equal(st.entries[0].status, 'ready');
    assert.match(st.entries[0].alias, /^sp-my-app-[0-9a-f]{4}$/);
    assert.match(st.entries[0].defHash, /^[0-9a-f]{12}$/);

    const create = t.ran('org create scratch')[0];
    assert.ok(create.argv.includes('-f'));
    assert.equal(create.argv[create.argv.indexOf('-f') + 1], path.join(t.project, 'config/project-scratch-def.json'));
    assert.equal(create.argv[create.argv.indexOf('-v') + 1], 'devhub');
    assert.equal(create.argv[create.argv.indexOf('-y') + 1], '7');
    assert.match(create.argv[create.argv.indexOf('--description') + 1], /^scratchpool:v1:me@corp\.com:[0-9a-f]{12}:[0-9a-f]{8}$/);
    assert.equal(create.cwd, t.project);
    assertNoSecrets(assert, t.allCaptured());
  } finally { t.cleanup(); }
});

test('init: --hub skips config get; service installed in dry-run by default', () => {
  const t = makeEnv({ scenario: { defaultHub: null } });
  try {
    const r = t.run(['init', '--hub', 'devhub', '--size', '0', '--json']);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(t.ran('config get').length, 0);
    assert.equal(r.json.service.installed, true);
    assert.ok(fs.existsSync(path.join(t.home, 'service-dryrun')));
    // no real launchctl: dry-run commands recorded
    assert.ok(fs.existsSync(path.join(t.home, 'service-dryrun', 'commands.json')));
  } finally { t.cleanup(); }
});

test('init: NO_DEVHUB when no default hub', () => {
  const t = makeEnv({ scenario: { defaultHub: null } });
  try {
    const r = t.run(['init', '--no-service', '--json']);
    assert.equal(r.code, 5);
    assert.equal(r.json.error.code, 'NO_DEVHUB');
    assert.ok(!fs.existsSync(path.join(t.home, 'config.json')));
  } finally { t.cleanup(); }
});

test('init: NO_DEVHUB when the alias is not a Dev Hub', () => {
  const t = makeEnv();
  try {
    const r = t.run(['init', '--hub', 'nothub', '--no-service', '--json']);
    assert.equal(r.code, 5);
    assert.equal(r.json.error.code, 'NO_DEVHUB');
    // display succeeds for an authed non-hub org but it is not in devHubs
    t.setScenario({ scratchOrgs: [{ alias: 'so', username: 'so@x.com', orgId: '00D1', expirationDate: '2026-10-08', devHubUsername: 'me@corp.com' }] });
    const r2 = t.run(['init', '--hub', 'so', '--no-service', '--json']);
    assert.equal(r2.json.error.code, 'NO_DEVHUB');
  } finally { t.cleanup(); }
});

test('init: NOT_A_PROJECT outside an sfdx project', () => {
  const t = makeEnv();
  try {
    const r = t.run(['init', '--no-service', '--json'], { cwd: t.root });
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'NOT_A_PROJECT');
  } finally { t.cleanup(); }
});

test('init: finds project root from a subdirectory; pool name sanitised', () => {
  const t = makeEnv({ projectName: 'My_App.Web' });
  try {
    const sub = path.join(t.project, 'force-app', 'main');
    fs.mkdirSync(sub, { recursive: true });
    const r = t.run(['init', '--no-service', '--size', '0', '--json'], { cwd: sub });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.pool, 'my-app-web');
    assert.equal(t.config().pools['my-app-web'].projectDir, t.project);
  } finally { t.cleanup(); }
});

test('init: missing definition file is USAGE unless --snapshot', () => {
  const t = makeEnv({ def: false });
  try {
    const r = t.run(['init', '--no-service', '--json']);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'USAGE');
    const r2 = t.run(['init', '--no-service', '--snapshot', 'MySnap', '--json']);
    assert.equal(r2.code, 0, r2.stdout);
    assert.equal(r2.json.config.snapshot, 'MySnap');
    const create = t.ran('org create scratch')[0];
    assert.equal(create.argv[create.argv.indexOf('--snapshot') + 1], 'MySnap');
    assert.ok(!create.argv.includes('-f'));
  } finally { t.cleanup(); }
});

test('init: re-run is idempotent and updates the pool', () => {
  const t = makeEnv();
  try {
    t.run(['init', '--no-service', '--size', '0', '--json']);
    const r = t.run(['init', '--no-service', '--size', '0', '--duration', '5', '--json']);
    assert.equal(r.code, 0);
    assert.equal(Object.keys(t.config().pools).length, 1);
    assert.equal(t.config().pools['my-app'].durationDays, 5);
    assert.equal(t.config().pools['my-app'].size, 0);
  } finally { t.cleanup(); }
});

test('init: SF_OLD warning for old sf, not a failure', () => {
  const t = makeEnv({ scenario: { version: '2.100.0' } });
  try {
    const r = t.run(['init', '--no-service', '--size', '0', '--json']);
    assert.equal(r.code, 0);
    assert.ok(r.json.warnings.some((w) => /SF_OLD/.test(w)));
  } finally { t.cleanup(); }
});

test('init: SF_MISSING (127) when sf cannot be found', () => {
  const t = makeEnv();
  try {
    const r = t.run(['init', '--no-service', '--json'], { env: { SCRATCHPOOL_SF_BIN: path.join(t.root, 'nope', 'sf'), PATH: '/nonexistent' } });
    assert.equal(r.code, 127);
    assert.equal(r.json.error.code, 'SF_MISSING');
  } finally { t.cleanup(); }
});

test('init: DE hub (DailyScratchOrgs.max <= 6) defaults duration to 3 days', () => {
  const t = makeEnv({ scenario: { limits: { ActiveScratchOrgs: { max: 3, remaining: 3 }, DailyScratchOrgs: { max: 6, remaining: 6 } } } });
  try {
    const r = t.run(['init', '--no-service', '--json']);
    assert.equal(r.code, 0, r.stdout);
    const create = t.ran('org create scratch')[0];
    assert.equal(create.argv[create.argv.indexOf('-y') + 1], '3');
  } finally { t.cleanup(); }
});
