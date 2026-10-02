import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, initPool, assertNoSecrets } from './helpers.mjs';
import { scrub } from '../skills/scratchpool/scripts/lib/util.mjs';
import { computeDefHash } from '../skills/scratchpool/scripts/lib/store.mjs';

test('scrub redacts every secret pattern', () => {
  const s = scrub('a force://x:y@z b 00DABCDEFGHIJKLMNO!AQ.tok c sid=abc d access_token=xyz e https://h/secur/frontdoor.jsp?x=1 f refresh_token=r g');
  assert.doesNotMatch(s, /force:\/\/|AQ\.tok|sid=abc|access_token=xyz|frontdoor|refresh_token=r/);
  assert.match(s, /^a \[REDACTED\] b \[REDACTED\] c/);
});

test('defHash: 12 hex, changes with def/namespace/hub/hook', () => {
  const base = { def: 'A', namespace: '', hubUsername: 'h', hook: null };
  const h = computeDefHash(base);
  assert.match(h, /^[0-9a-f]{12}$/);
  assert.notEqual(computeDefHash({ ...base, def: 'B' }), h);
  assert.notEqual(computeDefHash({ ...base, namespace: 'ns' }), h);
  assert.notEqual(computeDefHash({ ...base, hubUsername: 'g' }), h);
  assert.notEqual(computeDefHash({ ...base, hook: 'x' }), h);
});

test('SECRETS_ENV: every command refuses when SF_TEMP_SHOW_SECRETS is set', () => {
  const t = initPool({ size: 0 });
  try {
    for (const args of [['status'], ['claim', 'x'], ['tick'], ['init', '--no-service'], ['release', '--pool-orgs', '--yes']]) {
      const r = t.run([...args, '--json'], { env: { SF_TEMP_SHOW_SECRETS: '1' } });
      assert.equal(r.code, 1);
      assert.equal(r.json.error.code, 'SECRETS_ENV');
    }
    assert.equal(t.calls().length, 0, 'no sf call made');
  } finally { t.cleanup(); }
});

test('NO_POOL: no config, and ambiguous with two pools outside both projects', () => {
  const t = makeEnv();
  try {
    const r = t.run(['status', '--json']);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'NO_POOL');
    assert.equal(t.run(['init', '--no-service', '--size', '0', '--json']).code, 0);
    // exactly one pool -> used from anywhere
    assert.equal(t.run(['status', '--json'], { cwd: t.root }).json.pool, 'my-app');
    const other = path.join(t.root, 'other');
    fs.mkdirSync(path.join(other, 'config'), { recursive: true });
    fs.copyFileSync(path.join(t.project, 'sfdx-project.json'), path.join(other, 'sfdx-project.json'));
    fs.copyFileSync(path.join(t.project, 'config/project-scratch-def.json'), path.join(other, 'config/project-scratch-def.json'));
    assert.equal(t.run(['init', '--no-service', '--size', '0', '--json'], { cwd: other }).code, 0);
    const amb = t.run(['status', '--json'], { cwd: t.root });
    assert.equal(amb.json.error.code, 'NO_POOL');
    assert.match(amb.json.error.message, /my-app/);
    assert.match(amb.json.error.message, /other/);
    // cwd inside a project picks it; --pool wins
    assert.equal(t.run(['status', '--json'], { cwd: other }).json.pool, 'other');
    assert.equal(t.run(['status', '--pool', 'my-app', '--json'], { cwd: other }).json.pool, 'my-app');
    assert.equal(t.run(['status', '--pool', 'nope', '--json']).json.error.code, 'NO_POOL');
  } finally { t.cleanup(); }
});

