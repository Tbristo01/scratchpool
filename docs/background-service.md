# The background service

scratchpool keeps your pool warm by having **your own operating system's scheduler** run
`scratchpool tick` every N minutes (default 15). That is the whole "service":

- **Nothing is hosted.** There is no scratchpool server, database, queue or cloud function. The
  scheduler entry lives on your laptop or workstation, runs as you, and uses your own `sf` CLI
  and your own Dev Hub login. The only remote endpoint ever contacted is Salesforce, through `sf`.
- **One entry per user**, serving every pool you have configured with `scratchpool init`.
- `scratchpool init` installs it (unless `--no-service`). You can manage it yourself with:

```sh
scratchpool service install [--interval <minutes>]   # idempotent; re-run to change the interval
scratchpool service status
scratchpool service uninstall
scratchpool config set intervalMinutes 30           # also reinstalls the service
scratchpool pause                                   # keeps the scheduler, but ticks do nothing for this pool
```

The scheduler runs with a minimal environment, so the entry records **absolute** paths to `node`,
the scratchpool script and `sf` (captured at `init`), and sets `PATH` to their directories plus
`/usr/bin:/bin`. If you move or upgrade Node (for example with nvm) or reinstall `sf` somewhere
else, re-run `scratchpool init` or `scratchpool service install`.

`<home>` below is the scratchpool home: `$SCRATCHPOOL_HOME`, else `$XDG_CONFIG_HOME/scratchpool`,
else `~/.config/scratchpool` (on Windows `%APPDATA%\scratchpool`). Every tick appends what it did to
`<home>/logs/scratchpool.log` on every OS (rotated at 1 MB).

## macOS: launchd LaunchAgent

**Installed:** `~/Library/LaunchAgents/dev.scratchpool.tick.plist`, loaded into your GUI session
(`gui/<uid>`). It runs `node <script> tick --json` with `StartInterval` = interval x 60 seconds and
`RunAtLoad` (so it also ticks right after login or install).

**Logs:** the tick's own log is `<home>/logs/scratchpool.log`; the job's stdout/stderr go to
`<home>/logs/launchd.log`.

**Inspect / stop manually:**

```sh
launchctl print gui/$(id -u)/dev.scratchpool.tick      # state, last exit code, run interval
launchctl kickstart gui/$(id -u)/dev.scratchpool.tick  # run a tick now
launchctl bootout gui/$(id -u)/dev.scratchpool.tick    # stop until next install/login
rm ~/Library/LaunchAgents/dev.scratchpool.tick.plist   # remove permanently (or: scratchpool service uninstall)
```

macOS may show a "Background item added" notification the first time; it names `node`.
You can see and toggle it in System Settings > General > Login Items.

## Linux: systemd user timer

**Installed:** `~/.config/systemd/user/scratchpool-tick.service` (`Type=oneshot`,
`KillMode=process`, absolute `ExecStart`, `Environment=PATH=…`) and `~/.config/systemd/user/scratchpool-tick.timer`
(`OnBootSec=2min`, `OnUnitActiveSec=<n>min`, `Persistent=true`). Then
`systemctl --user daemon-reload` and `systemctl --user enable --now scratchpool-tick.timer`.
(`$XDG_CONFIG_HOME` is honoured instead of `~/.config` if set.) `KillMode=process` matters: a tick
starts each background create as a detached process and exits, and with systemd's default
(`control-group`) those creates would be killed with it.

**Logs:** `<home>/logs/scratchpool.log`, plus the journal:
`journalctl --user -u scratchpool-tick.service`.

**Inspect / stop manually:**

```sh
systemctl --user status scratchpool-tick.timer      # next/last trigger
systemctl --user list-timers scratchpool-tick.timer
systemctl --user start scratchpool-tick.service     # run a tick now
systemctl --user disable --now scratchpool-tick.timer
```

User timers only run while you have a session. If you want ticks while logged out (for example on
a workstation you SSH into), run `loginctl enable-linger $USER` once.

**No systemd user session** (some containers, WSL1, minimal distros): `service install` fails with
`SERVICE_UNSUPPORTED` and prints a ready-to-paste crontab line instead, for example:

