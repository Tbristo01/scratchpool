import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initPool, org, HUB, assertNoSecrets } from './helpers.mjs';

const entry = (alias, username, o = {}) => ({
  alias, username, orgId: '00D000000000001AAA', defHash: o.defHash || 'x', createdAt: o.createdAt || '2026-09-30T00:00:00.000Z',
  expiresAt: o.expiresAt || '2026-10-08', status: o.status || 'ready', claimedAs: o.claimedAs || null, claimedAt: null,
  pid: o.pid ?? null, error: null,
});

function currentHash(t) {
  // the hash of an entry created by the pool itself
  const r = t.run(['config', 'set', 'size', '1', '--json']);
  assert.equal(r.code, 0);
  t.run(['tick', '--json']);
  const h = t.state().entries[0].defHash;
  return h;
}

test('tick: fills to size with detached-worker creates (sync in tests)', () => {
  const t = initPool({ size: 0 });
  try {
    assert.equal(t.run(['config', 'set', 'size', '3', '--json']).code, 0);
    assert.equal(t.ran('org create').length, 0, 'config set never creates');
    const r = t.run(['tick', '--json']);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.command, 'tick');
    const p = r.json.pools[0];
    assert.equal(p.name, 'my-app');
    assert.equal(p.started, 3);
    assert.equal(p.ready, 3);
    assert.equal(p.skipped, null);
    assert.equal(t.state().entries.filter((e) => e.status === 'ready').length, 3);
    assert.equal(t.ran('org list limits').length, 1);
    // second tick: nothing to do, no limits call
    t.clearCalls();
    const r2 = t.run(['tick', '--json']);
    assert.equal(r2.json.pools[0].started, 0);
    assert.equal(t.ran('org list limits').length, 0);
    assert.equal(t.ran('org create').length, 0);
    assert.ok(/started|create/.test(t.log()), 'log lines appended');
    assertNoSecrets(assert, t.allCaptured());
  } finally { t.cleanup(); }
});

test('tick: DAILY_FLOOR skips refill', () => {
  const t = initPool({ size: 0 });
  try {
    t.run(['config', 'set', 'size', '2', '--json']);
    t.setScenario({ limits: { ActiveScratchOrgs: { max: 40, remaining: 40 }, DailyScratchOrgs: { max: 80, remaining: 1 } } });
    const r = t.run(['tick', '--json']);
    assert.equal(r.code, 0);
    assert.equal(r.json.pools[0].skipped, 'DAILY_FLOOR');
    assert.equal(r.json.pools[0].started, 0);
    assert.equal(t.ran('org create').length, 0);
  } finally { t.cleanup(); }
});

test('tick: TEAM_CAP skips refill when tagged hub records >= cap', () => {
  const t = initPool({ size: 0 });
  try {
    t.run(['config', 'set', 'size', '2', '--json']);
    const recs = Array.from({ length: 10 }, (_, i) => ({ Id: `2SR${i}`, SignupUsername: `o${i}@x.com`, Description: `scratchpool:v1:other${i}@corp.com:abc`, ExpirationDate: '2026-10-08', Status: 'Active' }));
    t.setDb({ scratchOrgs: [], hubRecords: recs });
    const r = t.run(['tick', '--json']);
    assert.equal(r.json.pools[0].skipped, 'TEAM_CAP');
    assert.equal(t.ran('org create').length, 0);
    assert.equal(t.ran('data query').length, 1);
  } finally { t.cleanup(); }
});

test('tick: untagged Active hub records do not count toward TEAM_CAP (tag matched client-side)', () => {
  const t = initPool({ size: 0 });
  try {
    t.run(['config', 'set', 'size', '1', '--json']);
    const recs = Array.from({ length: 30 }, (_, i) => ({ Id: `2SR${i}`, SignupUsername: `u${i}@x.com`, Description: i % 2 ? null : 'my team org', ExpirationDate: '2026-10-08', Status: 'Active' }));
    t.setDb({ scratchOrgs: [], hubRecords: recs });
    const r = t.run(['tick', '--json']);
    assert.equal(r.json.pools[0].skipped, null);
    assert.equal(r.json.pools[0].started, 1);
    const q = t.ran('data query')[0];
    assert.ok(!q.argv.join(' ').includes('LIKE'), 'Description is never filtered in SOQL');
  } finally { t.cleanup(); }
});

