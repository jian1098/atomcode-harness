'use strict';

/**
 * AtomCode CLI bridge.
 *
 * The CLI is driven in headless mode:
 *   atomcode --dev --no-telemetry --output-format jsonl \
 *            --prompt-file <utf8 file> -C <cwd> [--model X] [-y] [--resume <id>]
 *
 * stdout = one JSON event per line, stderr = diagnostics + the resume hint.
 */
const { spawn, execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME = os.homedir();
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const ATOM_HOME = process.env.ATOMCODE_HOME || path.join(HOME, '.atomcode');

function resolveCli() {
  const candidates = [
    process.env.ATOMCODE_CLI,
    path.join(LOCAL_APP_DATA, 'AtomCode', 'atomcode.exe'),
    path.join(LOCAL_APP_DATA, 'AtomCode', 'atomcode'),
    '/usr/local/bin/atomcode',
    path.join(HOME, '.local', 'bin', 'atomcode'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch (_) { /* ignore */ }
  }
  return process.platform === 'win32' ? 'atomcode.exe' : 'atomcode';
}

const CLI = resolveCli();

function execCli(args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(CLI, ['--dev', '--no-telemetry', ...args], {
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4,
      env: { ...process.env, ATOMCODE_NO_UPDATE: '1' },
    }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function cleanNoise(line) {
  return !/Console code pages|CJK input\/output|Use Windows Terminal|chcp 65001|^\[dev\]/i.test(line);
}

async function getStatus() {
  const { error, stdout } = await execCli(['status']);
  const text = stdout.split(/\r?\n/).filter(cleanNoise).join('\n').trim();
  const user = (text.match(/Logged in as:\s*(.+)/) || [])[1];
  const name = (text.match(/^\s*Name:\s*(.+)/m) || [])[1];
  const email = (text.match(/^\s*Email:\s*(.+)/m) || [])[1];
  return {
    ok: !error && !!user,
    loggedIn: !!user,
    user: user ? user.trim() : null,
    name: name ? name.trim() : null,
    email: email ? email.trim() : null,
    raw: text,
  };
}

async function getVersion() {
  const { stdout } = await execCli(['--version'], 12000);
  const line = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || '';
  return line.slice(0, 80);
}

/** Parse [models.*] tables + default_model from ~/.atomcode/config.toml */
function getModels() {
  const configPath = path.join(ATOM_HOME, 'config.toml');
  let text = '';
  try { text = fs.readFileSync(configPath, 'utf8'); } catch (_) { /* no config yet */ }
  const defaultModel = (text.match(/^default_model\s*=\s*"([^"]+)"/m) || [])[1] || '';
  const models = [];
  const re = /^\[models\.([^\]]+)\]\s*$/gm;
  let match;
  while ((match = re.exec(text))) {
    const id = match[1].replace(/^"|"$/g, '').trim();
    const start = re.lastIndex;
    const next = text.indexOf('\n[', start);
    const block = text.slice(start, next === -1 ? undefined : next);
    const model = (block.match(/^\s*model\s*=\s*"([^"]+)"/m) || [])[1] || id;
    const account = (block.match(/^\s*account\s*=\s*"([^"]+)"/m) || [])[1] || '';
    const context = (block.match(/^\s*context_window\s*=\s*(\d+)/m) || [])[1];
    models.push({ id, name: model, account, contextWindow: context ? Number(context) : null });
  }
  if (!models.length && defaultModel) models.push({ id: defaultModel, name: defaultModel, account: '' });
  return { models, defaultModel: defaultModel || (models[0] && models[0].id) || '' };
}

/**
 * --model expects the provider's model name (e.g. "glm5.3-flash"), NOT the
 * [models."..."] config alias. Passing the alias makes the API return 403.
 */
function normalizeModel(model) {
  if (!model) return '';
  const { models } = getModels();
  const hit = models.find((m) => m.id === model || m.name === model);
  return hit ? hit.name : model;
}

function getRecentDirs() {
  try {
    return fs.readFileSync(path.join(ATOM_HOME, 'recent_dirs.txt'), 'utf8')
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
  } catch (_) { return []; }
}

/** Recent CLI sessions (best-effort, for the "工作区" grouping / diagnostics). */
function getCliSessions() {
  const root = path.join(ATOM_HOME, 'sessions');
  const out = [];
  try {
    for (const group of fs.readdirSync(root)) {
      const dir = path.join(root, group);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.jsonl') && !file.endsWith('.events')) continue;
        const full = path.join(dir, file);
        try {
          const stat = fs.statSync(full);
          out.push({ id: file.replace(/\.(jsonl|events)$/, ''), group, updatedAt: stat.mtimeMs, size: stat.size });
        } catch (_) { /* ignore */ }
      }
    }
  } catch (_) { /* no sessions dir */ }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40);
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'build', 'target', 'vendor', '.next',
  '.idea', '.vscode', '__pycache__', '.cache', 'coverage', '.atomcode',
]);

