'use strict';

/** Tiny JSON-file store: harness conversations + their CLI session pointers. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', 'data');
const MESSAGE_DIR = path.join(ROOT, 'messages');
const SESSION_FILE = path.join(ROOT, 'sessions.json');

fs.mkdirSync(MESSAGE_DIR, { recursive: true });
if (!fs.existsSync(SESSION_FILE)) fs.writeFileSync(SESSION_FILE, '[]', 'utf8');

const now = () => Date.now();
const uid = () => crypto.randomUUID();

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function sessions() {
  const list = readJson(SESSION_FILE, []);
  return Array.isArray(list) ? list : [];
}
function persist(list) { writeJson(SESSION_FILE, list); }

function createSession(fields = {}) {
  const item = {
    id: uid(),
    title: fields.title || '新对话',
    kind: fields.kind || 'normal',
    cwd: fields.cwd || process.cwd(),
    model: fields.model || '',
    skipPermissions: fields.skipPermissions !== false,
    noTools: !!fields.noTools,
    cliSessionId: null,
    createdAt: now(),
    updatedAt: now(),
    messageCount: 0,
  };
  persist([item, ...sessions()]);
  writeJson(messagePath(item.id), []);
  return item;
}

function getSession(id) { return sessions().find((s) => s.id === id) || null; }

function updateSession(id, patch) {
  let updated = null;
  const list = sessions().map((s) => {
    if (s.id !== id) return s;
    updated = { ...s, ...patch, id: s.id, updatedAt: now() };
    return updated;
  });
  if (updated) persist(list);
  return updated;
}

function deleteSession(id) {
  persist(sessions().filter((s) => s.id !== id));
  try { fs.unlinkSync(messagePath(id)); } catch (_) { /* ignore */ }
}

function messagePath(id) { return path.join(MESSAGE_DIR, `${id}.json`); }
function getMessages(id) {
  const list = readJson(messagePath(id), []);
  return Array.isArray(list) ? list : [];
}
function appendMessage(id, message) {
  const list = getMessages(id);
  const item = { id: uid(), createdAt: now(), ...message };
  list.push(item);
  writeJson(messagePath(id), list);
  updateSession(id, { messageCount: list.length });
  return item;
}
function replaceMessage(id, messageId, patch) {
  const list = getMessages(id);
  const index = list.findIndex((m) => m.id === messageId);
  if (index === -1) return null;
  list[index] = { ...list[index], ...patch };
  writeJson(messagePath(id), list);
  return list[index];
}
function clearMessages(id) {
  writeJson(messagePath(id), []);
  return updateSession(id, { messageCount: 0, cliSessionId: null, title: '新对话' });
}

module.exports = {
  sessions, createSession, getSession, updateSession, deleteSession,
  getMessages, appendMessage, replaceMessage, clearMessages,
};