test('tick: own claimed orgs do not count toward TEAM_CAP (Developer Edition hub, 3 active)', () => {
  const t = initPool({ size: 1, scenario: { limits: { ActiveScratchOrgs: { max: 3, remaining: 3 }, DailyScratchOrgs: { max: 6, remaining: 6 } } } });
  try {
    const c = t.run(['claim', 'MINE-1', '--json', '--no-open']);
    assert.equal(c.json.source, 'pool');
    // The claimed org is still tagged on the hub; before the fix it filled the 25% cap (ceil = 1) and blocked refill.
    assert.equal(c.json.counts.claimed, 1);
    assert.equal(c.json.counts.ready, 1, 'post-claim tick refilled despite the claimed tagged org');
  } finally { t.cleanup(); }
});

test('tick: activeReserve limits startable', () => {
  const t = initPool({ size: 0 });
  try {
    t.run(['config', 'set', 'size', '5', '--json']);
    t.setScenario({ limits: { ActiveScratchOrgs: { max: 40, remaining: 3 }, DailyScratchOrgs: { max: 80, remaining: 80 } } });
    const r = t.run(['tick', '--json']);
    assert.equal(r.json.pools[0].started, 2);
    t.setScenario({ limits: { ActiveScratchOrgs: { max: 40, remaining: 1 }, DailyScratchOrgs: { max: 80, remaining: 80 } } });
    t.clearCalls();
    const r2 = t.run(['tick', '--json']);
    assert.equal(r2.json.pools[0].started, 0);
    assert.ok(r2.json.pools[0].skipped);
    assert.equal(t.ran('org create').length, 0);
  } finally { t.cleanup(); }
});

test('tick: surplus ready orgs released (youngest first) after size lowered', () => {
  const t = initPool({ size: 0 });
  try {
    t.run(['config', 'set', 'size', '3', '--json']);
    t.run(['tick', '--json']);
    // make createdAt distinct
    const st = t.state();
    st.entries.forEach((e, i) => { e.createdAt = `2026-10-0${i + 1}T00:00:00.000Z`; });
    t.writeState(st);
    const set = t.run(['config', 'set', 'size', '1', '--json']);
    assert.equal(set.code, 0);
    assert.equal(t.ran('org delete').length, 0, 'config set never deletes');
    t.clearCalls();
    const r = t.run(['tick', '--json']);
    assert.equal(r.json.pools[0].released.length, 2);
    assert.equal(t.ran('org delete scratch').length, 2);
    const left = t.state().entries;
    assert.equal(left.length, 1);
    assert.equal(left[0].alias, st.entries[0].alias, 'oldest kept');
  } finally { t.cleanup(); }
});

test('tick: recycles low-life, expired and failed entries, then refills', () => {
  const t = initPool({ size: 0 });
  try {
    const h = currentHash(t);
    t.run(['config', 'set', 'size', '1', '--json']);
    const db = t.db();
    db.scratchOrgs = [org('sp-my-app-aaaa', 'low@x.com', { exp: '2026-10-02' }), org('sp-my-app-bbbb', 'gone@x.com', { exp: '2026-09-30', isExpired: true }), org('sp-my-app-dddd', 'hookfail@x.com')];
    t.setDb(db);
    t.writeState({ schema: 1, entries: [
      entry('sp-my-app-aaaa', 'low@x.com', { expiresAt: '2026-10-02', defHash: h }),
      entry('sp-my-app-bbbb', 'gone@x.com', { expiresAt: '2026-09-30', defHash: h }),
      entry('sp-my-app-cccc', null, { status: 'failed' }),
      entry('sp-my-app-dddd', 'hookfail@x.com', { status: 'failed' }),
    ] });
    t.clearCalls();
    const r = t.run(['tick', '--json']);
    assert.equal(r.code, 0, r.stdout);
    const p = r.json.pools[0];
    assert.deepEqual([...p.released].sort(), ['sp-my-app-aaaa', 'sp-my-app-bbbb', 'sp-my-app-cccc', 'sp-my-app-dddd']);
    const dels = t.ran('org delete scratch').map((c) => c.argv[c.argv.indexOf('-o') + 1]);
    assert.ok(dels.includes('low@x.com'));
    assert.ok(dels.includes('hookfail@x.com'));
    assert.equal(p.started, 1);
    const st = t.state().entries;
    assert.equal(st.length, 1);
    assert.equal(st[0].status, 'ready');
  } finally { t.cleanup(); }
});

