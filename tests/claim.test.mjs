import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initPool, org, assertNoSecrets } from './helpers.mjs';

test('claim: warm path makes NO limits call and NO create; renames alias; sets target-org; post-claim tick refills', () => {
  const t = initPool({ size: 1 });
  try {
    const before = t.state().entries[0];
    assert.equal(before.status, 'ready');
    t.clearCalls();
    const r = t.run(['claim', 'feature-x', '--json']);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.status, 'ready');
    assert.equal(r.json.source, 'pool');
    assert.equal(r.json.alias, 'feature-x');
    assert.equal(r.json.username, before.username);
    assert.equal(r.json.orgId, before.orgId);
    assert.equal(r.json.expiresAt, before.expiresAt);
    assert.equal(r.json.lifeLeftHours, 156);
    assert.equal(r.json.setupRan, false);

    const calls = t.calls();
    // The claim itself: everything before the post-claim tick's first call. The claim's last sf call is
    // `config set target-org`; nothing before it may be a limits call or a create.
    const lastClaimCall = calls.findIndex((c) => c.argv[0] === 'config' && c.argv[1] === 'set');
    assert.ok(lastClaimCall > 0);
    const claimCalls = calls.slice(0, lastClaimCall + 1);
    assert.ok(!claimCalls.some((c) => c.argv.join(' ').startsWith('org list limits')), 'warm claim made a limits call');
    assert.equal(t.ran('org list limits').length, 1, 'only the post-claim refill reads limits');
    assert.ok(!claimCalls.some((c) => c.argv.join(' ').startsWith('org create')));
    const keys = claimCalls.map((c) => c.argv.slice(0, 3).join(' '));
    assert.ok(keys.includes(`alias set feature-x=${before.username}`));
    assert.ok(keys.includes(`alias unset ${before.alias}`));
    const cs = claimCalls.find((c) => c.argv[0] === 'config' && c.argv[1] === 'set');
    assert.deepEqual(cs.argv.slice(0, 3), ['config', 'set', 'target-org=feature-x']);
    assert.equal(cs.cwd, t.project);

    const st = t.state().entries;
    const claimed = st.find((e) => e.status === 'claimed');
    assert.equal(claimed.claimedAs, 'feature-x');
    assert.ok(claimed.claimedAt);
    // post-claim tick (sync in tests) started a replacement
    assert.equal(st.filter((e) => e.status === 'ready').length, 1);
    assert.equal(t.ran('org create').length, 1);
    assertNoSecrets(assert, t.allCaptured());
  } finally { t.cleanup(); }
});

test('claim: idempotent existing alias returns source existing without touching the pool', () => {
  const t = initPool({ size: 1 });
  try {
    t.run(['claim', 'feat', '--json']);
    t.clearCalls();
    const r = t.run(['claim', 'feat', '--json']);
    assert.equal(r.code, 0);
    assert.equal(r.json.source, 'existing');
    assert.equal(r.json.alias, 'feat');
    assert.equal(t.ran('alias set').length, 0);
    assert.equal(t.ran('org create').length, 0);
  } finally { t.cleanup(); }
});

test('claim: POOL_EMPTY (exit 4, retryable) for --json with an empty pool', () => {
  const t = initPool({ size: 0 });
  try {
    const r = t.run(['claim', 'x', '--json']);
    assert.equal(r.code, 4);
    assert.equal(r.json.status, 'error');
    assert.equal(r.json.error.code, 'POOL_EMPTY');
    assert.equal(r.json.error.retryable, true);
    assert.equal(r.json.refillEtaMin, 5);
    assert.equal(r.json.counts.ready, 0);
    assert.equal(t.ran('org create').length, 0);
    assert.equal(t.ran('org list limits').length, 1, 'cold path checks limits');
  } finally { t.cleanup(); }
});

test('claim: LIMIT (exit 3) on cold path when no remaining allocation', () => {
  const t = initPool({ size: 0 });
  try {
    t.setScenario({ limits: { ActiveScratchOrgs: { max: 40, remaining: 0 }, DailyScratchOrgs: { max: 80, remaining: 5 } } });
    const r = t.run(['claim', 'x', '--cold', '--yes', '--json']);
    assert.equal(r.code, 3);
    assert.equal(r.json.error.code, 'LIMIT');
    assert.equal(r.json.limits.activeRemaining, 0);
  } finally { t.cleanup(); }
});

