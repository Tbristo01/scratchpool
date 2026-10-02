import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initPool, org, HUB, assertNoSecrets } from './helpers.mjs';

test('release <alias>: deletes a claimed org by its claimed alias and removes it from state', () => {
  const t = initPool({ size: 1 });
  try {
    t.run(['pause', '--json']);
    const u = t.state().entries[0].username;
    t.run(['claim', 'feat', '--json']);
    t.clearCalls();
    const r = t.run(['release', 'feat', '--yes', '--json']);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.command, 'release');
    assert.deepEqual(r.json.deleted, ['feat']);
    assert.deepEqual(r.json.skipped, []);
    const d = t.ran('org delete scratch')[0];
    assert.deepEqual(d.argv, ['org', 'delete', 'scratch', '-o', u, '--no-prompt', '--json']);
    assert.equal(t.state().entries.length, 0);
  } finally { t.cleanup(); }
});

test('release: hidden "return" alias works', () => {
  const t = initPool({ size: 1 });
  try {
    t.run(['pause', '--json']);
    t.run(['claim', 'feat', '--json']);
    const r = t.run(['return', 'feat', '--yes', '--json']);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.command, 'release');
    assert.deepEqual(r.json.deleted, ['feat']);
  } finally { t.cleanup(); }
});

test('release: CONFIRM_REQUIRED without --yes in non-interactive mode', () => {
  const t = initPool({ size: 1 });
  try {
    const a = t.state().entries[0].alias;
    const r = t.run(['release', a, '--json']);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'CONFIRM_REQUIRED');
    assert.equal(t.ran('org delete').length, 0);
  } finally { t.cleanup(); }
});

test('release: NOT_MANAGED for a scratch org of this hub not in state', () => {
  const t = initPool({ size: 0 });
  try {
    t.setDb({ scratchOrgs: [org('mine', 'mine@x.com')], hubRecords: [] });
    const r = t.run(['release', 'mine', '--yes', '--json']);
    assert.equal(r.code, 5);
    assert.equal(r.json.error.code, 'NOT_MANAGED');
    assert.match(r.json.error.message, /sf org delete scratch/);
    assert.equal(t.ran('org delete').length, 0);
  } finally { t.cleanup(); }
});

test('release: NOT_MINE when the state entry belongs to a different hub', () => {
  const t = initPool({ size: 0 });
  try {
    t.setDb({ scratchOrgs: [org('theirs', 'theirs@x.com', { hub: 'other@corp.com' })], hubRecords: [] });
    t.writeState({ schema: 1, entries: [{ alias: 'sp-my-app-1111', username: 'theirs@x.com', orgId: '00D1', defHash: 'x', createdAt: '2026-09-30T00:00:00.000Z', expiresAt: '2026-10-08', status: 'claimed', claimedAs: 'theirs', claimedAt: null, pid: null, error: null }] });
    const r = t.run(['release', 'theirs', '--yes', '--json']);
    assert.equal(r.code, 5);
    assert.equal(r.json.error.code, 'NOT_MINE');
    assert.equal(t.ran('org delete').length, 0);
  } finally { t.cleanup(); }
});

test('release: NOT_SCRATCH for an alias that is not a local scratch org', () => {
  const t = initPool({ size: 0 });
  try {
    const r = t.run(['release', HUB.alias, '--yes', '--json']);
    assert.equal(r.code, 5);
    assert.equal(r.json.error.code, 'NOT_SCRATCH');
    assert.equal(t.ran('org delete').length, 0);
  } finally { t.cleanup(); }
});

test('release --pool-orgs: deletes ready/creating/failed, never claimed', () => {
  const t = initPool({ size: 2 });
  try {
    t.run(['pause', '--json']);
    t.run(['claim', 'keep', '--json']);
    const st = t.state();
    st.entries.push({ alias: 'sp-my-app-cr01', username: null, orgId: null, defHash: 'x', createdAt: '2026-10-01T11:00:00.000Z', expiresAt: null, status: 'creating', claimedAs: null, claimedAt: null, pid: 2147483640, error: null });
    st.entries.push({ alias: 'sp-my-app-fl01', username: null, orgId: null, defHash: 'x', createdAt: '2026-10-01T11:00:00.000Z', expiresAt: null, status: 'failed', claimedAs: null, claimedAt: null, pid: null, error: 'x' });
    t.writeState(st);
    const claimedUser = st.entries.find((e) => e.status === 'claimed').username;
    t.clearCalls();
    const r = t.run(['release', '--pool-orgs', '--yes', '--json']);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.deleted.length, 3);
    assert.ok(!r.json.deleted.includes('keep'));
    const dels = t.ran('org delete scratch').map((c) => c.argv[4]);
    assert.ok(!dels.includes(claimedUser));
    assert.equal(dels.length, 1, 'only the ready org needs an sf delete');
    const left = t.state().entries;
    assert.equal(left.length, 1);
    assert.equal(left[0].status, 'claimed');
  } finally { t.cleanup(); }
});

test('release --surplus: deletes youngest ready beyond size', () => {
  const t = initPool({ size: 3 });
  try {
    t.run(['pause', '--json']);
    const st = t.state();
    st.entries.forEach((e, i) => { e.createdAt = `2026-09-2${i + 1}T00:00:00.000Z`; });
    t.writeState(st);
    t.run(['config', 'set', 'size', '1', '--json']);
    const r = t.run(['release', '--surplus', '--yes', '--json']);
    assert.equal(r.code, 0);
    assert.deepEqual([...r.json.deleted].sort(), [st.entries[1].alias, st.entries[2].alias].sort());
    assert.equal(t.state().entries[0].alias, st.entries[0].alias);
  } finally { t.cleanup(); }
});