test('tick: reconcile marks dead creating worker older than 45 min as failed', () => {
  const t = initPool({ size: 0 });
  try {
    t.writeState({ schema: 1, entries: [
      entry('sp-my-app-dead', null, { status: 'creating', pid: 2147483646, createdAt: '2026-10-01T10:00:00.000Z' }),
      entry('sp-my-app-yung', null, { status: 'creating', pid: 2147483645, createdAt: '2026-10-01T11:50:00.000Z' }),
    ] });
    t.run(['pause', '--json']); // keep recycle from removing the failed entry so we can see it
    const r = t.run(['tick', '--json']);
    assert.equal(r.json.pools[0].skipped, 'paused');
    const st = t.state().entries;
    assert.equal(st.find((e) => e.alias === 'sp-my-app-dead').status, 'failed');
    assert.ok(st.find((e) => e.alias === 'sp-my-app-dead').error);
    assert.equal(st.find((e) => e.alias === 'sp-my-app-yung').status, 'creating');
  } finally { t.cleanup(); }
});

test('tick: claimed entry missing from org list is removed; ready missing becomes expired', () => {
  const t = initPool({ size: 0 });
  try {
    t.writeState({ schema: 1, entries: [
      entry('sp-my-app-c1', 'c1@x.com', { status: 'claimed', claimedAs: 'feat' }),
      entry('sp-my-app-r1', 'r1@x.com'),
    ] });
    t.run(['pause', '--json']);
    t.run(['tick', '--json']);
    const st = t.state().entries;
    assert.equal(st.length, 1);
    assert.equal(st[0].status, 'expired');
  } finally { t.cleanup(); }
});

test('tick: paused pool creates nothing; resume fills', () => {
  const t = initPool({ size: 0 });
  try {
    t.run(['config', 'set', 'size', '1', '--json']);
    const p = t.run(['pause', '--json']);
    assert.equal(p.code, 0);
    assert.equal(t.config().pools['my-app'].paused, true);
    const r = t.run(['tick', '--json']);
    assert.equal(r.json.pools[0].skipped, 'paused');
    assert.equal(r.json.pools[0].paused, true);
    assert.equal(t.ran('org create').length, 0);
    assert.equal(t.run(['resume', '--json']).code, 0);
    const r2 = t.run(['tick', '--json']);
    assert.equal(r2.json.pools[0].started, 1);
  } finally { t.cleanup(); }
});

