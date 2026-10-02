#!/usr/bin/env python3
"""Record a real scratchpool session as an asciinema v2 cast (no external tools).

Each step runs in a real pseudo-terminal, so scratchpool prints its human-mode output.
Long waits are compressed (idle gaps capped). Before the cast is written, personal
identifiers are redacted over the joined output, so a value split across two PTY reads is
still caught: every --redact OLD=NEW pair, every email address and every Salesforce org ID
(00D...). Usage:

    python3 scripts/record-demo.py <project-dir> <out.cast> [--redact OLD=NEW ...]
"""
import json, os, pty, re, select, subprocess, sys, time

COLS, ROWS = 104, 32
MAX_IDLE = 1.2          # seconds: longer gaps in output are compressed
TYPE_DELAY = 0.035      # simulated typing speed
PROMPT = "\x1b[1;32m~/scratchpool-demo\x1b[0m $ "
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
ORG_ID = re.compile(r"\b00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b")
SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skills", "scratchpool", "scripts", "scratchpool.mjs")


def redact_events(events, pairs):
    """Redact over the joined text. Events a match straddles are merged first, so no
    secret survives because it arrived in two PTY reads."""
    def spans(text):
        out = [(m.start(), m.end()) for rx in (EMAIL, ORG_ID) for m in rx.finditer(text)]
        for old, _ in pairs:
            i = text.find(old)
            while old and i != -1:
                out.append((i, i + len(old)))
                i = text.find(old, i + 1)
        return out

    starts, pos = [], 0
    for e in events:
        starts.append(pos)
        pos += len(e[2])
    joined = "".join(e[2] for e in events)
    merge_into = list(range(len(events)))
    for a, b in spans(joined):
        first = max(i for i, st in enumerate(starts) if st <= a)
        for i in range(first + 1, len(events)):
            if starts[i] < b:
                merge_into[i] = merge_into[first]
    merged = []
    for i, e in enumerate(events):
        if merge_into[i] != i and merged:
            merged[-1][2] += e[2]
        else:
            merged.append([e[0], e[1], e[2]])
    for e in merged:
        for old, new in pairs:
            e[2] = e[2].replace(old, new)
        e[2] = EMAIL.sub(lambda m: "test-" + "x" * 12 + "@example.com", e[2])
        e[2] = ORG_ID.sub("00D000000000000AAA", e[2])
    return merged


def main():
    proj, out = sys.argv[1], sys.argv[2]
    redact = [a.split("=", 1) for a in sys.argv[4:] if "=" in a] if "--redact" in sys.argv else []
    sp = f"node '{os.path.normpath(SCRIPT)}'"

    steps = [
        ("# Set up once: your own Dev Hub, a pool of 1, setup hook deploys the source", None),
        ("scratchpool init --hub devhub --size 1 --setup-hook", f"{sp} init --hub devhub --size 1 --setup-hook"),
        ("# A launchd agent now keeps the pool full in the background. Wait for it...", None),
        ("scratchpool status", f"until {sp} status --json | grep -q '\"ready\": *1'; do sleep 5; done; {sp} status"),
        ("# Need an org? Claim one: already created, already deployed", None),
        ("time scratchpool claim DEMO-1 --no-open", f"time {sp} claim DEMO-1 --no-open"),
        ("sf data query -o DEMO-1 -q \"SELECT Name FROM ApexClass WHERE Name LIKE 'SpDemo%'\"",
         "sf data query -o DEMO-1 -q \"SELECT Name FROM ApexClass WHERE Name LIKE 'SpDemo%'\""),
        ("# Done with it? Release frees the Dev Hub slot (asks first; --yes for scripts)", None),
        ("scratchpool release DEMO-1 --yes", f"{sp} release DEMO-1 --yes"),
        ("# Releasing freed a Dev Hub slot, so the pool refilled itself:", None),
        ("scratchpool status", f"until {sp} status --json | grep -q '\"ready\": *1'; do sleep 5; done; {sp} status"),
        ("# Pause background refills (e.g. end of day). Claims still work:", None),
        ("scratchpool pause", f"{sp} pause"),
        ("# Same pool, from Claude Code via the skill:", None),
        ("claude -p \"Give me a scratch org for DEMO-2\"",
         "claude -p \"Give me a scratch org for DEMO-2. Do not open a browser.\""),
        ("# Clean up: remove the background agent and release idle pool orgs", None),
        ("scratchpool release DEMO-2 --yes && scratchpool uninstall --release-pool-orgs --yes",
         f"{sp} release DEMO-2 --yes && {sp} uninstall --release-pool-orgs --yes"),
    ]

    events, t = [], 0.0

    def emit(text, dt):
        nonlocal t
        t += dt
        events.append([round(t, 3), "o", text])

    env = dict(os.environ, COLUMNS=str(COLS), LINES=str(ROWS), TERM="xterm-256color")
    for shown, cmd in steps:
        emit(PROMPT, 0.4)
        for ch in shown:
            emit(ch, TYPE_DELAY)
        emit("\r\n", 0.25)
        if cmd is None:
            continue
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(proj)
            os.execvpe("/bin/zsh", ["/bin/zsh", "-c", cmd], env)
        last = time.time()
        while True:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    data = os.read(fd, 4096)
                except OSError:
                    break
                if not data:
                    break
                now = time.time()
                emit(data.decode("utf-8", "replace"), min(now - last, MAX_IDLE))
                last = now
            elif os.waitpid(pid, os.WNOHANG)[0]:
                break
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
    emit(PROMPT, 0.6)
    emit("", 2.0)
    events = redact_events(events, redact)

    with open(out, "w") as f:
        f.write(json.dumps({"version": 2, "width": COLS, "height": ROWS,
                            "title": "scratchpool demo (real Dev Hub, identifiers redacted)",
                            "env": {"TERM": "xterm-256color", "SHELL": "/bin/zsh"}}) + "\n")
        for e in events:
            f.write(json.dumps(e) + "\n")
    print(f"wrote {out}: {len(events)} events, {t:.1f}s")


if __name__ == "__main__":
    main()
