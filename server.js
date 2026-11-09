'use strict';

/**
 * AtomCode Harness — a local web shell that drives the real AtomCode CLI.
 * Zero third-party dependencies: node server.js  →  http://127.0.0.1:5178
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cli = require('./lib/cli');
const store = require('./lib/store');

const PORT = Number(process.env.PORT || 5178);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const DEFAULT_CWD = process.env.ATOMCODE_HARNESS_CWD || __dirname;
const running = new Map(); // harness session id -> run handle

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 12 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (_) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function validDir(dir) {
  if (!dir || typeof dir !== 'string') return null;
  const resolved = path.resolve(dir);
  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
  } catch (_) { /* ignore */ }
  return null;
}

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
}

function sseSend(res, payload) {
  if (res.writableEnded) return;
  try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) { /* client gone */ }
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) {
    return json(res, 403, { error: 'Forbidden' });
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      // SPA fallback
      if (!path.extname(file)) {
        return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
          if (e2) return json(res, 404, { error: 'Not found' });
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(html);
        });
      }
      return json(res, 404, { error: 'Not found' });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function buildPrompt(message, attachments) {
  let prompt = String(message || '').trim();
  if (Array.isArray(attachments) && attachments.length) {
    const lines = attachments.map((a) => `- ${a.path}`).join('\n');
    prompt = `以下是本次对话附加的文件（如需查看请用工具读取）：\n${lines}\n\n${prompt}`;
  }
  return prompt;
}