test('tick: skips a pool whose tick lock is held', () => {
  const t = initPool({ size: 0 });
  try {
    t.run(['config', 'set', 'size', '1', '--json']);
    const lock = path.join(t.home, 'state', 'my-app.tick.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, String(process.pid));
    const r = t.run(['tick', '--json']);
    assert.equal(r.code, 0);
    assert.equal(r.json.pools[0].skipped, 'locked');
    assert.equal(t.ran('org create').length, 0);
    fs.rmSync(lock);
    assert.equal(t.run(['tick', '--json']).json.pools[0].started, 1);
  } finally { t.cleanup(); }
});

test('tick: create failure marks entry failed with a scrubbed error (no secrets anywhere)', () => {
  const t = initPool({ size: 0 });
  try {
    t.setScenario({ fail: { 'org create scratch': { exitCode: 1, name: 'GenericError', message: 'boom force://LEAK:tok@x.my.salesforce.com sid=LEAKSID access_token=LEAK1 https://x/secur/frontdoor.jsp?sid=LEAK 00DABCDEFGHIJKLMNO!LEAKtok.x refresh_token=LEAK2' } } });
    t.run(['config', 'set', 'size', '1', '--json']);
    t.run(['pause', '--json']);
    t.run(['resume', '--json']);
    const r = t.run(['tick', '--json']);
    assert.equal(r.code, 0);
    const st = t.state().entries;
    assert.equal(st.length, 1);
    assert.equal(st[0].status, 'failed');
    assert.match(st[0].error, /boom/);
    assert.match(st[0].error, /REDACTED/);
    assertNoSecrets(assert, t.allCaptured());
  } finally { t.cleanup(); }
});

test('tick: setup hook runs with SCRATCHPOOL_TARGET; failure marks failed', { skip: process.platform === 'win32' }, () => {
  const t = initPool({ size: 0 });
  try {
    const dir = path.join(t.project, '.scratchpool');
    fs.mkdirSync(dir);
    const marker = path.join(t.root, 'hook.txt');
    fs.writeFileSync(path.join(dir, 'setup'), `#!/bin/sh\necho "$SCRATCHPOOL_TARGET" >> "${marker}"\n`, { mode: 0o755 });
    t.run(['config', 'set', 'setupHook', 'true', '--json']);
    t.run(['config', 'set', 'size', '1', '--json']);
    const r = t.run(['tick', '--json']);
    assert.equal(r.json.pools[0].ready, 1);
    const alias = t.state().entries[0].alias;
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), alias);
    // failing hook
    fs.writeFileSync(path.join(dir, 'setup'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    t.run(['config', 'set', 'setupHook', 'true', '--json']); // re-trust the changed hook
    t.run(['config', 'set', 'size', '2', '--json']);
    t.run(['tick', '--json']);
    const failed = t.state().entries.filter((e) => e.status === 'failed');
    // the old ready entry is now stale (hook content changed the defHash) but still ready
    assert.equal(failed.length, 1);
    assert.match(failed[0].error, /setup/i);
  } finally { t.cleanup(); }
});

test('tick: a setup hook changed since it was enabled is not run and no org is created (SETUP_UNTRUSTED)', { skip: process.platform === 'win32' }, () => {
  const t = initPool({ size: 0 });
  try {
    const dir = path.join(t.project, '.scratchpool');
    fs.mkdirSync(dir);
    const marker = path.join(t.root, 'pulled.txt');
    fs.writeFileSync(path.join(dir, 'setup'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    t.run(['config', 'set', 'setupHook', 'true', '--json']);
    // e.g. a git pull rewrites the hook
    fs.writeFileSync(path.join(dir, 'setup'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    t.run(['config', 'set', 'size', '1', '--json']);
    const r = t.run(['tick', '--json']);
    assert.equal(r.json.pools[0].skipped, 'SETUP_UNTRUSTED');
    assert.equal(t.ran('org create scratch').length, 0);
    assert.equal(fs.existsSync(marker), false, 'changed hook must not run');
    // re-enabling trusts the current contents
    t.run(['config', 'set', 'setupHook', 'true', '--json']);
    const r2 = t.run(['tick', '--json']);
    assert.equal(r2.json.pools[0].ready, 1);
    assert.equal(fs.existsSync(marker), true);
  } finally { t.cleanup(); }
});

test('_worker: with no matching creating entry does nothing', () => {
  const t = initPool({ size: 0 });
  try {
    t.writeState({ schema: 1, entries: [] });
    const r = t.run(['_worker', '--pool', 'my-app', '--alias', 'sp-my-app-zzzz']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(t.ran('org create').length, 0, 'no entry -> nothing to create');
  } finally { t.cleanup(); }
});

test('tick with no --pool runs every pool; --pool selects one', () => {
  const t = initPool({ size: 0 });
  try {
    const other = path.join(t.root, 'other');
    fs.mkdirSync(path.join(other, 'config'), { recursive: true });
    fs.copyFileSync(path.join(t.project, 'sfdx-project.json'), path.join(other, 'sfdx-project.json'));
    fs.copyFileSync(path.join(t.project, 'config', 'project-scratch-def.json'), path.join(other, 'config', 'project-scratch-def.json'));
    assert.equal(t.run(['init', '--no-service', '--size', '0', '--json'], { cwd: other }).code, 0);
    const r = t.run(['tick', '--json'], { cwd: t.root });
    assert.deepEqual(r.json.pools.map((p) => p.name).sort(), ['my-app', 'other']);
    const r2 = t.run(['tick', '--pool', 'other', '--json'], { cwd: t.root });
    assert.deepEqual(r2.json.pools.map((p) => p.name), ['other']);
    void HUB;
  } finally { t.cleanup(); }
});
