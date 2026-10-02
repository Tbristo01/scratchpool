// Shared harness: temp SCRATCHPOOL_HOME + temp sfdx project + stub sf driven by a scenario file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPT = path.resolve(here, '../skills/scratchpool/scripts/scratchpool.mjs');
export const STUB = path.join(here, 'stub', process.platform === 'win32' ? 'sf.cmd' : 'sf');
export const NOW = '2026-10-01T12:00:00.000Z';
export const HUB = { alias: 'devhub', username: 'me@corp.com' };

// Secret patterns that must never appear in any captured stdout / state / log.
export const SECRET_PATTERNS = [/force:\/\//, /FAKEACCESS/, /FAKEREFRESH/, /5Aep/, /accessToken/i, /refreshToken/i,
  /sfdxAuthUrl/i, /frontdoor/i, /sid=/, /00DFAKE/, /LEAK/];

export function makeEnv(opts = {}) {
  // .native resolves Windows 8.3 short names (C:\Users\RUNNER~1 -> runneradmin) exactly as the CLI's
  // realpath() does; the JS fs.realpathSync leaves them, so expected and actual paths would differ.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-test-')));
  const home = path.join(root, 'home');
  const project = path.join(root, opts.projectName || 'my-app');
  fs.mkdirSync(path.join(project, 'config'), { recursive: true });
  fs.writeFileSync(path.join(project, 'sfdx-project.json'), JSON.stringify({
    packageDirectories: [{ path: 'force-app', default: true }], namespace: opts.namespace || '', sourceApiVersion: '62.0' }));
  if (opts.def !== false) {
    fs.writeFileSync(path.join(project, 'config', 'project-scratch-def.json'),
      JSON.stringify({ orgName: 'Test', edition: 'Developer' }));
  }
  const scenarioPath = path.join(root, 'scenario.json');
  const scenario = {
    version: '2.150.0', defaultHub: 'devhub', hubs: [HUB],
    limits: { ActiveScratchOrgs: { max: 40, remaining: 40 }, DailyScratchOrgs: { max: 80, remaining: 80 } },
    scratchOrgs: [], hubRecords: [], fail: {},
    ...(opts.scenario || {}),
  };
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2));
  const env = {
    PATH: process.env.PATH, HOME: root, TMPDIR: os.tmpdir(),
    SCRATCHPOOL_HOME: home, SCRATCHPOOL_SF_BIN: STUB, SCRATCHPOOL_NO_DETACH: '1', SCRATCHPOOL_NOW: NOW,
    SCRATCHPOOL_SERVICE_DRYRUN: '1', SCRATCHPOOL_PLATFORM: 'darwin', SCRATCHPOOL_STUB_SCENARIO: scenarioPath,
  };
  if (process.platform === 'win32') { env.SystemRoot = process.env.SystemRoot; env.APPDATA = path.join(root, 'appdata'); }
  const t = {
    root, home, project, scenarioPath, env, outputs: [],
    run(args, o = {}) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: o.cwd || project, env: { ...env, ...(o.env || {}) }, encoding: 'utf8', input: o.input ?? '', timeout: 60000,
      });
      t.outputs.push(r.stdout);
      let json = null;
      try { json = JSON.parse(r.stdout); } catch { /* asserted by caller */ }
      return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
    },
    calls() {
      try {
        return fs.readFileSync(scenarioPath + '.calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch { return []; }
    },
    clearCalls() { try { fs.rmSync(scenarioPath + '.calls.jsonl'); } catch {} },
    callKeys() { return t.calls().map((c) => c.argv.filter((a, i) => !a.startsWith('-') || i === 0).slice(0, 3).join(' ')); },
    ran(prefix) { return t.calls().filter((c) => c.argv.join(' ').startsWith(prefix)); },
    setScenario(patch) {
      const s = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
      fs.writeFileSync(scenarioPath, JSON.stringify({ ...s, ...patch }, null, 2));
    },
    db() {
      try { return JSON.parse(fs.readFileSync(scenarioPath + '.db.json', 'utf8')); } catch {
        const s = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
        return { scratchOrgs: s.scratchOrgs, hubRecords: s.hubRecords };
      }
    },
    setDb(db) { fs.writeFileSync(scenarioPath + '.db.json', JSON.stringify(db, null, 2)); },
    config() { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); },
    writeConfig(c) { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(c, null, 2)); },
    state(pool = 'my-app') {
      try { return JSON.parse(fs.readFileSync(path.join(home, 'state', `${pool}.json`), 'utf8')); } catch { return { schema: 1, entries: [] }; }
    },
    writeState(s, pool = 'my-app') {
      fs.mkdirSync(path.join(home, 'state'), { recursive: true });
      fs.writeFileSync(path.join(home, 'state', `${pool}.json`), JSON.stringify(s, null, 2));
    },
    log() { try { return fs.readFileSync(path.join(home, 'logs', 'scratchpool.log'), 'utf8'); } catch { return ''; } },
    // Every byte we can capture: stdout of every run + every file under home.
    allCaptured() {
      let text = t.outputs.join('\n');
      const walk = (d) => {
        if (!fs.existsSync(d)) return;
        for (const f of fs.readdirSync(d)) {
          const p = path.join(d, f);
          if (fs.statSync(p).isDirectory()) walk(p); else text += '\n' + fs.readFileSync(p, 'utf8');
        }
      };
      walk(home);
      return text;
    },
    // Retries: on Windows a just-exited detached worker can still hold the project dir open for a moment
    // (EBUSY on rmdir, seen in CI). rmSync retries EBUSY/EPERM/ENOTEMPTY with linear backoff.
    cleanup() { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); },
  };
  return t;
}

// Init a pool with --no-service and size; returns the env.
export function initPool(opts = {}) {
  const t = makeEnv(opts);
  const r = t.run(['init', '--no-service', '--size', String(opts.size ?? 1), '--json', ...(opts.initArgs || [])]);
  if (r.code !== 0) throw new Error(`init failed: ${r.stdout} ${r.stderr}`);
  t.clearCalls();
  return t;
}

export function assertNoSecrets(assert, text) {
  for (const p of SECRET_PATTERNS) assert.doesNotMatch(text, p, `secret pattern ${p} leaked`);
}

// A local scratch org record as the stub reports it.
export function org(alias, username, opts = {}) {
  return { alias, username, orgId: opts.orgId || '00D000000000001AAA', expirationDate: opts.exp || '2026-10-08',
    devHubUsername: opts.hub || HUB.username, isExpired: !!opts.isExpired, instanceUrl: `https://${alias}.example.com` };
}