test('release --stale: stale hash, expired and failed entries; never queries the hub for orphans', () => {
  const t = initPool({ size: 2 });
  try {
    t.run(['pause', '--json']);
    const st = t.state();
    st.entries[0].defHash = 'deadbeef0000';
    st.entries.push({ alias: 'sp-my-app-ex01', username: 'ex@x.com', orgId: '00D2', defHash: st.entries[1].defHash, createdAt: '2026-09-20T00:00:00.000Z', expiresAt: '2026-09-27', status: 'expired', claimedAs: null, claimedAt: null, pid: null, error: null });
    st.entries.push({ alias: 'sp-my-app-fl02', username: null, orgId: null, defHash: 'x', createdAt: '2026-09-20T00:00:00.000Z', expiresAt: null, status: 'failed', claimedAs: null, claimedAt: null, pid: null, error: 'x' });
    t.writeState(st);
    t.clearCalls();
    const r = t.run(['release', '--stale', '--yes', '--json']);
    assert.equal(r.code, 0, r.stdout);
    assert.ok(r.json.deleted.includes(st.entries[0].alias));
    assert.ok(r.json.deleted.includes('sp-my-app-ex01'));
    assert.ok(r.json.deleted.includes('sp-my-app-fl02'));
    assert.ok(!r.json.deleted.includes(st.entries[1].alias), 'current ready kept');
    assert.equal(t.ran('data query').length, 0);
    assert.equal(t.state().entries.length, 1);
    assertNoSecrets(assert, t.allCaptured());
  } finally { t.cleanup(); }
});

test('release --orphans: only this machine\'s old, unaliased, untracked records; never a colleague\'s, another machine\'s, a fresh or a claimed one', () => {
  const t = initPool({ size: 0 });
  try {
    const mid = t.config().machineId;
    assert.match(mid, /^[0-9a-f]{8}$/);
    const old = '2026-09-30T00:00:00.000Z';
    const d = (m) => `scratchpool:v1:${HUB.username}:abcabcabcabc:${m}`;
    const db = t.db();
    db.scratchOrgs.push(org(undefined, 'orphan@x.com'), org('sp-my-app-0a0a', 'workeralias@x.com'), org('my-feature', 'claimed@x.com'));
    db.hubRecords.push(
      { Id: '1', SignupUsername: 'orphan@x.com', Description: d(mid), Status: 'Active', CreatedDate: old },
      { Id: '2', SignupUsername: 'workeralias@x.com', Description: d(mid), Status: 'Active', CreatedDate: old },
      { Id: '3', SignupUsername: 'claimed@x.com', Description: d(mid), Status: 'Active', CreatedDate: old },
      { Id: '4', SignupUsername: 'fresh@x.com', Description: d(mid), Status: 'Active', CreatedDate: '2026-10-01T11:30:00.000Z' },
      { Id: '5', SignupUsername: 'othermachine@x.com', Description: d('ffffffff'), Status: 'Active', CreatedDate: old },
      { Id: '6', SignupUsername: 'colleague@x.com', Description: `scratchpool:v1:colleague@corp.com:abcabcabcabc:${mid}`, Status: 'Active', CreatedDate: old });
    t.setDb(db);
    t.clearCalls();
    const c = t.run(['release', '--orphans', '--json']);
    assert.equal(c.json.error.code, 'CONFIRM_REQUIRED');
    assert.match(c.json.error.message, /ORPHANED/);
    assert.equal(t.ran('org delete').length, 0);
    const r = t.run(['release', '--orphans', '--yes', '--json']);
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual([...r.json.deleted].sort(), ['orphan@x.com', 'sp-my-app-0a0a']);
    const dels = t.ran('org delete scratch').map((x) => x.argv[4]).sort();
    assert.deepEqual(dels, ['orphan@x.com', 'workeralias@x.com']);
    const sk = Object.fromEntries(r.json.skipped.map((x) => [x.alias, x.reason]));
    assert.match(sk['my-feature'], /alias/);
    assert.match(sk['fresh@x.com'], /less than an hour/);
    assert.equal(r.json.skipped.length, 2, 'other machine and colleague are not even listed');
  } finally { t.cleanup(); }
});

test('release: delete failure is reported as skipped with a scrubbed reason', () => {
  const t = initPool({ size: 1 });
  try {
    t.setScenario({ fail: { 'org delete scratch': { exitCode: 1, name: 'DeleteError', message: 'cannot delete force://LEAK@x sid=LEAKY' } } });
    const a = t.state().entries[0].alias;
    const r = t.run(['release', a, '--yes', '--json']);
    assert.deepEqual(r.json.deleted, []);
    assert.equal(r.json.skipped[0].alias, a);
    assert.match(r.json.skipped[0].reason, /REDACTED/);
    assert.equal(t.state().entries.length, 1);
    assertNoSecrets(assert, t.allCaptured());
  } finally { t.cleanup(); }
});

test('release: USAGE without targets', () => {
  const t = initPool({ size: 0 });
  try {
    const r = t.run(['release', '--yes', '--json']);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'USAGE');
  } finally { t.cleanup(); }
});
