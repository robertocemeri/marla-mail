'use strict';
// Connects to the live feed, fires a send, asserts a "new" event arrives.
const WebSocket = require('ws');
const { execFile } = require('child_process');

const ws = new WebSocket('ws://localhost:8025/ws');
const timer = setTimeout(() => { console.error('FAIL: no event within 4s'); process.exit(1); }, 4000);

ws.on('open', () => {
  console.log('ws: connected, sending a message…');
  execFile('node', ['test-send.js'], { cwd: __dirname });
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  console.log('ws: received event ->', msg.type);
  if (msg.type === 'new') {
    console.log('   subject:', msg.message.subject);
    console.log('   attachments:', msg.message.attachmentCount);
    console.log('PASS: live push works');
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
