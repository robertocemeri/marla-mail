'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let messages = [];        // summaries, newest-first
let selectedId = null;
let activeTab = 'preview';
let smtpPort = 1025;

const el = (id) => document.getElementById(id);
const root = el('root');
const listEl = el('list');
const filterEl = el('filter');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// "Name" <a@b.com> → { name, email }
function parseAddress(str) {
  if (!str) return { name: '', email: '' };
  const m = str.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  if (str.includes('@')) return { name: '', email: str.trim() };
  return { name: str.trim(), email: '' };
}

function initials(name, email) {
  const base = (name || email || '?').trim();
  const parts = base.split(/[\s@.]+/).filter(Boolean);
  const s = parts.length >= 2 ? parts[0][0] + parts[1][0] : base.slice(0, 2);
  return s.toUpperCase();
}

// Deterministic avatar/dot color from the sender, drawn from the design palette.
const PALETTE = [
  { bg: '#ece1ff', fg: '#8350e6', dot: '#9a6bff' },
  { bg: '#d6f5ea', fg: '#0fa07d', dot: '#1fc59a' },
  { bg: '#ffe1ee', fg: '#e3447f', dot: '#ff4f9a' },
  { bg: '#fdeacb', fg: '#d2841a', dot: '#ffae2e' },
  { bg: '#dcecff', fg: '#2c7ce0', dot: '#3f95ff' },
  { bg: '#ffe5dd', fg: '#ec5a34', dot: '#ff6a4d' },
];
function colorFor(key) {
  let h = 0;
  for (let i = 0; i < (key || '').length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  if ((now - d) / 86400000 < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtFullTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

function renderCounts() {
  el('countsTotal').textContent = messages.length;
  const unread = messages.filter((m) => !m.read).length;
  const u = el('countsUnread');
  if (unread) { u.hidden = false; u.textContent = `· ${unread} new`; }
  else u.hidden = true;
}

// ---------------------------------------------------------------------------
// List rendering
// ---------------------------------------------------------------------------

function renderList() {
  const q = filterEl.value.trim().toLowerCase();
  const shown = q
    ? messages.filter((m) =>
        [m.fromName, m.from, m.subject, m.to, m.snippet].join(' ').toLowerCase().includes(q))
    : messages;

  listEl.innerHTML = '';
  for (const m of shown) {
    const c = colorFor(m.fromAddress || m.fromName);
    const li = document.createElement('li');
    li.className = 'row' + (m.read ? ' read' : '') + (m.id === selectedId ? ' active' : '');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', m.id === selectedId ? 'true' : 'false');
    li.dataset.id = m.id;
    li.tabIndex = -1;
    li.innerHTML = `
      <span class="row-dotcol"><span class="row-dot" style="background:${c.dot};box-shadow:0 0 7px ${c.dot}88"></span></span>
      <span class="row-main">
        <span class="row-top">
          <span class="row-from">${esc(m.fromName || m.from)}</span>
          <span class="row-time">${esc(fmtTime(m.receivedAt))}</span>
        </span>
        <span class="row-subject">${esc(m.subject)}</span>
        <span class="row-bottom">
          <span class="row-snippet">${esc(m.snippet)}</span>
          ${m.attachmentCount ? `<span class="row-clip" title="${m.attachmentCount} attachment(s)">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            ${m.attachmentCount}</span>` : ''}
        </span>
      </span>`;
    li.addEventListener('click', () => select(m.id));
    listEl.appendChild(li);
  }
  renderCounts();
}

function markLand(id) {
  const row = listEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (row) {
    row.classList.add('land');
    row.addEventListener('animationend', () => row.classList.remove('land'), { once: true });
  }
}

// ---------------------------------------------------------------------------
// Reading pane
// ---------------------------------------------------------------------------

async function select(id) {
  selectedId = id;
  document.body.dataset.view = 'read';
  renderList();

  let full;
  try {
    const res = await fetch(`/api/messages/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error('not found');
    full = await res.json();
  } catch {
    return; // likely deleted; list reconciles
  }

  const summary = messages.find((m) => m.id === id);
  if (summary) summary.read = true;
  renderList();

  el('readEmpty').hidden = true;
  el('message').hidden = false;

  const name = full.fromName || parseAddress(full.from).name || parseAddress(full.from).email;
  const email = full.fromEmail || parseAddress(full.from).email;
  const c = colorFor(email || name);

  el('subject').textContent = full.subject;
  const av = el('avatar');
  av.textContent = initials(name, email);
  av.style.background = c.bg;
  av.style.color = c.fg;
  el('fromName').textContent = name;
  el('fromEmail').textContent = email ? `<${email}>` : '';
  el('toName').textContent = full.to ? `→ ${parseAddress(full.to).email || full.to}` : '';
  el('fullTime').textContent = fmtFullTime(full.date || full.receivedAt);

  const env = full.envelope || {};
  el('envFrom').textContent = env.mailFrom || '—';
  el('envTo').textContent = (env.rcptTo || []).join(', ') || '—';

  el('downloadEml').href = `/api/messages/${encodeURIComponent(id)}/raw?download=1`;

  renderAttachments(full);
  renderTabs(full);
  setTab(activeTab);
}

function renderAttachments(full) {
  const wrap = el('attachments');
  const atts = full.attachments || [];
  if (!atts.length) { wrap.hidden = true; wrap.innerHTML = ''; return; }
  wrap.hidden = false;
  wrap.innerHTML = atts.map((a) => {
    const url = `/api/messages/${encodeURIComponent(full.id)}/attachments/${a.index}`;
    const ext = (a.filename.split('.').pop() || 'file').slice(0, 4).toUpperCase();
    const visual = a.isImage
      ? `<span class="att-thumb" style="background-image:url('${url}')"></span>`
      : `<span class="att-chip">${esc(ext)}</span>`;
    const sub = `${a.inline ? 'inline' : ext} · ${fmtSize(a.size)}`;
    return `<a class="att" href="${url}?download=1" download="${esc(a.filename)}" title="Download ${esc(a.filename)}">
      ${visual}
      <span class="att-meta">
        <span class="att-name">${esc(a.filename)}</span>
        <span class="att-sub">${esc(sub)}</span>
      </span>
    </a>`;
  }).join('');
}

function renderTabs(full) {
  const tabs = [
    { key: 'preview', label: 'Preview' },
    { key: 'text', label: 'Text' },
    { key: 'raw', label: 'Raw' },
    { key: 'headers', label: 'Headers', count: (full.headers || []).length },
  ];
  const nav = el('tabs');
  nav.innerHTML = tabs.map((t) => `
    <button class="tab" role="tab" data-tab="${t.key}" aria-selected="${t.key === activeTab}">
      ${t.label}${t.count != null ? `<span class="tab-count">${t.count}</span>` : ''}
    </button>`).join('');
  for (const btn of nav.querySelectorAll('.tab')) {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  }

  el('previewFrame').src = `/api/messages/${encodeURIComponent(full.id)}/html`;

  // cid-rewrite note: only when there are inline images.
  const inline = (full.attachments || []).find((a) => a.inline && a.isImage);
  const note = el('previewNote');
  if (inline) {
    note.innerHTML = `<span class="dot"></span> sandboxed iframe · <span class="cid">cid:${esc(inline.cid || inline.filename)}</span> rewritten → <span class="url">/api/messages/${esc(full.id)}/attachments/${inline.index}</span>`;
    note.hidden = false;
  } else {
    note.innerHTML = `<span class="dot"></span> rendered in a sandboxed iframe`;
    note.hidden = false;
  }

  el('textBody').textContent = full.text || '(no plain-text body)';
  el('headersBody').innerHTML = (full.headers || [])
    .map((h) => `<div class="header-row"><span class="header-key">${esc(h.key)}</span><span class="header-val">${esc(h.line.replace(/^[^:]+:\s*/, ''))}</span></div>`)
    .join('');

  const raw = el('rawBody');
  raw.dataset.loaded = '';
  raw.dataset.id = full.id;
  raw.textContent = '';
}

async function loadRaw() {
  const raw = el('rawBody');
  if (raw.dataset.loaded) return;
  try {
    const res = await fetch(`/api/messages/${encodeURIComponent(raw.dataset.id)}/raw`);
    raw.textContent = await res.text();
    raw.dataset.loaded = '1';
  } catch {
    raw.textContent = '(failed to load raw source)';
  }
}

function setTab(tab) {
  activeTab = tab;
  for (const btn of document.querySelectorAll('.tab')) {
    btn.setAttribute('aria-selected', btn.dataset.tab === tab ? 'true' : 'false');
  }
  el('previewWrap').hidden = tab !== 'preview';
  el('textBody').hidden = tab !== 'text';
  el('rawBody').hidden = tab !== 'raw';
  el('headersBody').hidden = tab !== 'headers';
  if (tab === 'raw') loadRaw();
}

function closeMessage() {
  selectedId = null;
  document.body.dataset.view = 'list';
  el('message').hidden = true;
  el('readEmpty').hidden = false;
  renderList();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function deleteOne(id) {
  await fetch(`/api/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function clearAll() {
  if (!messages.length) return;
  if (!confirm('Clear all trapped mail?')) return;
  await fetch('/api/messages', { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const SUN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5.6 5.6L4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4"/></svg>`;
const MOON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;

function applyTheme(theme) {
  root.dataset.theme = theme;
  document.body.style.background = theme === 'dark' ? '#100e15' : '#fdeee3';
  el('themeToggle').innerHTML = theme === 'dark' ? SUN : MOON;
  try { localStorage.setItem('marla-theme', theme); } catch {}
}
function toggleTheme() {
  applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
}

// ---------------------------------------------------------------------------
// Settings (hung off the connection pill)
// ---------------------------------------------------------------------------

function applyPorts(s) {
  if (s.smtpPort) {
    smtpPort = s.smtpPort;
    el('connPort').textContent = `SMTP :${s.smtpPort}`;
    el('listEmptyAddr').textContent = `smtp://0.0.0.0:${s.smtpPort}`;
    el('readEmptyPort').textContent = `:${s.smtpPort}`;
    el('smtpPortInput').value = s.smtpPort;
  }
  if (s.httpPort) el('httpPortInput').value = s.httpPort;
}

async function loadSettings() {
  try { applyPorts(await (await fetch('/api/settings')).json()); } catch {}
}

function setSettingsMsg(text, kind) {
  const m = el('settingsMsg');
  m.textContent = text || '';
  if (kind) m.dataset.kind = kind; else delete m.dataset.kind;
}

// Track unsaved edits so closing can warn before discarding.
let savedPortValue = '';
function isDirty() {
  return el('smtpPortInput').value.trim() !== savedPortValue.trim();
}

function openSettings() {
  setSettingsMsg('');
  el('confirm').hidden = true;
  loadSettings();
  savedPortValue = String(smtpPort);
  el('settings').showModal();
}

// Close only when clean; otherwise surface the discard confirmation.
function requestClose() {
  if (isDirty()) {
    el('confirm').hidden = false;
    el('confirmKeep').focus();
  } else {
    el('settings').close();
  }
}

function forceClose() {
  el('confirm').hidden = true;
  el('settings').close();
}

async function saveSettings(e) {
  e.preventDefault();
  const port = parseInt(el('smtpPortInput').value, 10);
  setSettingsMsg('Rebinding…');
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smtpPort: port }),
    });
    const data = await res.json();
    applyPorts(data);
    if (res.ok) {
      savedPortValue = String(data.smtpPort); // edits are now persisted
      setSettingsMsg(`Trap now listening on :${data.smtpPort}`, 'ok');
    } else {
      setSettingsMsg(data.error || 'Could not change port.', 'error');
    }
  } catch {
    setSettingsMsg('Request failed — is the server still running?', 'error');
  }
}

// ---------------------------------------------------------------------------
// Signature cue: rainbow sweep + toast + logo wiggle on catch
// ---------------------------------------------------------------------------

function springCatch() {
  const sweep = el('sweep');
  const toast = el('toast');
  const mark = el('mark');
  for (const [node, cls] of [[sweep, 'run'], [toast, 'show'], [mark, 'wiggle']]) {
    node.classList.remove(cls);
    void node.offsetWidth; // restart animation
    node.classList.add(cls);
  }
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

function setConn(state) {
  const conn = el('conn');
  conn.dataset.state = state;
  conn.querySelector('.conn-label').textContent =
    state === 'live' ? 'live' : state === 'down' ? 'reconnecting' : 'connecting';
}

// ---------------------------------------------------------------------------
// WebSocket live feed
// ---------------------------------------------------------------------------

let ws = null;
let reconnectDelay = 1000;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener('open', () => { setConn('live'); reconnectDelay = 1000; });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'new') {
      messages.unshift(msg.message);
      if (messages.length > 500) messages.pop();
      renderList();
      markLand(msg.message.id);
      springCatch();
    } else if (msg.type === 'delete') {
      messages = messages.filter((m) => m.id !== msg.id);
      if (selectedId === msg.id) closeMessage();
      else renderList();
    } else if (msg.type === 'clear') {
      messages = [];
      closeMessage();
    } else if (msg.type === 'settings') {
      applyPorts(msg);
    }
  });

  ws.addEventListener('close', () => {
    setConn('down');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 10000);
  });
  ws.addEventListener('error', () => ws.close());
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function loadInitial() {
  try { messages = await (await fetch('/api/messages')).json(); }
  catch { messages = []; }
  renderList();
}

function bindEvents() {
  filterEl.addEventListener('input', renderList);
  el('clearAll').addEventListener('click', clearAll);
  el('themeToggle').addEventListener('click', toggleTheme);
  el('back').addEventListener('click', closeMessage);
  el('deleteOne').addEventListener('click', () => selectedId && deleteOne(selectedId));
  el('conn').addEventListener('click', openSettings);

  el('settingsForm').addEventListener('submit', saveSettings);
  el('cancelSettings').addEventListener('click', requestClose);
  el('closeSettings').addEventListener('click', requestClose);
  el('confirmKeep').addEventListener('click', () => { el('confirm').hidden = true; el('smtpPortInput').focus(); });
  el('confirmDiscard').addEventListener('click', forceClose);

  // Click on the backdrop (the dialog element itself, outside the form) closes.
  el('settings').addEventListener('click', (e) => {
    if (e.target === el('settings') && el('confirm').hidden) requestClose();
  });
  // Escape fires the dialog's cancel event — intercept to guard unsaved edits.
  el('settings').addEventListener('cancel', (e) => {
    e.preventDefault();
    if (!el('confirm').hidden) { el('confirm').hidden = true; return; }
    requestClose();
  });

  listEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = [...listEl.querySelectorAll('.row')];
    if (!rows.length) return;
    const cur = rows.findIndex((r) => r.dataset.id === selectedId);
    const next = e.key === 'ArrowDown' ? Math.min(cur + 1, rows.length - 1) : Math.max(cur - 1, 0);
    const target = rows[next < 0 ? 0 : next];
    if (target) { select(target.dataset.id); target.scrollIntoView({ block: 'nearest' }); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selectedId && !el('settings').open) closeMessage();
  });
}

setInterval(() => { if (messages.length) renderList(); }, 60000);

let savedTheme = 'light';
try { savedTheme = localStorage.getItem('marla-theme') || 'light'; } catch {}
applyTheme(savedTheme);
bindEvents();
loadSettings();
loadInitial();
connect();
