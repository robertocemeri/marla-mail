#!/usr/bin/env node
'use strict';

// Thin CLI wrapper: parse flags, set the env vars server.js reads, then boot it.

const args = process.argv.slice(2);
const pkg = require('../package.json');

function flag(...names) { return args.some((a) => names.includes(a)); }
function value(...names) {
  const i = args.findIndex((a) => names.includes(a));
  return i >= 0 ? args[i + 1] : undefined;
}

if (flag('-h', '--help')) {
  console.log(`
  Marla — she catches your mail so it never leaves.
  A local SMTP trap with a live web inbox. Catches outgoing mail; never relays it.

  Usage:  marla [options]

  Options:
    -s, --smtp-port <port>   SMTP port to catch mail on   (default 1025)
    -p, --http-port <port>   Web inbox port                (default 8025)
    -v, --version            Print version
    -h, --help               Show this help

  Then point your app's SMTP at localhost:<smtp-port> (no auth, no TLS)
  and open the inbox at http://localhost:<http-port>.
`);
  process.exit(0);
}

if (flag('-v', '--version')) {
  console.log(pkg.version);
  process.exit(0);
}

const smtpPort = value('-s', '--smtp-port');
const httpPort = value('-p', '--http-port');
if (smtpPort) process.env.SMTP_PORT = smtpPort;
if (httpPort) process.env.HTTP_PORT = httpPort;

require('../server.js');