```
*/15 * * * * PATH='/home/me/.nvm/versions/node/v22.0.0/bin:/usr/local/bin:/usr/bin:/bin' SCRATCHPOOL_HOME='/home/me/.config/scratchpool' '/home/me/.nvm/versions/node/v22.0.0/bin/node' '/path/to/scratchpool.mjs' tick --json >> '/home/me/.config/scratchpool/logs/cron.log' 2>&1
```

Add it with `crontab -e`; remove it the same way. Its output goes to `<home>/logs/cron.log`.

## Windows: Task Scheduler

**Installed:** a small wrapper `<home>\scratchpool-tick.cmd` and a per-user scheduled task named
`scratchpool-tick` that runs it:

```
schtasks /Create /F /SC MINUTE /MO <n> /TN scratchpool-tick /TR "\"<home>\scratchpool-tick.cmd\""
```

Like the macOS plist and the systemd unit, the wrapper pins `SCRATCHPOOL_HOME` and `PATH` (the
directories of `node.exe` and `sf`) and then runs `"<node.exe>" "<scratchpool.mjs>" tick --json`
with absolute, quoted paths, so locations such as `C:\Program Files\nodejs` and a custom
`SCRATCHPOOL_HOME` work. The task runs only while you are logged on. schtasks limits `/TR` to 261
characters; if your home path is longer, `service install` fails with `SERVICE_UNSUPPORTED`.

**Logs:** `<home>\logs\scratchpool.log`, and the wrapper's stdout/stderr in `<home>\logs\task.log`
(Task Scheduler itself keeps only the last run result).

**Inspect / stop manually:**

```bat
schtasks /Query /TN scratchpool-tick /V /FO LIST
schtasks /Run /TN scratchpool-tick
schtasks /Change /TN scratchpool-tick /DISABLE
schtasks /Delete /F /TN scratchpool-tick
```

Known v0.1 limitations of a task created by `schtasks /Create`: Windows defaults it to
**"Start only if the computer is on AC power"**, so on a laptop running on battery ticks are
skipped until you plug in, and a console window can flash briefly each run. To change the power
setting, open Task Scheduler, find `scratchpool-tick`, and clear the option under Conditions > Power.

## When the script moves

The scheduler entry points at the exact `node`, `scratchpool.mjs` and `sf` paths recorded at
install time. If one disappears (an `npx` cache purge, a plugin update to a new directory, an nvm
or Homebrew switch), scheduled ticks would fail silently. The next interactive `scratchpool claim`,
`status` or `tick` notices the missing path, re-installs the scheduler for the copy that is running,
and reports the warning `SERVICE_REPAIRED`. `scratchpool service install` does the same by hand.

## Laptop sleep, shutdown and offline

The pool is designed for machines that sleep:

- **While asleep or off nothing runs**, and nothing needs to. Scratch orgs keep existing in your
  Dev Hub; the next tick reconciles state, recycles orgs that expired or are close to it, and
  refills.
- **Missed intervals are not replayed one by one.** You get at most one catch-up tick, then the
  normal schedule continues:
  - macOS: launchd runs a `StartInterval` job that came due during sleep shortly after wake.
  - Linux: the timer counts awake time, so the next tick comes at most one interval after wake;
    `OnBootSec=2min` ticks two minutes after boot.
  - Windows: the task runs at its next scheduled minute after wake (within one interval).
- **Offline or `sf` not logged in:** the tick logs the error and exits; the next one tries again.
  `scratchpool claim` still hands out any `ready` org it already has.
- Ticks are safe to overlap (per-pool lock), so a catch-up tick and a manual `scratchpool tick`
  cannot double-create.

If you want an org right after opening the lid without waiting, run `scratchpool tick` (it is also
"fill now") or just `scratchpool claim`, which starts a refill tick in the background itself.

## Uninstalling

`scratchpool service uninstall` removes only the scheduler entry (bootout and delete the plist;
disable the timer and delete both units; or `schtasks /Delete`). `scratchpool uninstall` also does
this, and with `--release-pool-orgs` deletes the unclaimed pool orgs. Orgs you have claimed are
never deleted by uninstall.

## Testing without touching the real scheduler

Set `SCRATCHPOOL_SERVICE_DRYRUN=1`: the plist or unit files are written under
`<home>/service-dryrun/`, and the commands that would have run (`launchctl`, `systemctl`,
`schtasks`) are appended as argv arrays to `<home>/service-dryrun/commands.json`. Nothing is
executed. `SCRATCHPOOL_PLATFORM=darwin|linux|win32` picks the platform to simulate.