test('status/list: counts, entries, team, service; makes no sf calls', () => {
  const t = initPool({ size: 2 });
  try {
    t.run(['claim', 'mine', '--json']);
    t.clearCalls();
    for (const cmd of ['status', 'list']) {
      const r = t.run([cmd, '--json']);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.json.command, 'status');
      assert.equal(r.json.counts.ready, 2);
      assert.equal(r.json.counts.claimed, 1);
      assert.equal(r.json.counts.size, 2);
      assert.equal(r.json.counts.paused, false);
      assert.equal(r.json.entries.length, 3);
      for (const e of r.json.entries) assert.deepEqual(Object.keys(e).sort(), ['alias', 'claimedAs', 'lifeLeftHours', 'stale', 'status']);
      assert.ok('poolOrgs' in r.json.team && 'activeMax' in r.json.team && 'capPct' in r.json.team);
      assert.ok('installed' in r.json.service && 'intervalMinutes' in r.json.service && 'lastTick' in r.json.service);
      assert.ok(r.json.service.lastTick);
    }
    assert.equal(t.calls().length, 0);
  } finally { t.cleanup(); }
});

test('config: show/get/set with validation', () => {
  const t = initPool({ size: 0 });
  try {
    const show = t.run(['config', 'show', '--json']);
    assert.equal(show.code, 0);
    assert.equal(show.json.config.size, 0);
    assert.equal(t.run(['config', 'get', 'teamCapPct', '--json']).json.value, 25);
    const ok = t.run(['config', 'set', 'size', '4', '--json']);
    assert.equal(ok.code, 0);
    assert.equal(ok.json.config.size, 4);
    assert.equal(t.config().pools['my-app'].size, 4);
    for (const [k, v] of [['size', '51'], ['size', '-1'], ['size', 'abc'], ['size', '1.5'], ['teamCapPct', '0'], ['teamCapPct', '101'],
      ['setupHook', 'maybe'], ['bogus', '1'], ['durationDays', '31'], ['coldDurationDays', '0'], ['intervalMinutes', '0'], ['activeReserve', '-2'],
      ['definitionFile', 'config/missing.json']]) {
      const r = t.run(['config', 'set', k, v, '--json']);
      assert.equal(r.code, 1, `${k}=${v} should fail`);
      assert.equal(r.json.error.code, 'USAGE');
    }
    assert.equal(t.run(['config', 'set', 'durationDays', 'null', '--json']).json.config.durationDays, null);
    assert.equal(t.run(['config', 'set', 'snapshot', 'Snap1', '--json']).json.config.snapshot, 'Snap1');
    assert.equal(t.run(['config', 'set', 'setupHook', 'true', '--json']).json.config.setupHook, true);
    // global key; reinstalls the service in dry-run
    const iv = t.run(['config', 'set', 'intervalMinutes', '30', '--json']);
    assert.equal(iv.code, 0, iv.stdout);
    assert.equal(t.config().intervalMinutes, 30);
    assert.equal(t.run(['config', 'get', 'intervalMinutes', '--json']).json.value, 30);
    assert.equal(t.ran('org create').length + t.ran('org delete').length, 0);
    assert.equal(t.run(['config', 'frob', '--json']).json.error.code, 'USAGE');
  } finally { t.cleanup(); }
});

test('output: exactly one JSON object on stdout, even without --json when not a TTY', () => {
  const t = initPool({ size: 1 });
  try {
    for (const args of [['status'], ['tick'], ['claim', 'one'], ['config', 'show'], ['pause'], ['resume'], ['--version'], ['--help'], ['release', 'one', '--yes'], ['nonsense']]) {
      const r = t.run(args);
      const trimmed = r.stdout.trim();
      assert.ok(trimmed.startsWith('{') && trimmed.endsWith('}'), `${args.join(' ')}: ${r.stdout}`);
      const obj = JSON.parse(trimmed);
      assert.equal(obj.schema, 'scratchpool/v1');
      for (const k of ['command', 'status', 'pool', 'source', 'alias', 'username', 'orgId', 'instanceUrl', 'expiresAt', 'lifeLeftHours', 'setupRan', 'counts', 'limits', 'warnings', 'error']) {
        assert.ok(k in obj, `${args.join(' ')} missing ${k}`);
      }
      assert.equal(r.stderr, '', 'no stderr in JSON mode');
    }
    assert.equal(t.run(['nonsense']).code, 1);
    assert.equal(t.run(['--version']).json.version, '0.1.0');
  } finally { t.cleanup(); }
});