test('claim: --cold without --yes is CONFIRM_REQUIRED when not interactive and creates nothing', () => {
  const t = initPool({ size: 0 });
  try {
    const r = t.run(['claim', 'agent-asked', '--cold', '--json']);
    assert.equal(r.code, 1, r.stdout);
    assert.equal(r.json.error.code, 'CONFIRM_REQUIRED');
    assert.equal(t.ran('org create scratch').length, 0);
  } finally { t.cleanup(); }
});

test('claim: --cold creates fresh under the requested alias with coldDurationDays', () => {
  const t = initPool({ size: 0 });
  try {
    const r = t.run(['claim', 'hotfix', '--cold', '--yes', '--json']);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.source, 'fresh');
    assert.equal(r.json.alias, 'hotfix');
    const c = t.ran('org create scratch')[0];
    assert.equal(c.argv[c.argv.indexOf('-a') + 1], 'hotfix');
    assert.equal(c.argv[c.argv.indexOf('-y') + 1], '1');
    const e = t.state().entries[0];
    assert.equal(e.status, 'claimed');
    assert.equal(e.claimedAs, 'hotfix');
    assert.ok(t.ran('config set target-org=hotfix').length === 1);
    assertNoSecrets(assert, t.allCaptured());
  } finally { t.cleanup(); }
});

test('claim: stale defHash entries skipped unless --any', () => {
  const t = initPool({ size: 1 });
  try {
    const st = t.state();
    st.entries[0].defHash = 'deadbeef0000';
    t.writeState(st);
    t.run(['pause', '--json']);
    const r = t.run(['claim', 'a1', '--json']);
    assert.equal(r.json.error.code, 'POOL_EMPTY');
    const r2 = t.run(['claim', 'a1', '--any', '--json']);
    assert.equal(r2.code, 0, r2.stdout);
    assert.equal(r2.json.source, 'pool');
  } finally { t.cleanup(); }
});

test('claim: entries with less than claimMinLifeHours are not handed out', () => {
  const t = initPool({ size: 1 });
  try {
    t.run(['pause', '--json']);
    const st = t.state();
    st.entries[0].expiresAt = '2026-10-02'; // 12h left
    t.writeState(st);
    const db = t.db();
    db.scratchOrgs[0].expirationDate = '2026-10-02';
    t.setDb(db);
    assert.equal(t.run(['claim', 'z', '--json']).json.error.code, 'POOL_EMPTY');
    t.run(['config', 'set', 'claimMinLifeHours', '6', '--json']);
    assert.equal(t.run(['claim', 'z', '--json']).json.source, 'pool');
  } finally { t.cleanup(); }
});

test('claim: ready entry missing from sf org list is not handed out', () => {
  const t = initPool({ size: 1 });
  try {
    t.run(['pause', '--json']);
    t.setDb({ scratchOrgs: [], hubRecords: [] });
    const r = t.run(['claim', 'q', '--json']);
    assert.equal(r.json.error.code, 'POOL_EMPTY');
  } finally { t.cleanup(); }
});

test('claim: oldest eligible entry is chosen', () => {
  const t = initPool({ size: 2 });
  try {
    const st = t.state();
    st.entries[0].createdAt = '2026-09-30T09:00:00.000Z';
    st.entries[1].createdAt = '2026-09-29T09:00:00.000Z';
    t.writeState(st);
    const r = t.run(['claim', 'old', '--json']);
    assert.equal(r.json.username, st.entries[1].username);
  } finally { t.cleanup(); }
});

test('claim: default alias sp-<yyyymmdd>-<4hex>; invalid alias is USAGE', () => {
  const t = initPool({ size: 1 });
  try {
    const r = t.run(['claim', '--json']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.json.alias, /^sp-20261001-[0-9a-f]{4}$/);
    const bad = t.run(['claim', 'bad alias;rm', '--json']);
    assert.equal(bad.code, 1);
    assert.equal(bad.json.error.code, 'USAGE');
  } finally { t.cleanup(); }
});

test('claim: never opens the browser without a TTY', () => {
  const t = initPool({ size: 1 });
  try {
    t.run(['claim', 'o1']);
    assert.equal(t.ran('org open').length, 0);
  } finally { t.cleanup(); }
});

test('claim: existing check ignores expired orgs', () => {
  const t = initPool({ size: 0 });
  try {
    t.setDb({ scratchOrgs: [org('old', 'old@x.com', { exp: '2026-09-01', isExpired: true })], hubRecords: [] });
    const r = t.run(['claim', 'old', '--json']);
    assert.equal(r.json.error.code, 'POOL_EMPTY');
  } finally { t.cleanup(); }
});
