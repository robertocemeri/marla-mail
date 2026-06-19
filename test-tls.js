'use strict';
// Verifies each SMTP security mode. Flips the mode via the API, then probes.
const net = require('net');
const tls = require('tls');

const HTTP = 8025;

function setMode(mode) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ smtpSecurity: mode });
    const req = require('http').request(
      { host: 'localhost', port: HTTP, path: '/api/settings', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }
    );
    req.on('error', rej); req.write(body); req.end();
  });
}

// Read the EHLO response over a plaintext socket; resolve the capability lines.
function ehloPlain(port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(port, '127.0.0.1');
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      if (/^220 /m.test(buf) && !buf.includes('EHLO-SENT')) { buf += 'EHLO-SENT'; sock.write('EHLO tester\r\n'); }
      if (/^250 [^\r]*\r\n/m.test(buf.split('EHLO-SENT')[1] || '')) { sock.end(); resolve(buf); }
    });
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); resolve(buf); }, 1500);
  });
}

// Open an implicit-TLS connection and capture the SMTP banner.
function tlsBanner(port) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {});
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => { buf += d; if (buf.includes('\n')) { sock.end(); resolve(buf.trim()); } });
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); reject(new Error('no TLS banner')); }, 1500);
  });
}

async function main() {
  let pass = true;

  // STARTTLS advertised?
  await setMode('starttls');
  const ehlo = await ehloPlain(1025);
  const starttls = /STARTTLS/.test(ehlo);
  console.log(`STARTTLS mode: EHLO advertises STARTTLS -> ${starttls ? 'PASS' : 'FAIL'}`);
  pass = pass && starttls;

  // Implicit TLS handshake + banner?
  await setMode('tls');
  try {
    const banner = await tlsBanner(1025);
    const ok = banner.startsWith('220') && /Marla/.test(banner);
    console.log(`TLS mode: implicit TLS banner -> ${ok ? 'PASS' : 'FAIL'} (${banner.split('\n')[0]})`);
    pass = pass && ok;
  } catch (e) { console.log('TLS mode: FAIL -', e.message); pass = false; }

  // Plaintext should NOT advertise STARTTLS.
  await setMode('plaintext');
  const ehlo2 = await ehloPlain(1025);
  const noTls = !/STARTTLS/.test(ehlo2);
  console.log(`Plaintext mode: STARTTLS hidden -> ${noTls ? 'PASS' : 'FAIL'}`);
  pass = pass && noTls;

  console.log(pass ? '\nALL PASS' : '\nSOME FAILED');
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