test('SF_ERROR passes sf exit code through; LIMIT detected from message', () => {
  const t = initPool({ size: 0 });
  try {
    t.setScenario({ fail: { 'org list': { exitCode: 68, name: 'SomethingBroke', message: 'nope force://LEAK' } } });
    const r = t.run(['claim', 'c', '--json']);
    assert.equal(r.code, 68);
    assert.equal(r.json.error.code, 'SF_ERROR');
    assert.doesNotMatch(r.stdout, /LEAK/);
    t.setScenario({ fail: { 'org create scratch': { exitCode: 1, name: 'ScratchOrgInfoError', message: 'The signup request failed because this organization has reached its active scratch org limit' } } });
    const r2 = t.run(['claim', 'c', '--cold', '--yes', '--json']);
    assert.equal(r2.code, 3);
    assert.equal(r2.json.error.code, 'LIMIT');
  } finally { t.cleanup(); }
});

test('service install|status|uninstall delegate to lib/service (dry-run)', () => {
  const t = initPool({ size: 0 });
  try {
    const i = t.run(['service', 'install', '--interval', '20', '--json']);
    assert.equal(i.code, 0, i.stdout);
    assert.equal(i.json.service.installed, true);
    assert.equal(t.config().intervalMinutes, 20);
    const s = t.run(['service', 'status', '--json']);
    assert.equal(s.json.service.installed, true);
    assert.equal(s.json.service.intervalMinutes, 20);
    const u = t.run(['service', 'uninstall', '--json']);
    assert.equal(u.json.service.installed, false);
    assert.equal(t.run(['service', 'status', '--json']).json.service.installed, false);
    assert.equal(t.run(['service', 'bogus', '--json']).json.error.code, 'USAGE');
  } finally { t.cleanup(); }
});

test('service: SERVICE_UNSUPPORTED surfaces as exit 1', () => {
  const t = initPool({ size: 0 });
  try {
    const r = t.run(['service', 'install', '--json'], { env: { SCRATCHPOOL_PLATFORM: 'sunos' } });
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'SERVICE_UNSUPPORTED');
  } finally { t.cleanup(); }
});

test('uninstall: removes service; --release-pool-orgs needs --yes and keeps claimed orgs', () => {
  const t = initPool({ size: 2 });
  try {
    t.run(['service', 'install', '--json']);
    t.run(['pause', '--json']);
    t.run(['claim', 'keepme', '--json']);
    const no = t.run(['uninstall', '--release-pool-orgs', '--json']);
    assert.equal(no.json.error.code, 'CONFIRM_REQUIRED');
    assert.equal(t.run(['service', 'status', '--json']).json.service.installed, true);
    const r = t.run(['uninstall', '--release-pool-orgs', '--yes', '--json']);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.service.installed, false);
    assert.equal(r.json.deleted.length, 1);
    const left = t.state().entries;
    assert.equal(left.length, 1);
    assert.equal(left[0].claimedAs, 'keepme');
  } finally { t.cleanup(); }
});

test('secret grep: a full lifecycle leaves no secrets in stdout, state or logs', () => {
  const t = initPool({ size: 2 });
  try {
    t.run(['claim', 'a', '--json']);
    t.run(['claim', 'b', '--cold', '--yes', '--json']);
    t.run(['status', '--json']);
    t.run(['tick', '--json']);
    t.setScenario({ fail: { 'org delete scratch': { exitCode: 1, message: 'x force://LEAK@y', match: ['-o'], times: 1 } } });
    t.run(['release', 'a', '--yes', '--json']);
    t.run(['release', '--pool-orgs', '--yes', '--json']);
    assertNoSecrets(assert, t.allCaptured());
    assert.ok(t.log().length > 0);
  } finally { t.cleanup(); }
});

test('log rotates at 1 MB keeping one backup', () => {
  const t = initPool({ size: 0 });
  try {
    const log = path.join(t.home, 'logs', 'scratchpool.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, 'x'.repeat(1024 * 1024 + 10));
    t.run(['config', 'set', 'size', '1', '--json']);
    t.run(['tick', '--json']);
    assert.ok(fs.existsSync(log + '.1'));
    assert.ok(fs.statSync(log).size < 1024 * 1024);
  } finally { t.cleanup(); }
});