/** POST /api/chat — stream one CLI turn over SSE. */
async function handleChat(req, res) {
  let body;
  try { body = await readBody(req); } catch (error) { return json(res, 400, { error: error.message }); }

  const session = store.getSession(body.sessionId);
  if (!session) return json(res, 404, { error: '会话不存在' });
  const text = String(body.message || '').trim();
  if (!text) return json(res, 400, { error: '消息不能为空' });
  if (running.has(session.id)) return json(res, 409, { error: '该会话正在生成中' });

  const cwd = validDir(body.cwd || session.cwd) || DEFAULT_CWD;
  const model = body.model || session.model || '';
  const skipPermissions = body.skipPermissions !== undefined ? !!body.skipPermissions : session.skipPermissions;
  const noTools = body.noTools !== undefined ? !!body.noTools : !!session.noTools;
  const prompt = buildPrompt(text, body.attachments);

  store.updateSession(session.id, { cwd, model, skipPermissions, noTools });
  const userMessage = store.appendMessage(session.id, {
    role: 'user', content: text, attachments: body.attachments || [],
  });

  // Name the conversation after its first user message.
  const existing = store.getMessages(session.id);
  let titleEvent = null;
  if (existing.filter((m) => m.role === 'user').length === 1) {
    const title = text.replace(/\s+/g, ' ').slice(0, 24) + (text.length > 24 ? '…' : '');
    store.updateSession(session.id, { title });
    titleEvent = { type: 'session.title', title, sessionId: session.id };
  }

  const assistant = store.appendMessage(session.id, {
    role: 'assistant', content: '', reasoning: '', tools: [], usage: null,
    model, cwd, streaming: true,
  });

  sseHeaders(res);
  sseSend(res, {
    type: 'run.start', sessionId: session.id, userMessageId: userMessage.id,
    assistantMessageId: assistant.id, model, cwd, skipPermissions,
  });
  if (titleEvent) sseSend(res, titleEvent);

  const state = { content: '', reasoning: '', tools: [], usage: null, stats: null, error: null };
  let cliSessionId = session.cliSessionId;
  let lastPersist = Date.now();
  let dirty = false;
  let finished = false;

  const persistAssistant = (extra = {}) => {
    store.replaceMessage(session.id, assistant.id, {
      content: state.content,
      reasoning: state.reasoning,
      tools: state.tools,
      usage: state.usage,
      stats: state.stats,
      error: state.error,
      ...extra,
    });
    dirty = false;
    lastPersist = Date.now();
  };

  const onEvent = (event) => {
    if (!event || !event.type) return;
    const type = event.type;

    if (type === 'message.delta' || type === 'assistant.delta' || type === 'content.delta') {
      state.content += String(event.text || '');
      dirty = true;
    } else if (type === 'reasoning.delta' || type === 'thinking.delta') {
      state.reasoning += String(event.text || '');
      dirty = true;
    } else if (type === 'tool.started' || type === 'tool.call') {
      state.tools.push({
        id: event.id || `tool_${state.tools.length}`,
        name: event.name || 'tool',
        arguments: typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.arguments || {}),
        content: '', is_error: false,
      });
      dirty = true;
    } else if (type === 'tool.completed' || type === 'tool.result') {
      let tool = state.tools.find((t) => t.id === event.id);
      if (!tool) {
        tool = { id: event.id || `tool_${state.tools.length}`, name: event.name || 'tool', arguments: '', content: '', is_error: false };
        state.tools.push(tool);
      }
      tool.content = String(event.content ?? event.output ?? '');
      tool.is_error = !!event.is_error;
      dirty = true;
    } else if (type === 'usage') {
      state.usage = { ...(state.usage || {}), ...event };
      dirty = true;
    } else if (type === 'turn.completed') {
      state.stats = event;
    } else if (type === 'error') {
      state.error = event.message || 'CLI 运行错误';
      dirty = true;
    }

    sseSend(res, event);
    if (dirty && Date.now() - lastPersist > 1500) persistAssistant();
  };

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) { try { res.write(': ping\n\n'); } catch (_) { /* ignore */ } }
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    running.delete(session.id);
  };

  // res 'close' = the browser went away. (req 'close' also fires as soon as a
  // POST body is fully consumed on modern Node, which would kill every run.)
  res.on('close', () => {
    if (finished) return;
    const handle = running.get(session.id);
    if (handle) handle.kill();
    if (!res.writableEnded) {
      finished = true;
      clearInterval(heartbeat);
      running.delete(session.id);
      persistAssistant({ streaming: false, interrupted: true });
    }
  });

  const handle = cli.startRun({
    prompt, cwd, model, resumeId: session.cliSessionId, skipPermissions, noTools,
    onEvent,
    onSession: (id) => {
      cliSessionId = id;
      store.updateSession(session.id, { cliSessionId: id });
      sseSend(res, { type: 'session.linked', cliSessionId: id });
    },
    onClose: (result) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (result.sessionId && result.sessionId !== cliSessionId) {
        store.updateSession(session.id, { cliSessionId: result.sessionId });
      }
      persistAssistant({
        streaming: false,
        interrupted: !!result.killed || result.code !== 0,
        exitCode: result.code,
      });
      sseSend(res, {
        type: 'run.done',
        code: result.code,
        signal: result.signal,
        killed: !!result.killed,
        error: result.error || state.error,
        durationMs: result.durationMs,
        cliSessionId: result.sessionId || cliSessionId,
        stderrTail: result.stderrTail,
      });
      res.end();
    },
  });
  running.set(session.id, handle);
}