/** Shallow file listing for @-mention autocomplete. */
function listFiles(cwd, query = '') {
  const q = query.toLowerCase();
  const results = [];
  const max = 300;
  function walk(dir, rel, depth) {
    if (results.length >= max || depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (results.length >= max) break;
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), childRel, depth + 1);
      } else if (!q || childRel.toLowerCase().includes(q)) {
        results.push(childRel);
      }
    }
  }
  walk(cwd, '', 0);
  return results;
}

/**
 * Slash commands (commands/*.md) and skills (skills/<name>/SKILL.md).
 * README / CHANGELOG and template folders are intentionally ignored.
 */
function listSkills(cwd) {
  const roots = [
    path.join(cwd, '.atomcode', 'commands'),
    path.join(ATOM_HOME, 'commands'),
    path.join(ATOM_HOME, 'plugins', 'marketplaces'),
  ];
  const generic = /^(readme|readme\.zh|changelog|license|contributing|example-skill|template|skill)$/i;
  const found = new Map();
  let visited = 0;

  function add(name, file) {
    if (!name || generic.test(name) || found.has(name)) return;
    let desc = '';
    try {
      const head = fs.readFileSync(file, 'utf8').slice(0, 1000);
      desc = (head.match(/^\s*description:\s*(.+)$/m) || [])[1]
        || (head.match(/^#\s+(.+)$/m) || [])[1] || '';
    } catch (_) { /* ignore */ }
    found.set(name, { name, description: String(desc).replace(/^["']|["']$/g, '').trim().slice(0, 90) });
  }

  function walk(dir, depth) {
    if (depth > 7 || found.size >= 80 || visited++ > 1500) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'templates' || entry.name === 'scripts') continue;
        walk(full, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        const isSkill = entry.name.toLowerCase() === 'skill.md';
        const inCommands = full.split(/[\\/]/).includes('commands');
        if (!isSkill && !inCommands) continue;
        const name = isSkill ? path.basename(path.dirname(full)) : entry.name.replace(/\.md$/, '');
        add(name, full);
      }
    }
  }
  for (const root of roots) walk(root, 0);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Start one headless run. Returns a handle with .kill().
 * onEvent receives every parsed JSONL object plus {type:'stderr', text}.
 */
function startRun(options) {
  const {
    prompt, cwd, model, resumeId, skipPermissions = false, noTools = false,
    onEvent = () => {}, onSession = () => {}, onClose = () => {},
  } = options;

  const tmpFile = path.join(os.tmpdir(),
    `atomcode-harness-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`);
  fs.writeFileSync(tmpFile, prompt, 'utf8');
  const modelArg = normalizeModel(model);

  const args = [
    '--dev', '--no-telemetry',
    '--output-format', 'jsonl',
    '--prompt-file', tmpFile,
    '-C', cwd,
  ];
  if (modelArg) args.push('--model', modelArg);
  if (skipPermissions) args.push('-y');
  if (noTools) args.push('--no-tools');
  if (resumeId) args.push('--resume', resumeId);

  const startedAt = Date.now();
  let child;
  try {
    child = spawn(CLI, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ATOMCODE_NO_UPDATE: '1' },
    });
  } catch (error) {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
    onClose({ code: -1, signal: null, error: error.message, durationMs: 0 });
    return { kill() {}, pid: null };
  }

  let stdoutBuf = '';
  let stderrBuf = '';
  let sessionId = resumeId || null;
  let closed = false;
  let killed = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let index;
    while ((index = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, index).trim();
      stdoutBuf = stdoutBuf.slice(index + 1);
      if (!line) continue;
      if (!line.startsWith('{')) {
        if (cleanNoise(line)) onEvent({ type: 'stdout.noise', text: line });
        continue;
      }
      try { onEvent(JSON.parse(line)); } catch (_) { /* skip malformed line */ }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (stderrBuf.length > 200000) return;
    stderrBuf += chunk;
    const match = stderrBuf.match(/--resume\s+([0-9a-fA-F]{8}-[0-9a-fA-F-]{27,})/);
    if (match && match[1] !== sessionId) {
      sessionId = match[1];
      onSession(sessionId);
    }
    // Surface meaningful diagnostics only (drop the Windows codepage boilerplate).
    for (const line of chunk.split(/\r?\n/)) {
      const text = line.trim();
      if (!text || !cleanNoise(text)) continue;
      if (/^\[error\]|^error:|failed|失败|错误/i.test(text)) onEvent({ type: 'stderr', text });
    }
  });

  const finish = (code, signal, error) => {
    if (closed) return;
    closed = true;
    if (stdoutBuf.trim().startsWith('{')) {
      try { onEvent(JSON.parse(stdoutBuf.trim())); } catch (_) { /* ignore */ }
    }
    try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
    onClose({
      code, signal, error: error || null,
      sessionId,
      durationMs: Date.now() - startedAt,
      killed,
      stderrTail: stderrBuf.split(/\r?\n/).filter(cleanNoise).slice(-6).join('\n'),
    });
  };

  child.on('error', (error) => finish(-1, null, error.message));
  child.on('close', (code, signal) => finish(code, signal, null));

  return {
    pid: child.pid,
    args,
    kill() {
      if (closed) return;
      killed = true;
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          child.kill('SIGTERM');
        }
      } catch (_) { /* ignore */ }
      try { child.kill(); } catch (_) { /* ignore */ }
      // If the process refuses to die, still release the request.
      setTimeout(() => finish(null, 'SIGKILL', null), 2500).unref();
    },
  };
}

