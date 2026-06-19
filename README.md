# Marla

**She catches your mail so it never leaves.**

A local SMTP trap with a live web inbox — for testing email in development. Point your app's SMTP at Marla and every message it sends lands in a clean, real-time inbox instead of a real recipient. Nothing is ever relayed onward.

A self-hosted, SMTP-only take on Mailtrap/MailHog/Mailpit: no accounts, no cloud, no sending — just catch and inspect.

## Features

- **Catches all outgoing SMTP** on port `1025` and never relays it. No auth required (accepted if offered); STARTTLS is not advertised.
- **Live web inbox** at `http://localhost:8025` — new mail appears instantly over WebSocket, with a small visual cue when one lands.
- **Read any message**: rendered HTML in a sandboxed iframe, plain text, full raw source, and headers.
- **Attachments**: thumbnails for images, file chips for the rest, all downloadable. Inline `cid:` images are rewritten to display correctly.
- **SMTP envelope**: see the real `MAIL FROM` / `RCPT TO` alongside the header From/To.
- **Light & dark themes**, responsive to mobile, keyboard-navigable, reduced-motion aware.
- **In-memory only** — a ring buffer capped at 500 messages. Restart clears everything by design.
- **Change the SMTP port live** from the UI (click the port pill) — rebinds with no restart.
- **Self-contained** — fonts are bundled; works fully offline.

## Quick start

```bash
npx marla-mail
```

Or install it as a command:

```bash
npm install -g marla-mail
marla
```

Or clone and run:

```bash
git clone https://github.com/robertocemeri/marla-mail.git
cd marla-mail
npm install
npm start
```

You'll see:

```
Marla SMTP trap listening on :1025
Marla inbox: http://localhost:8025
```

Open **http://localhost:8025** and leave it open.

## Send a test message

No app needed — the bundled script sends one HTML email with an attachment and an inline image:

```bash
npm run test:send   # or: node test-send.js
```

## Point your app at Marla

Use these SMTP settings in any app or framework:

| Setting | Value |
| --- | --- |
| Host | `localhost` (or `127.0.0.1`) |
| Port | `1025` |
| Auth | none |
| TLS / SSL / STARTTLS | off |

A few examples:

**Nodemailer**
```js
const transport = require('nodemailer').createTransport({
  host: 'localhost', port: 1025, secure: false,
});
```

**Laravel** (`.env`)
```
MAIL_MAILER=smtp
MAIL_HOST=127.0.0.1
MAIL_PORT=1025
MAIL_ENCRYPTION=null
```

**Django** (`settings.py`)
```python
EMAIL_HOST = 'localhost'
EMAIL_PORT = 1025
EMAIL_USE_TLS = False
```

## Options

Both ports are configurable via flags or environment variables.

```bash
marla --smtp-port 2525 --http-port 9000
# or
SMTP_PORT=2525 HTTP_PORT=9000 marla
```

| Flag | Env var | Default | What |
| --- | --- | --- | --- |
| `-s, --smtp-port` | `SMTP_PORT` | `1025` | Port to catch mail on |
| `-p, --http-port` | `HTTP_PORT` | `8025` | Web inbox port |
| `-h, --help` | | | Show help |
| `-v, --version` | | | Print version |

The SMTP port can also be changed at runtime from the inbox UI — click the `SMTP :1025` pill in the top bar. Your choice is remembered in `~/.marla.json`.

## API

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/messages` | List of message summaries |
| `GET` | `/api/messages/:id` | Full parsed message |
| `GET` | `/api/messages/:id/html` | Rendered HTML body (`cid:` rewritten) |
| `GET` | `/api/messages/:id/raw` | Raw source (`?download=1` for `.eml`) |
| `GET` | `/api/messages/:id/attachments/:index` | Attachment (`?download=1` to force download) |
| `DELETE` | `/api/messages/:id` | Delete one |
| `DELETE` | `/api/messages` | Clear all |
| `WS` | `/ws` | `{type: "new" \| "delete" \| "clear" \| "settings", ...}` |

## How it works

`smtp-server` accepts the connection and buffers the message; `mailparser` parses it; it's kept in an in-memory ring buffer (raw source + parsed form). `express` serves the API and static UI, and `ws` pushes new mail to the inbox live. It never opens an outbound connection — caught mail goes nowhere else.

## Notes

- **Nothing is persisted.** A restart starts with an empty inbox. This is intentional — it's a scratch space for development.
- **Not for production.** It accepts mail without authentication and is meant to run on your own machine.

## License

[MIT](LICENSE). Bundled Geist / Geist Mono fonts are under the [SIL Open Font License 1.1](public/fonts/OFL.txt).
