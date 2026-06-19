'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const { WebSocketServer } = require('ws');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

const store = require('./store');

// Persisted UI preferences (just the SMTP port for now). Survives restarts so
// a port you pick in the inbox sticks. An explicit env var always wins.
// Stored in the user's home dir so it works even when installed globally,
// where the package directory is read-only.
const CONFIG_PATH = path.join(os.homedir(), '.marla.json');
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
  } catch (err) {
    console.error('[config] could not save:', err.message);
  }
}

const config = loadConfig();
// env var > saved preference > default
let smtpPort = parseInt(process.env.SMTP_PORT, 10) || config.smtpPort || 1025;
const HTTP_PORT = parseInt(process.env.HTTP_PORT, 10) || 8025;

// SMTP connection security: how the trap accepts connections.
//   plaintext — no TLS (clients use secure:false)            [default]
//   starttls  — plaintext, but advertises STARTTLS upgrade   (self-signed cert)
//   tls       — implicit TLS on connect (clients use secure:true, self-signed)
const SECURITY_MODES = ['plaintext', 'starttls', 'tls'];
function normalizeSecurity(v) {
  return SECURITY_MODES.includes(v) ? v : 'plaintext';
}
let smtpSecurity = normalizeSecurity(process.env.SMTP_SECURITY || config.smtpSecurity);

// ---------------------------------------------------------------------------
// Message shaping
// ---------------------------------------------------------------------------

function addressText(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  return addr.text || '';
}

function firstAddress(addr) {
  if (!addr || !addr.value || !addr.value.length) return '';
  return addr.value[0].address || '';
}

// Display name for the first address, falling back to the local-part of the
// email when no name was given (so the UI always has something to show).
function firstName(addr) {
  if (!addr || !addr.value || !addr.value.length) return '';
  const first = addr.value[0];
  if (first.name) return first.name;
  const email = first.address || '';
  return email ? email.split('@')[0] : '';
}

function snippet(parsed) {
  const src = parsed.text || (parsed.html ? parsed.html.replace(/<[^>]+>/g, ' ') : '');
  return src.replace(/\s+/g, ' ').trim().slice(0, 140);
}

// Short, list-friendly view of a message.
function toSummary(m) {
  const p = m.parsed;
  return {
    id: m.id,
    receivedAt: m.receivedAt,
    date: p.date ? p.date.toISOString() : null,
    read: m.read,
    from: addressText(p.from) || m.envelope.mailFrom || '(no sender)',
    fromName: firstName(p.from) || m.envelope.mailFrom || '(no sender)',
    fromAddress: firstAddress(p.from) || m.envelope.mailFrom || '',
    to: addressText(p.to),
    subject: p.subject || '(no subject)',
    snippet: snippet(p),
    attachmentCount: m.parsed.attachments ? m.parsed.attachments.length : 0,
    hasHtml: !!p.html,
  };
}

// Full reading-pane view. Attachment payloads are stripped — they are served
// lazily through the attachment endpoint.
function toFull(m) {
  const p = m.parsed;
  return {
    id: m.id,
    receivedAt: m.receivedAt,
    date: p.date ? p.date.toISOString() : null,
    read: m.read,
    subject: p.subject || '(no subject)',
    from: addressText(p.from),
    fromName: firstName(p.from) || m.envelope.mailFrom || '(no sender)',
    fromEmail: firstAddress(p.from) || m.envelope.mailFrom || '',
    to: addressText(p.to),
    cc: addressText(p.cc),
    bcc: addressText(p.bcc),
    replyTo: addressText(p.replyTo),
    messageId: p.messageId || '',
    text: p.text || '',
    hasHtml: !!p.html,
    envelope: m.envelope,
    headers: (p.headerLines || []).map((h) => ({ key: h.key, line: h.line })),
    attachments: (p.attachments || []).map((a, index) => ({
      index,
      filename: a.filename || `attachment-${index}`,
      contentType: a.contentType || 'application/octet-stream',
      size: a.size || (a.content ? a.content.length : 0),
      cid: a.cid || null,
      inline: a.contentDisposition === 'inline' || a.related === true,
      isImage: (a.contentType || '').toLowerCase().startsWith('image/'),
    })),
  };
}

