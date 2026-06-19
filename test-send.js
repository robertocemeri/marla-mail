'use strict';

// Sends one richly-structured test message to Marla over raw SMTP:
//   multipart/mixed
//     multipart/related  -> text/html + inline PNG (cid:logo)
//     text/plain attachment (notes.txt)

const net = require('net');

const PORT = parseInt(process.env.SMTP_PORT, 10) || 1025;
const HOST = '127.0.0.1';

// 1x1 red PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ATTACH_B64 = Buffer.from('Marla caught this. It never left.\n').toString('base64');

const B = 'MARLA_MIX_b0undary';
const R = 'MARLA_REL_b0undary';

const html =
  '<div style="font-family:sans-serif">' +
  '<h1 style="color:#e2674a">Hello from the trap</h1>' +
  '<p>This message has an <b>HTML body</b>, an inline image below, and an attachment.</p>' +
  '<p><img src="cid:logo" width="48" height="48" alt="inline logo"> &larr; inline (cid) image</p>' +
  '</div>';

const mime = [
  'From: "Dev App" <app@example.test>',
  'To: "Inbox" <catch@marla.test>',
  'Subject: Marla smoke test — html + attachment + inline image',
  'MIME-Version: 1.0',
  `Content-Type: multipart/mixed; boundary="${B}"`,
  '',
  `--${B}`,
  `Content-Type: multipart/related; boundary="${R}"`,
  '',
  `--${R}`,
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: 7bit',
  '',
  html,
  '',
  `--${R}`,
  'Content-Type: image/png',
  'Content-Transfer-Encoding: base64',
  'Content-ID: <logo>',
  'Content-Disposition: inline; filename="logo.png"',
  '',
  PNG_B64,
  '',
  `--${R}--`,
  '',
  `--${B}`,
  'Content-Type: text/plain; charset=utf-8; name="notes.txt"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="notes.txt"',
  '',
  ATTACH_B64,
  '',
  `--${B}--`,
  '',
].join('\r\n');

const cmds = [
  'EHLO tester.local',
  'MAIL FROM:<app@example.test>',
  'RCPT TO:<catch@marla.test>',
  'DATA',
  mime + '\r\n.',
  'QUIT',
];

const sock = net.createConnection(PORT, HOST);
let step = -1; // -1 waits for the server greeting
sock.setEncoding('utf8');

sock.on('data', (line) => {
  process.stdout.write('S: ' + line);
  if (step + 1 < cmds.length) {
    step += 1;
    const cmd = cmds[step];
    process.stdout.write('C: ' + (cmd.length > 60 ? cmd.slice(0, 60) + '…' : cmd) + '\n');
    sock.write(cmd + '\r\n');
  }
});

sock.on('end', () => { console.log('\nSent. Check http://localhost:8025'); });
sock.on('error', (e) => { console.error('error:', e.message); process.exit(1); });
