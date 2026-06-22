#!/usr/bin/env node
'use strict';

// CLI for Marla. Bare `marla` runs the trap in the foreground (unchanged).
// Subcommands run it as a background service or register it to auto-start.

const args = process.argv.slice(2);
const pkg = require('../package.json');

function flag(...names) { return args.some((a) => names.includes(a)); }
function value(...names) {
  const i = args.findIndex((a) => names.includes(a));
  return i >= 0 ? args[i + 1] : undefined;
}

// Port/security options, shared by foreground, `start`, and `install`.
function options() {
  return {
    smtpPort: value('-s', '--smtp-port'),
    httpPort: value('-p', '--http-port'),
    smtpSecurity: process.env.SMTP_SECURITY,
  };
}

const HELP = `
  Marla — she catches your mail so it never leaves.
  A local SMTP trap with a live web inbox. Catches outgoing mail; never relays it.

  Usage:  marla [command] [options]

  Commands:
    (none)         Run in the foreground (Ctrl-C to stop)
    start          Start in the background; survives closing the terminal
    stop           Stop the background instance
    restart        Restart the background instance
    status         Show whether Marla is running, on which ports
    logs           Print the background log  (--follow to tail it)
    install        Auto-start Marla on login (and start it now)
    uninstall      Remove auto-start and stop Marla

  Options:
    -s, --smtp-port <port>   SMTP port to catch mail on   (default 1025)
    -p, --http-port <port>   Web inbox port                (default 8025)
    -v, --version            Print version
    -h, --help               Show this help

  Then point your app's SMTP at localhost:<smtp-port> (no auth, no TLS)
  and open the inbox at http://localhost:<http-port>.
`;

const COMMANDS = ['start', 'stop', 'restart', 'status', 'logs', 'install', 'uninstall'];
const sub = args[0] && !args[0].startsWith('-') ? args[0] : null;

if (sub && !COMMANDS.includes(sub)) {
  console.error(`Unknown command: ${sub}\nRun \`marla --help\` for usage.`);
  process.exit(1);
}

if (!sub && flag('-h', '--help')) {
  console.log(HELP);
  process.exit(0);
}
if (!sub && flag('-v', '--version')) {
  console.log(pkg.version);
  process.exit(0);
}

if (sub) {
  const service = require('../lib/service');
  (async () => {
    let code = 0;
    switch (sub) {
      case 'start':     code = (await service.start(options())) ? 0 : 1; break;
      case 'stop':      await service.stop(); break;
      case 'restart':   code = (await service.restart(options())) ? 0 : 1; break;
      case 'status':    code = service.status(); break;
      case 'logs':      service.logs({ follow: flag('--follow', '-f') }); break;
      case 'install':   code = (await service.install(options())) ? 0 : 1; break;
      case 'uninstall': await service.uninstall(); break;
    }
    // `logs --follow` keeps a child running; otherwise exit with the status.
    if (!(sub === 'logs' && flag('--follow', '-f'))) process.exit(code);
  })();
} else {
  // Foreground: set the env vars server.js reads, then boot it.
  const opts = options();
  if (opts.smtpPort) process.env.SMTP_PORT = opts.smtpPort;
  if (opts.httpPort) process.env.HTTP_PORT = opts.httpPort;
  require('../server.js');
}
