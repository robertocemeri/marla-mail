'use strict';

// Background-service support for Marla: run it detached (survives closing the
// terminal) and register it to auto-start on login. Zero extra dependencies —
// Node's child_process is enough. The OS auto-start glue (launchd / systemd
// user unit / Windows Startup) all follows the same "run once at login" shape.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');

// All runtime state lives in ~/.marla/ (sibling of the ~/.marla.json settings).
const STATE_DIR = path.join(os.homedir(), '.marla');
const PID_FILE = path.join(STATE_DIR, 'marla.pid');
const LOG_FILE = path.join(STATE_DIR, 'marla.log');

const LAUNCHD_LABEL = 'com.marla.mail';

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// PID file — single source of truth for "is Marla running, and where". Written
// by server.js on boot (see writePidFile/clearPidFile, used from server.js too)
// so status/stop work no matter how Marla was started.
// ---------------------------------------------------------------------------

function writePidFile(info) {
  ensureStateDir();
  const data = { pid: process.pid, startedAt: new Date().toISOString(), ...info };
  fs.writeFileSync(PID_FILE, JSON.stringify(data, null, 2) + '\n');
}

function clearPidFile() {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* already gone */
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// Is this PID a live process? signal 0 tests existence without delivering a
// signal. EPERM means it exists but we can't signal it — still alive.
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// State for a verified-live instance, or null. Clears a stale PID file.
function runningState() {
  const s = readState();
  if (!s) return null;
  if (isAlive(s.pid)) return s;
  clearPidFile();
  return null;
}

function inboxUrl(state) {
  const port = (state && state.httpPort) || 8025;
  return `http://localhost:${port}`;
}

// ---------------------------------------------------------------------------
// Detached lifecycle: start / stop / restart / status / logs
// ---------------------------------------------------------------------------

// Map CLI options to the env vars server.js reads.
function envFor(opts = {}) {
  const env = { ...process.env };
  if (opts.smtpPort) env.SMTP_PORT = String(opts.smtpPort);
  if (opts.httpPort) env.HTTP_PORT = String(opts.httpPort);
  if (opts.smtpSecurity) env.SMTP_SECURITY = String(opts.smtpSecurity);
  return env;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spawn server.js detached, logging to ~/.marla/marla.log. Resolves once the
// PID file confirms it bound, or reports the failure from the log if it died.
async function start(opts = {}) {
  ensureStateDir();
  const cur = runningState();
  if (cur) {
    console.log(`Marla is already running (pid ${cur.pid}). Inbox: ${inboxUrl(cur)}`);
    return true;
  }

  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [SERVER_PATH], {
    detached: true,
    stdio: ['ignore', out, out],
    env: envFor(opts),
  });

  let exitedEarly = false;
  child.on('exit', (code) => {
    exitedEarly = true;
    if (code) console.error(`Marla exited immediately (code ${code}). See: marla logs`);
  });
  child.unref();

  // Poll for the PID file the child writes once it's listening.
  for (let i = 0; i < 30 && !exitedEarly; i++) {
    const s = readState();
    if (s && s.pid === child.pid && isAlive(s.pid)) {
      console.log(`Marla started (pid ${s.pid}). Inbox: ${inboxUrl(s)}`);
      console.log('It will keep running after you close this terminal. Stop it with: marla stop');
      return true;
    }
    await sleep(150);
  }

  if (exitedEarly) {
    console.error('Marla failed to start. Recent log:');
    printLog({ lines: 15 });
    return false;
  }
  // Bound but slow to write the PID file; assume it's coming up.
  console.log(`Marla is starting (pid ${child.pid}). Inbox: ${inboxUrl(opts)}`);
  return true;
}

async function stop() {
  const s = readState();
  if (!s) {
    console.log('Marla is not running.');
    return true;
  }
  if (!isAlive(s.pid)) {
    clearPidFile();
    console.log('Marla is not running (cleared stale state).');
    return true;
  }

  try {
    process.kill(s.pid, 'SIGTERM');
  } catch {
    /* raced with exit */
  }

  for (let i = 0; i < 33; i++) {
    if (!isAlive(s.pid)) break;
    await sleep(150);
  }
  if (isAlive(s.pid)) {
    try {
      process.kill(s.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  clearPidFile();
  console.log(`Marla stopped (pid ${s.pid}).`);
  return true;
}

async function restart(opts = {}) {
  await stop();
  return start(opts);
}

function status() {
  const s = runningState();
  if (s) {
    const started = s.startedAt ? new Date(s.startedAt).toLocaleString() : 'unknown';
    console.log('● Marla is running');
    console.log(`  pid:      ${s.pid}`);
    console.log(`  SMTP:     :${s.smtpPort || '?'} (${s.smtpSecurity || 'plaintext'})`);
    console.log(`  inbox:    ${inboxUrl(s)}`);
    console.log(`  started:  ${started}`);
  } else {
    console.log('○ Marla is not running.');
  }

  const auto = autostartStatus();
  if (auto.supported) {
    console.log(`  autostart: ${auto.installed ? 'enabled' : 'disabled'} (${auto.mechanism})`);
  } else {
    console.log(`  autostart: not supported on this platform`);
  }
  return s ? 0 : 1;
}

function printLog({ lines } = {}) {
  let content;
  try {
    content = fs.readFileSync(LOG_FILE, 'utf8');
  } catch {
    console.log('No log yet — Marla has not run in the background.');
    return;
  }
  if (lines) {
    const all = content.split('\n');
    content = all.slice(Math.max(0, all.length - lines - 1)).join('\n');
  }
  process.stdout.write(content.endsWith('\n') ? content : content + '\n');
}

function logs(opts = {}) {
  if (!opts.follow) {
    printLog();
    return;
  }
  if (process.platform === 'win32') {
    console.log('(--follow is not supported on Windows; showing current log)');
    printLog();
    return;
  }
  try {
    spawn('tail', ['-n', '40', '-f', LOG_FILE], { stdio: 'inherit' });
  } catch {
    printLog();
  }
}

// ---------------------------------------------------------------------------
// Auto-start on login (install / uninstall)
// ---------------------------------------------------------------------------

// Warn when running from an ephemeral npx cache — that path can be cleared,
// which would silently break auto-start after a reboot.
function isEphemeralInstall() {
  const p = SERVER_PATH;
  return p.includes(`${path.sep}_npx${path.sep}`) || p.startsWith(os.tmpdir() + path.sep);
}

// On macOS, Desktop/Documents/Downloads are privacy-protected (TCC). A
// LaunchAgent can't read files there, so the service would hang on startup.
// Returns the offending directory name, or null if the path is fine.
function macProtectedDir() {
  if (process.platform !== 'darwin') return null;
  const home = os.homedir();
  for (const dir of ['Desktop', 'Documents', 'Downloads']) {
    if (SERVER_PATH.startsWith(path.join(home, dir) + path.sep)) return dir;
  }
  return null;
}

function autostartStatus() {
  switch (process.platform) {
    case 'darwin':
      return { supported: true, mechanism: 'launchd', installed: fs.existsSync(launchdPlistPath()) };
    case 'linux':
      return { supported: true, mechanism: 'systemd (user)', installed: fs.existsSync(systemdUnitPath()) };
    case 'win32':
      return { supported: true, mechanism: 'Startup folder', installed: fs.existsSync(windowsStartupVbsPath()) };
    default:
      return { supported: false };
  }
}

async function install(opts = {}) {
  if (!autostartStatus().supported) {
    console.error(`Auto-start is not supported on platform "${process.platform}".`);
    console.error('You can still run Marla in the background with: marla start');
    return false;
  }
  if (isEphemeralInstall()) {
    console.error('Marla looks like it is running from a temporary npx cache.');
    console.error('Install it first so auto-start survives a reboot:  npm i -g marla-mail');
    return false;
  }
  const protectedDir = macProtectedDir();
  if (protectedDir) {
    console.error(`Marla is running from your ~/${protectedDir} folder, which macOS keeps private.`);
    console.error('A login agent cannot read it, so auto-start would hang on startup.');
    console.error('Install it globally instead:  npm i -g marla-mail   (then run: marla install)');
    return false;
  }

  // Start clean: stop any running instance, then let the OS bring it up.
  await stop();
  ensureStateDir();

  try {
    if (process.platform === 'darwin') installLaunchd(opts);
    else if (process.platform === 'linux') installSystemd(opts);
    else installWindows(opts);
  } catch (err) {
    console.error(`Could not enable auto-start: ${err.message}`);
    return false;
  }

  // Windows Startup only fires at login, so kick off a run now.
  if (process.platform === 'win32') await start(opts);

  console.log('Auto-start enabled — Marla will run on login and is starting now.');
  console.log(`Inbox: ${inboxUrl(opts)}`);
  console.log('Disable it with: marla uninstall');
  return true;
}

async function uninstall() {
  const auto = autostartStatus();
  if (!auto.supported) {
    console.error(`Auto-start is not supported on platform "${process.platform}".`);
    return false;
  }
  if (!auto.installed) {
    console.log('Auto-start is not enabled.');
    // Still stop a running instance for a clean teardown.
    await stop();
    return true;
  }

  try {
    if (process.platform === 'darwin') uninstallLaunchd();
    else if (process.platform === 'linux') uninstallSystemd();
    else uninstallWindows();
  } catch (err) {
    console.error(`Could not fully disable auto-start: ${err.message}`);
  }

  // launchctl/systemctl stop the process for us; Windows needs an explicit stop.
  if (process.platform === 'win32') await stop();
  clearPidFile();
  console.log('Auto-start disabled and Marla stopped.');
  return true;
}

// --- macOS: LaunchAgent -----------------------------------------------------

function launchdPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function plistEnvDict(opts) {
  const entries = [];
  if (opts.smtpPort) entries.push(['SMTP_PORT', String(opts.smtpPort)]);
  if (opts.httpPort) entries.push(['HTTP_PORT', String(opts.httpPort)]);
  if (opts.smtpSecurity) entries.push(['SMTP_SECURITY', String(opts.smtpSecurity)]);
  if (!entries.length) return '';
  const body = entries.map(([k, v]) => `    <key>${k}</key>\n    <string>${v}</string>`).join('\n');
  return `  <key>EnvironmentVariables</key>\n  <dict>\n${body}\n  </dict>\n`;
}

function installLaunchd(opts) {
  const plistPath = launchdPlistPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${SERVER_PATH}</string>
  </array>
${plistEnvDict(opts)}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist);
  try {
    execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
  } catch {
    /* wasn't loaded */
  }
  execFileSync('launchctl', ['load', '-w', plistPath], { stdio: 'ignore' });
}

function uninstallLaunchd() {
  const plistPath = launchdPlistPath();
  try {
    execFileSync('launchctl', ['unload', '-w', plistPath], { stdio: 'ignore' });
  } catch {
    /* not loaded */
  }
  try {
    fs.unlinkSync(plistPath);
  } catch {
    /* gone */
  }
}

// --- Linux: systemd user unit ----------------------------------------------

function systemdUnitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'marla.service');
}

function requireSystemctl() {
  try {
    execFileSync('systemctl', ['--user', '--version'], { stdio: 'ignore' });
  } catch {
    throw new Error('systemctl --user is unavailable; cannot register a systemd user service on this system');
  }
}

function installSystemd(opts) {
  requireSystemctl();
  const unitPath = systemdUnitPath();
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  const envLines = [];
  if (opts.smtpPort) envLines.push(`Environment=SMTP_PORT=${opts.smtpPort}`);
  if (opts.httpPort) envLines.push(`Environment=HTTP_PORT=${opts.httpPort}`);
  if (opts.smtpSecurity) envLines.push(`Environment=SMTP_SECURITY=${opts.smtpSecurity}`);
  const unit = `[Unit]
Description=Marla — local SMTP trap with a live web inbox
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${SERVER_PATH}
Restart=no
${envLines.join('\n')}${envLines.length ? '\n' : ''}StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitPath, unit);
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  execFileSync('systemctl', ['--user', 'enable', '--now', 'marla.service'], { stdio: 'ignore' });
}

function uninstallSystemd() {
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', 'marla.service'], { stdio: 'ignore' });
  } catch {
    /* not enabled */
  }
  try {
    fs.unlinkSync(systemdUnitPath());
  } catch {
    /* gone */
  }
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
}

// --- Windows: Startup-folder launcher --------------------------------------

function windowsStartupDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}
function windowsStartupVbsPath() {
  return path.join(windowsStartupDir(), 'marla.vbs');
}
function windowsCmdPath() {
  return path.join(STATE_DIR, 'marla-autostart.cmd');
}

function installWindows(opts) {
  ensureStateDir();
  const cmdPath = windowsCmdPath();
  const envLines = [];
  if (opts.smtpPort) envLines.push(`set "SMTP_PORT=${opts.smtpPort}"`);
  if (opts.httpPort) envLines.push(`set "HTTP_PORT=${opts.httpPort}"`);
  if (opts.smtpSecurity) envLines.push(`set "SMTP_SECURITY=${opts.smtpSecurity}"`);
  const cmd = `@echo off
${envLines.join('\r\n')}${envLines.length ? '\r\n' : ''}"${process.execPath}" "${SERVER_PATH}" >> "${LOG_FILE}" 2>&1
`;
  fs.writeFileSync(cmdPath, cmd);

  // A .vbs in the Startup folder launches the .cmd hidden (window style 0) so
  // there's no console flashing on login.
  const startupDir = windowsStartupDir();
  fs.mkdirSync(startupDir, { recursive: true });
  const vbs = `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${cmdPath}""", 0, False\r\n`;
  fs.writeFileSync(windowsStartupVbsPath(), vbs);
}

function uninstallWindows() {
  for (const p of [windowsStartupVbsPath(), windowsCmdPath()]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* gone */
    }
  }
}

module.exports = {
  // used by server.js
  writePidFile,
  clearPidFile,
  PID_FILE,
  STATE_DIR,
  LOG_FILE,
  // CLI commands
  start,
  stop,
  restart,
  status,
  logs,
  install,
  uninstall,
};