/* ---------------- CodingPlan usage (official CLI daemon API) ----------------
 * The TUI /usage panel reads GET /codingplan/usage/summary from atomcode daemon.
 * We reuse an existing daemon, or start our own on a private loopback port.
 */
const DAEMON_PORTS = [Number(process.env.ATOMCODE_DAEMON_PORT || 13458), 13459];
let daemonPort = null;
let daemonProcess = null;
let usageCache = { at: 0, data: null };

// Global fetch is unavailable on Node < 18; use the built-in http module so
// the daemon probe and usage request work on any Node version.
function httpGetJson(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`响应不是合法 JSON: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
  });
}

async function probeDaemon(port, timeout = 1500) {
  try {
    const data = await httpGetJson(`http://127.0.0.1:${port}/health`, timeout);
    return !!data && data.service === 'atomcode-daemon';
  } catch (_) { return false; }
}

// A live daemon may still be unusable for us: e.g. the IDE-plugin daemon
// (usually 13456) requires a token, so its API answers 401 without auth.
async function usableDaemon(port) {
  if (!await probeDaemon(port, 1200)) return false;
  try {
    await httpGetJson(`http://127.0.0.1:${port}/models`, 3000);
    return true;
  } catch (_) { return false; }
}

async function spawnDaemon(port) {
  daemonProcess = spawn(CLI, [
    '--dev', 'daemon', '--port', String(port), '--no-auth', '--idle-timeout', '1800',
  ], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, ATOMCODE_NO_UPDATE: '1' },
  });
  daemonProcess.on('error', () => { if (daemonPort !== port) daemonProcess = null; });
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await probeDaemon(port, 1000)) { daemonPort = port; return port; }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('AtomCode daemon 启动超时');
}

async function ensureDaemon() {
  if (daemonPort && await usableDaemon(daemonPort)) return daemonPort;
  daemonPort = null;
  for (const port of DAEMON_PORTS) {
    if (await usableDaemon(port)) { daemonPort = port; return port; }
  }
  // Every healthy candidate was rejected (or none responded): start our own
  // on the first port not already taken by another daemon.
  for (const port of DAEMON_PORTS) {
    if (await probeDaemon(port, 800)) continue;
    return await spawnDaemon(port);
  }
  throw new Error('AtomCode daemon 启动超时: 候选端口均被占用');
}

async function getUsageSummary(refresh = false) {
  if (!refresh && usageCache.data && Date.now() - usageCache.at < 30000) return usageCache.data;
  const port = await ensureDaemon();
  const data = await httpGetJson(`http://127.0.0.1:${port}/codingplan/usage/summary`, 15000);
  usageCache = { at: Date.now(), data };
  return data;
}

module.exports = {
  CLI, ATOM_HOME, resolveCli, getStatus, getVersion, getModels, normalizeModel,
  getRecentDirs, getCliSessions, listFiles, listSkills, startRun,
  getUsageSummary, ensureDaemon,
};