async function handleBootstrap(res) {
  const [status, version, models] = await Promise.all([
    cli.getStatus(), cli.getVersion(), Promise.resolve(cli.getModels()),
  ]);
  json(res, 200, {
    ok: true,
    cliPath: cli.CLI,
    version,
    status,
    models: models.models,
    defaultModel: models.defaultModel,
    defaultCwd: DEFAULT_CWD,
    recentDirs: cli.getRecentDirs(),
    cliSessions: cli.getCliSessions().slice(0, 10),
    sessions: store.sessions(),
    platform: process.platform,
    home: os.homedir(),
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  try {
    if (method === 'GET' && pathname === '/api/bootstrap') return await handleBootstrap(res);

    if (method === 'GET' && pathname === '/api/status') {
      return json(res, 200, { status: await cli.getStatus(), version: await cli.getVersion() });
    }

    // /usage panel data: CodingPlan quota from the CLI daemon + this session's context usage.
    if (method === 'GET' && pathname === '/api/usage') {
      const refresh = url.searchParams.get('refresh') === '1';
      const sessionId = url.searchParams.get('sessionId') || '';
      let summary = null;
      let error = null;
      try { summary = await cli.getUsageSummary(refresh); }
      catch (e) { error = e.message; }

      const config = cli.getModels();
      const session = sessionId ? store.getSession(sessionId) : null;
      const wanted = session?.model || config.defaultModel;
      const info = config.models.find((m) => m.id === wanted || m.name === wanted) || config.models[0];
      const limit = info?.contextWindow || 0;
      let used = 0;
      if (sessionId) {
        const messages = store.getMessages(sessionId);
        for (let i = messages.length - 1; i >= 0; i--) {
          const usage = messages[i].usage;
          if (usage && (usage.prompt_tokens || usage.total_tokens)) {
            used = Number(usage.prompt_tokens || usage.total_tokens || 0);
            break;
          }
        }
      }
      return json(res, 200, {
        summary, error,
        context: {
          used, limit, model: info?.name || '',
          percent: limit ? Math.min(100, Number((used / limit * 100).toFixed(1))) : 0,
        },
        fetchedAt: Date.now(),
      });
    }

    if (method === 'GET' && pathname === '/api/sessions') {
      return json(res, 200, { sessions: store.sessions() });
    }

    if (method === 'POST' && pathname === '/api/sessions') {
      const body = await readBody(req);
      const cwd = validDir(body.cwd) || DEFAULT_CWD;
      return json(res, 200, { session: store.createSession({ ...body, cwd }) });
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/);
    if (sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1]);
      const action = sessionMatch[2] || '';
      const session = store.getSession(id);
      if (!session) return json(res, 404, { error: '会话不存在' });

      if (method === 'GET' && action === 'messages') {
        return json(res, 200, { messages: store.getMessages(id) });
      }
      if (method === 'PATCH' && !action) {
        const body = await readBody(req);
        if (body.cwd) {
          const cwd = validDir(body.cwd);
          if (!cwd) return json(res, 400, { error: '工作目录不存在' });
          body.cwd = cwd;
        }
        return json(res, 200, { session: store.updateSession(id, body) });
      }
      if (method === 'DELETE' && !action) {
        const handle = running.get(id);
        if (handle) handle.kill();
        store.deleteSession(id);
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && action === 'clear') {
        if (running.has(id)) return json(res, 409, { error: '请先停止生成' });
        return json(res, 200, { session: store.clearMessages(id), messages: [] });
      }
      if (method === 'POST' && action === 'reset-context') {
        if (running.has(id)) return json(res, 409, { error: '请先停止生成' });
        return json(res, 200, { session: store.updateSession(id, { cliSessionId: null }) });
      }
    }

    if (method === 'POST' && pathname === '/api/chat') return await handleChat(req, res);

    if (method === 'POST' && pathname === '/api/stop') {
      const body = await readBody(req);
      const handle = running.get(body.sessionId);
      if (!handle) return json(res, 200, { ok: true, stopped: false });
      handle.kill();
      return json(res, 200, { ok: true, stopped: true });
    }

    if (method === 'GET' && pathname === '/api/files') {
      const cwd = validDir(url.searchParams.get('cwd')) || DEFAULT_CWD;
      return json(res, 200, { cwd, files: cli.listFiles(cwd, url.searchParams.get('q') || '') });
    }

    if (method === 'GET' && pathname === '/api/skills') {
      const cwd = validDir(url.searchParams.get('cwd')) || DEFAULT_CWD;
      return json(res, 200, { skills: cli.listSkills(cwd) });
    }

    if (method === 'GET' && pathname === '/api/branch') {
      const cwd = validDir(url.searchParams.get('cwd')) || DEFAULT_CWD;
      // Only ask git when cwd is actually inside a work tree, otherwise the
      // "fatal: not a git repository" stderr noise leaks on every session.
      let dir = cwd;
      let isRepo = false;
      while (true) {
        if (fs.existsSync(path.join(dir, '.git'))) { isRepo = true; break; }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      if (!isRepo) return json(res, 200, { branch: '' });
      let branch = '';
      try {
        branch = (await new Promise((resolve, reject) => {
          require('child_process').execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd, timeout: 5000, windowsHide: true, encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
      })).trim();
      } catch (_) { /* git missing or detached HEAD */ }
      return json(res, 200, { branch });
    }

    if (method === 'GET' && pathname === '/api/dirs') {
      const query = String(url.searchParams.get('q') || '').trim();
      const cwd = validDir(url.searchParams.get('cwd')) || DEFAULT_CWD;
      let children = [];
      try {
        children = fs.readdirSync(path.dirname(cwd), { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => path.join(path.dirname(cwd), e.name))
          .slice(0, 40);
      } catch (_) { /* ignore */ }
      const candidates = [...new Set([cwd, ...cli.getRecentDirs(), ...children])];
      if (query && validDir(query)) candidates.unshift(validDir(query));
      return json(res, 200, {
        cwd,
        query,
        suggestions: [...new Set(candidates)]
          .map((d) => validDir(d))
          .filter((d) => d && (!query || d.toLowerCase().includes(query.toLowerCase())))
          .slice(0, 20),
      });
    }

    if (method === 'POST' && pathname === '/api/attach') {
      const body = await readBody(req);
      const cwd = validDir(body.cwd) || DEFAULT_CWD;
      const name = path.basename(String(body.name || 'attachment')).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 80);
      const dir = path.join(cwd, '.atomcode-harness', 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      const buffer = Buffer.from(String(body.contentBase64 || '').split(',').pop(), 'base64');
      if (!buffer.length || buffer.length > 8 * 1024 * 1024) return json(res, 400, { error: '文件大小不合法（上限 8MB）' });
      const target = path.join(dir, `${Date.now()}-${name}`);
      fs.writeFileSync(target, buffer);
      return json(res, 200, {
        attachment: { name, path: path.relative(cwd, target).replace(/\\/g, '/'), size: buffer.length },
      });
    }

    // Serves pasted/uploaded images for preview. Only files inside the
    // session cwd's .atomcode-harness/uploads are reachable.
    if (method === 'GET' && pathname === '/api/attachment') {
      const cwd = validDir(url.searchParams.get('cwd')) || DEFAULT_CWD;
      const rel = String(url.searchParams.get('path') || '');
      // The stored path is relative to the session cwd (e.g.
      // ".atomcode-harness/uploads/x.png"), so resolve it against the cwd
      // and then confine the result to the uploads directory.
      const base = path.resolve(cwd, '.atomcode-harness', 'uploads');
      const file = path.resolve(cwd, rel);
      if (!file.startsWith(base + path.sep)) return json(res, 403, { error: 'Forbidden' });
      fs.readFile(file, (error, data) => {
        if (error) return json(res, 404, { error: 'Not found' });
        const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=3600' });
        res.end(data);
      });
      return;
    }

    if (method === 'GET') return serveStatic(req, res, pathname);
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error('[harness] request error:', error);
    if (!res.headersSent) return json(res, 500, { error: error.message || String(error) });
    if (!res.writableEnded) {
      sseSend(res, { type: 'run.done', error: error.message, code: -1 });
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  AtomCode Harness');
  console.log(`  ➜  http://${HOST}:${PORT}`);
  console.log(`  ➜  CLI: ${cli.CLI}`);
  console.log(`  ➜  CWD: ${DEFAULT_CWD}`);
  console.log('');
});
