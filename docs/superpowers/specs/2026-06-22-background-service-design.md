# Marla — Background Service & Auto-Start Design

**Date:** 2026-06-22
**Status:** Approved

## Problem

Users report it's painful to open a terminal and run `npx marla-mail` / `marla`
every time they want to catch mail. Marla's inbox is already a web app at
`localhost:8025`, so the unmet need is not "a GUI" — it's that **Marla isn't
just always there**. The fix is to let it run detached and come back on login,
without keeping a terminal open.

## Goals

1. **Detached lifecycle** — start Marla once and have it survive closing the
   terminal: `marla start` / `stop` / `restart` / `status` / `logs`.
2. **Auto-start on login** — `marla install` / `uninstall`, supporting macOS,
   Linux, and Windows.
3. **Backward compatible** — bare `marla` (no subcommand) behaves exactly as
   today: foreground, tied to the terminal, Ctrl-C to stop.

Non-goal: aggressive restart-on-crash supervision. `install` means
"run once at login," kept deliberately simple and predictable across OSes.

## Command surface (`bin/marla.js`)

```
marla                  # unchanged: foreground (Ctrl-C to stop)
marla start [opts]     # start detached; survives closing the terminal
marla stop             # stop the running instance
marla restart [opts]   # stop + start
marla status           # running? pid, ports, inbox URL, auto-start state
marla logs             # print the background log (--follow to tail)
marla install [opts]   # register auto-start on login (and start now)
marla uninstall        # remove auto-start
marla -h / -v          # unchanged
```

`start` / `restart` / `install` accept the same `-s/--smtp-port`,
`-p/--http-port`, and `SMTP_SECURITY` options as today. `install` bakes the
resolved values into the OS service definition so it comes back identically
after a reboot.

## State & process model

All runtime state lives in `~/.marla/` (sibling of the existing
`~/.marla.json` settings file):

- `~/.marla/marla.pid` — JSON: `{ pid, smtpPort, httpPort, smtpSecurity, startedAt }`.
  Written by `server.js` on successful HTTP listen; removed on graceful exit.
  This is the **single source of truth** for `status` / `stop`, regardless of
  whether Marla was started in the foreground, via `start`, or by the installed
  service.
- `~/.marla/marla.log` — combined stdout/stderr of detached / service runs.

**Liveness** is verified with `process.kill(pid, 0)` (true if alive, `ESRCH`
if dead, `EPERM` still counts as alive) — never trust the file alone. Stale PID
files (process gone) are detected and cleaned up.

**Mechanics** (zero new dependencies; Node `child_process` only):

- `start`: if a live instance is already listening, report and exit. Otherwise
  `spawn(process.execPath, [serverPath], { detached: true, stdio: [ignore, log, log] })`,
  then `unref()` and exit. Port/security flags passed via env.
- `stop`: read pid, `SIGTERM`, escalate to `SIGKILL` after a short grace,
  remove the PID file. Handle already-stopped / stale gracefully.
- `restart`: stop, then start.
- `status`: live/dead + pid + ports + inbox URL + whether auto-start is installed.
- `logs`: print `marla.log`; `--follow` tails it.

`server.js` gains `SIGTERM`/`SIGINT` handlers that remove the PID file and exit
cleanly (so foreground Ctrl-C also cleans up).

## Auto-start glue (per OS)

All three follow the same "run once at login" shape: launch
`process.execPath server.js` with the baked-in port/security env, logging to
`~/.marla/marla.log`.

- **macOS** — LaunchAgent plist at `~/Library/LaunchAgents/com.marla.mail.plist`
  with `ProgramArguments`, `EnvironmentVariables`, `RunAtLoad=true`,
  `KeepAlive=false`, `StandardOut/ErrorPath`. Loaded via `launchctl load -w` /
  unloaded via `launchctl unload -w`.
- **Linux** — systemd **user** unit at
  `~/.config/systemd/user/marla.service` (`Type=simple`, `Restart=no`,
  `WantedBy=default.target`). `systemctl --user enable --now marla` /
  `disable --now`. If `systemctl` is unavailable, fail with a clear message.
- **Windows** — a hidden launcher (`.vbs` using `WScript.Shell` with window
  style 0) dropped in the user's `Startup` folder so it launches at login
  without a console window. `uninstall` deletes it.

`install` first checks whether Marla is running from an ephemeral `npx` cache
path; if so it warns and recommends `npm i -g marla-mail` first, because the
temp path may be cleared and break auto-start.

## Code layout

- `lib/service.js` (new) — state paths, detached spawn, liveness, and the
  install/uninstall implementations. Exports the small PID helpers `server.js`
  needs.
- `bin/marla.js` — subcommand parsing + dispatch; bare invocation unchanged.
- `server.js` — write/clear PID file around boot/shutdown; update it on a live
  SMTP rebind so `status` stays accurate.
- `package.json` — add `lib/` to the published `files` list.

## Multi-instance note

The existing power-user path of running a second copy on a different
`HTTP_PORT` is not managed by these commands — there is a single PID file
representing the primary instance. This is called out in the README.

## Testing / verification

No test framework exists in the repo today, so verification is manual on this
machine (macOS): `start` → `status` → confirm inbox reachable → `stop`;
`install` → reboot-equivalent check (`launchctl` list) → `uninstall`. The
Linux/Windows code paths are written carefully but cannot be exercised here;
this is noted in the delivery.

## README

The README must be updated to document the new subcommands, the "always there"
workflow, and the multi-instance note.
