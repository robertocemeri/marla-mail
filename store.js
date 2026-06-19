'use strict';

// In-memory ring buffer of trapped messages. Restart clears everything.
// Newest-first ordering is maintained by always unshifting onto the front.

const MAX_MESSAGES = 500;

let seq = 0;
const messages = []; // index 0 === newest

function makeId() {
  seq += 1;
  // Monotonic + a little entropy so ids stay unique and unguessable-enough.
  return `${Date.now().toString(36)}-${seq.toString(36)}`;
}

function add(message) {
  message.id = makeId();
  messages.unshift(message);
  // Evict from the tail (oldest) when we exceed the cap.
  while (messages.length > MAX_MESSAGES) {
    messages.pop();
  }
  return message;
}

function all() {
  return messages;
}

function get(id) {
  return messages.find((m) => m.id === id);
}

function remove(id) {
  const i = messages.findIndex((m) => m.id === id);
  if (i === -1) return false;
  messages.splice(i, 1);
  return true;
}

function clear() {
  const n = messages.length;
  messages.length = 0;
  return n;
}

module.exports = { add, all, get, remove, clear, MAX_MESSAGES };