// Point inline images at the attachment endpoint instead of embedding them.
// mailparser inlines related images as `data:` URIs in parsed.html; we swap
// those (and any literal `cid:` refs that survive) back to the endpoint so the
// HTML stays lean and images stream from one place.
function rewriteCids(html, attachments, msgId) {
  if (!html) return html;
  let out = html;
  const url = (idx) => `/api/messages/${encodeURIComponent(msgId)}/attachments/${idx}`;

  (attachments || []).forEach((a, idx) => {
    if (!a.cid || !a.content) return;
    const dataUri = `data:${a.contentType || 'application/octet-stream'};base64,${a.content.toString('base64')}`;
    if (out.includes(dataUri)) out = out.split(dataUri).join(url(idx));
  });

  return out.replace(/cid:([^"'>)\s]+)/gi, (match, rawCid) => {
    const cid = decodeURIComponent(rawCid).trim().replace(/^<|>$/g, '');
    const idx = (attachments || []).findIndex(
      (a) => a.cid && a.cid.toLowerCase() === cid.toLowerCase()
    );
    return idx === -1 ? match : url(idx);
  });
}

function renderHtmlDocument(m) {
  const p = m.parsed;
  const body = p.html
    ? rewriteCids(p.html, p.attachments, m.id)
    : (p.textAsHtml || '');
  // A neutral light canvas so emails that assume a white background stay legible.
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  html, body { background: #ffffff; color: #111111; margin: 0; padding: 14px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  img { max-width: 100%; height: auto; }
</style>
</head>
<body>${body || '<p style="color:#888">(no HTML body)</p>'}</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTTP API + static UI
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/messages', (req, res) => {
  res.json(store.all().map(toSummary));
});

app.get('/api/messages/:id', (req, res) => {
  const m = store.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (!m.read) {
    m.read = true; // opening marks read
  }
  res.json(toFull(m));
});

app.get('/api/messages/:id/html', (req, res) => {
  const m = store.get(req.params.id);
  if (!m) return res.status(404).send('not found');
  res.type('html').send(renderHtmlDocument(m));
});

app.get('/api/messages/:id/raw', (req, res) => {
  const m = store.get(req.params.id);
  if (!m) return res.status(404).send('not found');
  if (req.query.download) {
    res.type('message/rfc822');
    res.setHeader('Content-Disposition', `attachment; filename="${m.id}.eml"`);
  } else {
    res.type('text/plain');
  }
  res.send(m.raw.toString('utf8'));
});

app.get('/api/messages/:id/attachments/:index', (req, res) => {
  const m = store.get(req.params.id);
  if (!m) return res.status(404).send('not found');
  const att = (m.parsed.attachments || [])[parseInt(req.params.index, 10)];
  if (!att) return res.status(404).send('not found');

  res.type(att.contentType || 'application/octet-stream');
  const filename = (att.filename || `attachment-${req.params.index}`).replace(/"/g, '');
  const disposition = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
  res.send(att.content);
});

app.delete('/api/messages/:id', (req, res) => {
  const ok = store.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'delete', id: req.params.id });
  res.json({ ok: true });
});

app.delete('/api/messages', (req, res) => {
  const n = store.clear();
  broadcast({ type: 'clear' });
  res.json({ ok: true, cleared: n });
});

// ---------------------------------------------------------------------------
// WebSocket live feed
// ---------------------------------------------------------------------------

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

// ---------------------------------------------------------------------------
// SMTP trap — catches everything, relays nothing.
// ---------------------------------------------------------------------------

// A self-signed localhost cert, generated once on first TLS use. Clients connect
// with rejectUnauthorized:false; this is a local dev trap, not a public server.
let tlsPems = null;
function getCert() {
  if (!tlsPems) {
    const selfsigned = require('selfsigned');
    const pems = selfsigned.generate(
      [{ name: 'commonName', value: 'localhost' }],
      { days: 3650, keySize: 2048 }
    );
    tlsPems = { key: pems.private, cert: pems.cert };
  }
  return tlsPems;
}

// Handlers are identical across modes; only the transport security differs.
function onAuth(auth, session, callback) {
  callback(null, { user: auth.username || 'anonymous' });
}
function onData(stream, session, callback) {
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  stream.on('end', async () => {
    const raw = Buffer.concat(chunks);
    try {
      const parsed = await simpleParser(raw);
      const envelope = {
        mailFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : null,
        rcptTo: (session.envelope.rcptTo || []).map((r) => r.address),
      };
      const message = store.add({
        receivedAt: new Date().toISOString(),
        read: false,
        raw,
        parsed,
        envelope,
      });
      broadcast({ type: 'new', message: toSummary(message) });
      console.log(
        `[caught] ${message.envelope.mailFrom || '?'} -> ${message.envelope.rcptTo.join(', ') || '?'}` +
          `  "${parsed.subject || '(no subject)'}"`
      );
    } catch (err) {
      console.error('[parse error]', err.message);
    }
    callback(); // ack to the client; the mail goes nowhere else
  });
  stream.on('error', (err) => {
    console.error('[stream error]', err.message);
    callback(err);
  });
}

function buildSmtpOptions(mode) {
  const opts = {
    banner: 'Marla — she catches your mail so it never leaves',
    authOptional: true, // accept AUTH if offered, never require it
    onAuth,
    onData,
  };
  if (mode === 'tls') {
    // Implicit TLS: the whole connection is encrypted from the first byte.
    Object.assign(opts, { secure: true }, getCert());
  } else if (mode === 'starttls') {
    // Plaintext connect that may upgrade via STARTTLS (advertised because a cert exists).
    Object.assign(opts, getCert());
  } else {
    // Plaintext only: no cert, so don't advertise an upgrade path.
    opts.disabledCommands = ['STARTTLS'];
  }
  return opts;
}

let smtp = new SMTPServer(buildSmtpOptions(smtpSecurity));

// Bind `server` to `port`, resolving once it is listening and rejecting on a
// bind failure (e.g. EADDRINUSE / EACCES) instead of crashing the process.
function listenSmtp(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, () => {
      server.removeListener('error', onError);
      server.on('error', (err) => console.error('[smtp error]', err.message));
      smtpPort = port;
      console.log(`Marla SMTP trap listening on :${port} (${smtpSecurity})`);
      resolve();
    });
  });
}

// Move the trap to a new port and/or security mode.
//  - Different port: bind the new listener BEFORE dropping the old (zero downtime).
//  - Same port (e.g. a security-mode switch): the port must be freed first, so
//    close the old listener, then bind the new one — restoring the old on failure.
async function rebindSmtp(port, mode) {
  const old = smtp;
  const prevPort = smtpPort;
  const prevMode = smtpSecurity;

  if (port !== prevPort) {
    const next = new SMTPServer(buildSmtpOptions(mode));
    await listenSmtp(next, port); // throws on failure; old stays live
    smtp = next;
    smtpSecurity = mode;
    old.close(() => {}); // release the previous port in the background
    return;
  }

  // Same port — brief gap while we swap the listener.
  await new Promise((resolve) => old.close(resolve));
  const next = new SMTPServer(buildSmtpOptions(mode));
  try {
    await listenSmtp(next, port);
    smtp = next;
    smtpSecurity = mode;
  } catch (err) {
    // Couldn't bind the new mode — bring the previous one back up.
    const restored = new SMTPServer(buildSmtpOptions(prevMode));
    smtp = restored;
    await listenSmtp(restored, prevPort).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Settings — live SMTP port, surfaced in the UI.
// ---------------------------------------------------------------------------

function currentSettings() {
  return { smtpPort, smtpSecurity, httpPort: HTTP_PORT };
}

app.get('/api/settings', (req, res) => {
  res.json(currentSettings());
});

app.post('/api/settings', async (req, res) => {
  const body = req.body || {};
  const port = body.smtpPort != null ? parseInt(body.smtpPort, 10) : smtpPort;
  const mode = body.smtpSecurity != null ? body.smtpSecurity : smtpSecurity;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'Port must be a number between 1 and 65535.', ...currentSettings() });
  }
  if (!SECURITY_MODES.includes(mode)) {
    return res.status(400).json({ error: 'Unknown security mode.', ...currentSettings() });
  }
  if (port === smtpPort && mode === smtpSecurity) {
    return res.json(currentSettings());
  }

  try {
    await rebindSmtp(port, mode);
    saveConfig({ smtpPort: port, smtpSecurity: mode });
    broadcast({ type: 'settings', ...currentSettings() });
    res.json(currentSettings());
  } catch (err) {
    const reason =
      err.code === 'EADDRINUSE' ? `Port ${port} is already in use.`
      : err.code === 'EACCES' ? `Port ${port} needs elevated privileges (try 1024 or above).`
      : `Could not apply settings: ${err.message}`;
    // The trap is still on its previous port/mode — report that back.
    res.status(409).json({ error: reason, ...currentSettings() });
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

listenSmtp(smtp, smtpPort).catch((err) => {
  console.error(`[smtp] could not bind :${smtpPort} — ${err.message}`);
});

// A taken web-UI port is fatal (unlike the SMTP port, it can't be rebound at
// runtime). Fail with a clear message instead of an unhandled-error stack.
let bootFailed = false;
function handleBootError(err) {
  if (bootFailed) return;
  bootFailed = true;
  if (err.code === 'EADDRINUSE') {
    console.error(`\nMarla can't start — web UI port ${HTTP_PORT} is already in use.`);
    console.error(`Another Marla is probably already running: http://localhost:${HTTP_PORT}`);
    console.error(`To run a second copy elsewhere:  HTTP_PORT=8026 npm start\n`);
  } else {
    console.error('[http error]', err.message);
  }
  process.exit(1);
}
httpServer.on('error', handleBootError);
wss.on('error', handleBootError); // ws re-emits the http server's bind error

httpServer.listen(HTTP_PORT, () => {
  console.log(`Marla inbox: http://localhost:${HTTP_PORT}`);
});
