(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

  const state = {
    sessions: [], activeId: null, messages: [],
    models: [], defaultModel: '', defaultCwd: '', recentDirs: [], version: '', status: null,
    model: '', cwd: '', skipPermissions: true, noTools: false,
    showReasoning: false, theme: 'light',
    attachments: [],
    skills: null, skillsCwd: '', fileCache: new Map(),
    runs: new Map(), timer: null,
    results: new Map(),
    drafts: {}, wsCollapsed: new Set(),
    ac: { open: false, items: [], index: 0, match: null, kind: '' },
  };

  /* ---------------- helpers ---------------- */
  async function api(url, options = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function toast(message, isError = false) {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast${isError ? ' error' : ''}`;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.hidden = true; }, 2800);
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const same = d.toDateString() === now.toDateString();
    return same
      ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function fmtDuration(ms) {
    if (!ms && ms !== 0) return '';
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  function basename(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || p; }

  function savePrefs() {
    try {
      localStorage.setItem('atomcode-harness-prefs', JSON.stringify({
        theme: state.theme, showReasoning: state.showReasoning,
        skipPermissions: state.skipPermissions, noTools: state.noTools,
        model: state.model, cwd: state.cwd, activeId: state.activeId,
      }));
    } catch (_) { /* ignore */ }
  }
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem('atomcode-harness-prefs') || '{}'); } catch (_) { return {}; }
  }

  /* ---------------- markdown ---------------- */
  function inlineMd(text) {
    const codes = [];
    let src = String(text).replace(/`([^`\n]+)`/g, (_m, code) => {
      codes.push(`<code>${esc(code)}</code>`);
      return `\u0001${codes.length - 1}\u0001`;
    });
    let out = esc(src);
    out = out
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) =>
        /^(https?:\/\/|mailto:|\/|#)/.test(href)
          ? `<a href="${esc(href)}" target="_blank" rel="noreferrer">${label}</a>` : label)
      .replace(/\u0001(\d+)\u0001/g, (_m, i) => codes[Number(i)] || '');
    return out;
  }

  function isBlockStart(line) {
    return /^\s*```/.test(line) || /^\s{0,3}#{1,4}\s/.test(line)
      || /^\s*([-*+]|\d+\.)\s+/.test(line) || /^\s*>/.test(line)
      || /^\s*\|.*\|/.test(line) || /^\s*---+\s*$/.test(line);
  }

  // With --no-tools some models emit literal <tool_call> text instead of a real
  // tool event. Hide that pseudo-markup so the reply stays readable.
  function cleanAssistantText(text) {
    return String(text || '')
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .replace(/<tool_call>[\s\S]*$/g, '')
      .replace(/<\/?tool_(?:call|result)[^>]*>/g, '');
  }

  function markdown(source) {
    let text = cleanAssistantText(String(source || '').replace(/\r\n/g, '\n'));
    // During streaming a code fence may still be open — close it visually.
    if ((text.match(/^```/gm) || []).length % 2 === 1) text += '\n```';
    const lines = text.split('\n');
    let html = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        if (i < lines.length) i++;
        html += `<pre><button class="code-copy" data-copy>复制</button><code>${esc(code.join('\n'))}</code></pre>`;
        continue;
      }
      if (!line.trim()) { i++; continue; }
      if (/^\s*---+\s*$/.test(line)) { html += '<hr>'; i++; continue; }
      const heading = line.match(/^\s{0,3}(#{1,4})\s+(.*)$/);
      if (heading) {
        const n = heading[1].length;
        html += `<h${n}>${inlineMd(heading[2])}</h${n}>`; i++; continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|\-]+\|\s*$/.test(lines[i + 1])) {
        const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(lines[i]); i += 2;
        let rows = '';
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          rows += `<tr>${cells(lines[i]).map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`; i++;
        }
        html += `<table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
        html += `<blockquote>${inlineMd(quote.join('\n')).replace(/\n/g, '<br>')}</blockquote>`;
        continue;
      }
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          items.push(`<li>${inlineMd(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''))}</li>`); i++;
        }
        html += `<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`;
        continue;
      }
      const para = [line]; i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
      html += `<p>${inlineMd(para.join('\n')).replace(/\n/g, '<br>')}</p>`;
    }
    return html;
  }

  function assistantHtml(msg) {
    let html = '';
    if (msg.reasoning && state.showReasoning) {
      html += `<details class="reasoning-block"><summary><svg class="caret" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>思考过程 <span class="pop-sub">${msg.reasoning.length} 字</span></summary><div class="reasoning-text">${esc(msg.reasoning)}</div></details>`;
    }
    if (msg.tools && msg.tools.length) {
      html += msg.tools.map((tool, index) => {
        const done = tool.content !== '' || tool.is_error || !msg.streaming;
        const cls = tool.is_error ? 'error' : (done ? 'done' : '');
        return `<details class="tool-block" data-tool="${index}">
          <summary><svg class="caret" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
            <span class="tool-name">${esc(tool.name)}</span>
            <span class="pop-sub">${esc(String(tool.arguments || '').slice(0, 60))}</span>
            <span class="tool-state ${cls}"></span></summary>
          <div class="tool-detail"><span class="label">参数</span>${esc(tool.arguments || '{}')}</div>
          <div class="tool-detail"><span class="label">输出</span>${esc(tool.content || (done ? '(无输出)' : '执行中…'))}</div>
        </details>`;
      }).join('');
    }
    const content = cleanAssistantText(msg.content || '');
    const reasoningLine = msg.streaming && msg.reasoning
      ? (msg.reasoning.split(/\n\s*\n/).filter((p) => p.trim()).pop() || '').trim() : '';
    // Always render while streaming (empty reserved) so the block never
    // appears/disappears and pushes the content around.
    const liveHead = msg.streaming ? `<div class="reasoning-live">${esc(reasoningLine)}</div>` : '';
    if (content) html += `<div class="assistant-content">${markdown(content)}${msg.streaming ? `${liveHead}<span class="thinking-dots" title="思考中"><i></i><i></i><i></i></span>` : ''}</div>`;
    else if (msg.streaming) html += `<div class="assistant-content">${liveHead}<span class="thinking-dots" title="思考中"><i></i><i></i><i></i></span></div>`;
    else html += `<div class="assistant-content placeholder-text">（无输出）</div>`;

    if (!msg.streaming) {
      const tokens = msg.stats?.total_tokens || msg.usage?.prompt_tokens;
      const bits = [];
      if (msg.model) bits.push(esc(msg.model));
      if (tokens) bits.push(`${Number(tokens).toLocaleString()} tokens`);
      if (msg.stats?.duration_ms) bits.push(fmtDuration(msg.stats.duration_ms));
      if (msg.stats?.tool_calls) bits.push(`${msg.stats.tool_calls} 次工具调用`);
      if (msg.interrupted) bits.push('已中断');
      html += `<div class="msg-meta">${bits.map((b) => `<span>${b}</span>`).join('')}
        <button data-copy-msg title="复制回复"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a2 2 0 0 0-2 2v9"/></svg>复制</button></div>`;
    }
    if (msg.error) html += `<div class="msg-error">${esc(msg.error)}</div>`;
    return html;
  }

  function userMessageHtml(msg) {
    const chips = (msg.attachments || []).length
      ? `<div class="attach-list">${msg.attachments.map((a) => `<span class="attach-file" data-view="${esc(a.path)}" title="点击预览">${esc(a.name || a.path)}</span>`).join('')}</div>` : '';
    return `<div class="msg-body">${chips}<div class="user-bubble">${esc(msg.content)}</div>
      <div class="msg-meta user-meta">
        <button data-copy-user title="复制消息"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a2 2 0 0 0-2 2v9"/></svg>复制</button>
        <button data-edit-user title="复制内容到输入框重新编辑"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/></svg>重新编辑</button>
      </div></div>`;
  }

  function makeMessageEl(msg, role) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.dataset.id = msg.id || '';
    if (role === 'user') el.innerHTML = userMessageHtml(msg);
    else {
      el.innerHTML = `<div class="msg-avatar"><svg viewBox="0 0 32 32"><path d="M16 5.5l2.6 8 8 2.6-8 2.6-2.6 8-2.6-8-8-2.6 8-2.6z"/><circle cx="24.5" cy="7.5" r="2"/><circle cx="7.5" cy="24.5" r="1.6"/></svg></div>
        <div class="msg-body assistant-body">${assistantHtml(msg)}</div>`;
    }
    return el;
  }

  function openStates(el) {
    const open = new Set();
    el.querySelectorAll('details[data-tool]').forEach((d) => { if (d.open) open.add(d.dataset.tool); });
    return open;
  }

  // Streaming re-renders call scrollToBottom() every ~70ms; a fresh browser
  // smooth-scroll each time restarts the animation and looks stuttery. Drive
  // our own eased follow instead: each frame glides a step toward the target.
  let scrollAnim = null;
  let followPaused = false; // user scrolled away from the bottom: stop tugging
  function glideToBottom() {
    const thread = $('#thread');
    if (followPaused) { if (scrollAnim) { cancelAnimationFrame(scrollAnim); scrollAnim = null; } return; }
    if (scrollAnim) cancelAnimationFrame(scrollAnim);
    const step = () => {
      if (followPaused) { scrollAnim = null; return; }
      const target = thread.scrollHeight;
      const distance = target - thread.scrollTop;
      if (Math.abs(distance) < 2) { thread.scrollTop = target; scrollAnim = null; return; }
      thread.scrollTop += distance * 0.22;
      scrollAnim = requestAnimationFrame(step);
    };
    scrollAnim = requestAnimationFrame(step);
  }

  function scrollToBottom(force = false) {
    const thread = $('#thread');
    const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 180;
    if (force) {
      followPaused = false;
      if (scrollAnim) { cancelAnimationFrame(scrollAnim); scrollAnim = null; }
      thread.scrollTo({ top: thread.scrollHeight, behavior: 'auto' });
      return;
    }
    if (followPaused || !near) return;
    glideToBottom();
  }

  function bindScrollGuard() {
    const thread = $('#thread');
    thread.addEventListener('scroll', () => {
      if (scrollAnim) return; // our own glide: not user intent
      const distance = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
      if (distance > 180) followPaused = true;
      else if (distance < 60) followPaused = false;
    });
  }

  function renderMessages() {
    const box = $('#messages');
    box.innerHTML = '';
    // While a run streams, the server has already persisted its (partial)
    // assistant message; the live bubble shows it, so drop the stale copy.
    const run = state.activeId ? state.runs.get(state.activeId) : null;
    const liveId = run?.assistantMessageId;
    const msgs = liveId ? state.messages.filter((m) => m.id !== liveId) : state.messages;
    const empty = !msgs.length;
    $('#thread').classList.toggle('is-empty', empty);
    $('#emptyState').hidden = !empty;
    $('#emptySpacer').hidden = !empty;
    for (const msg of msgs) box.appendChild(makeMessageEl(msg, msg.role));
    // Late-loading images grow the thread; keep the view pinned to the bottom.
    box.querySelectorAll('img').forEach((img) => {
      if (!img.complete) img.addEventListener('load', () => scrollToBottom(), { once: true });
    });
    scrollToBottom(true);
  }

  /* ---------------- sidebar ---------------- */
  function renderSessions() {
    const query = $('#searchInput').value.trim().toLowerCase();
    const list = state.sessions.filter((s) => !query || (s.title || '').toLowerCase().includes(query));
    const normal = [], workspace = [];
    for (const s of list) {
      const isWorkspace = s.kind === 'workspace' || (state.defaultCwd && s.cwd && s.cwd !== state.defaultCwd);
      (isWorkspace ? workspace : normal).push(s);
    }
    const makeRow = (s) => {
      const row = document.createElement('div');
      row.className = `session-item${s.id === state.activeId ? ' active' : ''}${state.runs.has(s.id) ? ' running' : ''}`;
      row.innerHTML = `<svg class="item-icon" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span class="item-text">${esc(s.title || '新对话')}</span>
        ${state.runs.has(s.id) ? '<span class="run-badge">运行中</span>'
          : state.results.get(s.id) === 'ok' ? '<span class="run-badge done">已完成</span>'
          : state.results.get(s.id) === 'error' ? '<span class="run-badge error">失败</span>' : ''}
        <button class="rename" title="重命名会话"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/></svg></button>
        <button class="del" title="删除会话"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
      row.addEventListener('click', () => loadSession(s.id));
      row.querySelector('.rename').addEventListener('click', (event) => {
        event.stopPropagation();
        startRename(row, s);
      });
      row.querySelector('.del').addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!confirm(`删除会话「${s.title}」？`)) return;
        try {
          await api(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
          state.runs.delete(s.id);
          state.sessions = state.sessions.filter((x) => x.id !== s.id);
          if (state.activeId === s.id) {
            state.activeId = null;
            if (state.sessions.length) await loadSession(state.sessions[0].id);
            else await createSession();
          } else renderSessions();
        } catch (error) { toast(error.message, true); }
      });
      return row;
    };

    const normalEl = $('#listNormal');
    normalEl.innerHTML = normal.length ? '' : '<div class="group-empty">暂无普通会话</div>';
    for (const s of normal) normalEl.appendChild(makeRow(s));

    // Workspace sessions are grouped by the directory they were created with.
    const wsEl = $('#listWorkspace');
    const groups = new Map();
    for (const s of workspace) {
      const key = s.cwd || state.defaultCwd || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    wsEl.innerHTML = groups.size ? '' : '<div class="group-empty">暂无工作区项目</div>';
    for (const [dir, items] of groups) {
      const collapsed = state.wsCollapsed.has(dir);
      const head = document.createElement('button');
      head.className = `ws-head${collapsed ? ' collapsed' : ''}`;
      head.title = dir;
      head.innerHTML = `<svg class="caret" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
        <svg class="ws-icon" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M8 6V4h8v2"/></svg><span>${esc(basename(dir) || dir)}</span>`;
      head.addEventListener('click', () => {
        if (state.wsCollapsed.has(dir)) state.wsCollapsed.delete(dir);
        else state.wsCollapsed.add(dir);
        renderSessions();
      });
      wsEl.appendChild(head);
      if (!collapsed) for (const s of items) wsEl.appendChild(makeRow(s));
    }
    $('#countNormal').textContent = `(${normal.length})`;
    $('#countWorkspace').textContent = `(${workspace.length})`;
  }

  function startRename(row, session) {
    const textEl = row.querySelector('.item-text');
    if (!textEl || row.querySelector('.rename-input')) return;
    const input = document.createElement('input');
    input.className = 'rename-input';
    input.value = session.title || '';
    input.maxLength = 60;
    textEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = async () => {
      const title = input.value.trim();
      input.replaceWith(textEl);
      if (!title || title === session.title) return renderSessions();
      try {
        await api(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'PATCH', body: { title } });
        session.title = title;
        renderSessions();
        if (session.id === state.activeId) updateHeader();
      } catch (error) { toast(error.message, true); }
    };
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.stopPropagation(); input.replaceWith(textEl); }
    });
    input.addEventListener('blur', commit);
  }

  function updateHeader() {
    const s = state.sessions.find((x) => x.id === state.activeId);
    $('#convTitle').textContent = s?.title || '新对话';
    const kind = (s?.kind === 'workspace') ? '工作区会话' : '普通会话';
    $('#convSub').textContent = `AtomCode Agent · ${kind}`;
    $('#cwdLabel').textContent = state.cwd ? basename(state.cwd) : '选择仓库';
    const started = state.activeId && state.messages.length > 0;
    $('#cwdBtn').classList.toggle('disabled', started);
    $('#cwdBtn').title = started ? '会话已开始，工作目录不可更改' : '选择工作目录';
    $('#modelLabel').textContent = state.model
      ? (state.models.find((m) => m.id === state.model)?.name || state.model) : '默认模型';
    refreshBranch();
  }

  async function refreshBranch() {
    const chip = $('#branchChip');
    const stamp = state.cwd;
    if (!stamp || !state.activeId) { chip.hidden = true; return; }
    try {
      const data = await api(`/api/branch?cwd=${encodeURIComponent(stamp)}`);
      // A newer load may have changed the cwd while this request was in flight.
      if (state.cwd !== stamp) return;
      $('#branchLabel').textContent = data.branch || '';
      chip.hidden = !data.branch;
    } catch (_) { chip.hidden = true; }
  }

  async function loadSession(id) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return;
    // Stash the outgoing session's composer state, then restore this one's.
    if (state.activeId) {
      state.drafts[state.activeId] = {
        text: $('#input').value,
        attachments: state.attachments,
      };
    }
    state.activeId = id;
    state.results.delete(id);
    state.model = s.model || state.defaultModel;
    state.cwd = s.cwd || state.defaultCwd;
    state.skipPermissions = s.skipPermissions !== false;
    state.noTools = !!s.noTools;
    savePrefs();
    const draft = state.drafts[id] || { text: '', attachments: [] };
    $('#input').value = draft.text;
    autoHeight($('#input'));
    hideAutocomplete();
    state.attachments = draft.attachments || [];
    renderChips();
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(id)}/messages`);
      state.messages = data.messages;
    } catch (error) { state.messages = []; toast(error.message, true); }
    renderSessions();
    updateHeader();
    renderMessages();
    attachLive(id);
    // Jump to the latest message only after the live bubble is mounted.
    scrollToBottom(true);
    syncComposerState();
    refreshUsage();
    $('#input').focus();
  }

  async function createSession(overrides = {}) {
    // Reuse an existing empty "新对话" placeholder instead of piling up blanks.
    // A requested cwd (workspace creation) must match, else create fresh.
    const empty = state.sessions.find((s) => !s.messageCount && !state.runs.has(s.id)
      && (!overrides.cwd || s.cwd === overrides.cwd));
    if (empty) return loadSession(empty.id).then(() => { closePopover(); return empty; });
    try {
      const data = await api('/api/sessions', {
        method: 'POST',
        body: {
          cwd: overrides.cwd || state.cwd || state.defaultCwd,
          model: state.model || state.defaultModel,
          skipPermissions: state.skipPermissions,
          noTools: state.noTools,
          kind: (overrides.cwd && overrides.cwd !== state.defaultCwd) ? 'workspace' : 'normal',
        },
      });
      state.sessions.unshift(data.session);
      await loadSession(data.session.id);
      closePopover();
      return data.session;
    } catch (error) { toast(error.message, true); return null; }
  }

  /* ---------------- streaming chat ---------------- */
  async function streamChat(payload, onEvent) {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try { onEvent(JSON.parse(line.slice(6))); } catch (_) { /* ignore */ }
        }
      }
    }
  }

  function syncComposerState() {
    const run = state.activeId ? state.runs.get(state.activeId) : null;
    $('#sendBtn').classList.toggle('sending', !!run);
    $('#sendBtn').title = run ? '停止生成' : '发送 (Enter)';
    $('#sendBtn').disabled = false;
    $('#runTimer').textContent = run
      ? `运行中 ${fmtDuration(Date.now() - run.startedAt)}` : '';
  }

  function renderLive(sessionId, force = false) {
    const live = state.runs.get(sessionId);
    if (!live || !live.el) return;
    if (sessionId !== state.activeId || !live.el.isConnected) return;
    const now = performance.now();
    if (!force && now - (live.lastRender || 0) < 70) return;
    live.lastRender = now;
    const body = live.el.querySelector('.assistant-body');
    if (!body) return;
    const opened = openStates(body);
    // Anchor the viewport: whatever height the reasoning strip gains or loses
    // during this re-render, compensate the scroll so visible text stays put.
    const thread = $('#thread');
    const prevTop = thread.scrollTop;
    const prevHeight = thread.scrollHeight;
    body.innerHTML = assistantHtml(live.msg);
    body.querySelectorAll('details[data-tool]').forEach((d) => { if (opened.has(d.dataset.tool)) d.open = true; });
    const delta = thread.scrollHeight - prevHeight;
    if (delta) thread.scrollTop = prevTop + delta;
    scrollToBottom();
  }

  // Reattach the in-flight streaming bubble after switching back to its session.
  function attachLive(id) {
    const run = state.runs.get(id);
    if (!run || !run.msg) return;
    if (run.el?.isConnected) run.el.remove();
    run.el = makeMessageEl(run.msg, 'assistant');
    $('#messages').appendChild(run.el);
    renderLive(id, true);
  }

  async function send() {
    if (state.runs.has(state.activeId)) return stopRun();
    const input = $('#input');
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    if (!state.activeId) await createSession();
    if (!state.activeId) return;

    // @-mentions are also injected as real file references for the CLI.
    const mentions = [...text.matchAll(/@([^\s@]+)/g)].map((m) => m[1]);
    const attachments = [...state.attachments];
    for (const mention of mentions) {
      if (!attachments.some((a) => a.path === mention)) attachments.push({ path: mention, name: basename(mention) });
    }

    input.value = '';
    autoHeight(input);
    hideAutocomplete();
    state.attachments = [];
    renderChips();
    const sessionId = state.activeId;
    delete state.drafts[sessionId];

    const userMsg = { id: `local_${Date.now()}`, role: 'user', content: text, attachments };
    state.messages.push(userMsg);
    $('#thread').classList.remove('is-empty');
    $('#emptyState').hidden = true;
    $('#emptySpacer').hidden = true;
    const userEl = makeMessageEl(userMsg, 'user');
    $('#messages').appendChild(userEl);

    const liveMsg = { id: `live_${Date.now()}`, role: 'assistant', content: '', reasoning: '', tools: [], usage: null, stats: null, streaming: true, model: state.model };
    const liveEl = makeMessageEl(liveMsg, 'assistant');
    $('#messages').appendChild(liveEl);
    const run = { el: liveEl, msg: liveMsg, sessionId, lastRender: 0, startedAt: Date.now() };
    state.runs.set(sessionId, run);
    state.results.delete(sessionId);
    scrollToBottom(true);
    syncComposerState();
    renderSessions();

    const onEvent = (event) => {
      const msg = run.msg;
      if (!msg) return;
      switch (event.type) {
        case 'run.start':
          msg.model = event.model || msg.model;
          if (event.assistantMessageId) run.assistantMessageId = event.assistantMessageId;
          break;
        case 'message.delta': case 'assistant.delta': case 'content.delta':
          msg.content += String(event.text || ''); renderLive(sessionId); break;
        case 'reasoning.delta': case 'thinking.delta':
          msg.reasoning += String(event.text || ''); renderLive(sessionId); break;
        case 'tool.started': case 'tool.call':
          msg.tools.push({ id: event.id, name: event.name || 'tool', arguments: typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.arguments || {}), content: '', is_error: false });
          renderLive(sessionId, true); break;
        case 'tool.completed': case 'tool.result': {
          let tool = msg.tools.find((t) => t.id === event.id);
          if (!tool) { tool = { id: event.id, name: event.name || 'tool', arguments: '', content: '', is_error: false }; msg.tools.push(tool); }
          tool.content = String(event.content ?? event.output ?? '');
          tool.is_error = !!event.is_error;
          renderLive(sessionId, true); break;
        }
        case 'usage': msg.usage = { ...(msg.usage || {}), ...event }; break;
        case 'turn.completed': msg.stats = event; break;
        case 'error':
          msg.error = event.message || 'CLI 运行错误';
          renderLive(sessionId, true);
          toast(msg.error.slice(0, 120), true);
          break;
        case 'session.title': {
          const s = state.sessions.find((x) => x.id === event.sessionId);
          if (s) { s.title = event.title; renderSessions(); updateHeader(); }
          break;
        }
        case 'session.linked': {
          const s = state.sessions.find((x) => x.id === sessionId);
          if (s) s.cliSessionId = event.cliSessionId;
          break;
        }
        case 'stderr':
          if (/error|失败|错误/i.test(event.text)) toast(event.text.slice(0, 120), true);
          break;
        case 'run.done':
          msg.streaming = false;
          msg.interrupted = !!event.killed || (event.code !== 0 && event.code !== null);
          msg.error = event.error || (event.code && event.code !== 0 && event.killed !== true ? `CLI 退出码 ${event.code}` : null);
          if (event.durationMs) msg.stats = { ...(msg.stats || {}), duration_ms: event.durationMs };
          renderLive(sessionId, true);
          state.runs.delete(sessionId);
          state.results.set(sessionId, msg.error || msg.interrupted ? 'error' : 'ok');
          syncComposerState();
          renderSessions();
          // Refresh authoritative history (with real ids) and context usage.
          refreshMessages(sessionId);
          if (sessionId === state.activeId) refreshUsage();
          break;
        default: break;
      }
    };

    try {
      await streamChat({
        sessionId, message: text, cwd: state.cwd, model: state.model,
        skipPermissions: state.skipPermissions, noTools: state.noTools, attachments,
      }, onEvent);
    } catch (error) {
      if (state.runs.has(sessionId)) {
        const failed = state.runs.get(sessionId);
        failed.msg.streaming = false;
        failed.msg.error = error.message;
        renderLive(sessionId, true);
        state.runs.delete(sessionId);
        state.results.set(sessionId, 'error');
      }
      syncComposerState();
      renderSessions();
      toast(error.message, true);
      refreshMessages(sessionId);
    }
  }

  async function refreshMessages(sessionId) {
    if (state.activeId !== sessionId) return;
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
      state.messages = data.messages;
      renderMessages();
    } catch (_) { /* keep optimistic view */ }
  }

  async function stopRun() {
    if (!state.activeId) return;
    try { await api('/api/stop', { method: 'POST', body: { sessionId: state.activeId } }); }
    catch (error) { toast(error.message, true); }
  }

  /* ---------------- /usage strip ---------------- */
  function setBar(el, percent, kind) {
    if (!el) return;
    const value = Math.max(0, Math.min(100, Number(percent) || 0));
    el.style.width = `${value}%`;
    el.className = value >= 85 ? 'danger' : value >= 60 ? 'warn' : (kind === 'ok' ? 'ok' : '');
  }

  function renderUsage(data) {
    const bar = $('#usageBar');
    const summary = data.summary;
    if (!summary || !summary.available) {
      bar.classList.add('error');
      $('#usageWindowValue').textContent = '--';
      $('#usageResetValue').textContent = '--';
      $('#usagePlanValue').textContent = '--';
      $('#usageContextValue').textContent = '--';
      $('#usageState').textContent = data.error ? `额度不可用：${data.error}` : '未开通 CodingPlan';
      $('#usageWindow').title = data.error || '无法读取额度';
      return;
    }
    bar.classList.remove('error');
    const win = summary.primary_window || (summary.windows || [])[0] || {};
    const plan = summary.plan || {};
    const used = Number(win.used || 0);
    const limit = Number(win.limit || 0);
    const remaining = Number(win.remaining || 0);
    const percent = Number(win.usage_percent || (limit ? (used / limit) * 100 : 0));

    $('#usageWindowValue').textContent = limit ? `${used}/${limit}` : '--';
    setBar($('#usageWindowBar'), percent, 'accent');
    $('#usageWindow').title = `5 小时窗口：已用 ${used}/${limit} 次，剩余 ${remaining} 次（${percent.toFixed(0)}%）。${win.reset_label || ''}`;

    const reset = win.next_reset_display || (win.next_reset_at ? String(win.next_reset_at).slice(11, 16) : '--');
    const seconds = Number(win.seconds_until_reset || 0);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    $('#usageResetValue').textContent = reset || '--';
    $('#usageReset').title = `${win.next_reset_at || ''} · ${seconds > 0 ? `约 ${hours} 小时 ${minutes} 分后重置` : '即将重置'}`;

    $('#usagePlanValue').textContent = plan.remaining_days != null ? `剩 ${plan.remaining_days} 天` : '--';
    $('#usagePlan').title = `${plan.name || 'CodingPlan'} · ${plan.claimed_at || ''} 至 ${plan.expires_at || ''} · 套餐剩余 ${plan.remaining_days} 天 · 当前窗口剩 ${remaining} 次`;

    const context = data.context || {};
    $('#usageContextValue').textContent = context.percent != null ? `${context.percent}%` : '--';
    setBar($('#usageContextBar'), context.percent || 0, 'ok');
    $('#usageContext').title = context.limit
      ? `当前会话上下文 ${Number(context.used).toLocaleString()} / ${Number(context.limit).toLocaleString()} tokens（${context.percent}%）· 模型 ${context.model}`
      : '当前会话暂无 token 统计';
    $('#usageState').textContent = '';
  }

  async function refreshUsage(force = false) {
    const button = $('#usageRefresh');
    if (force) button.classList.add('spin');
    try {
      const data = await api(`/api/usage?sessionId=${encodeURIComponent(state.activeId || '')}${force ? '&refresh=1' : ''}`);
      renderUsage(data);
    } catch (error) {
      $('#usageBar').classList.add('error');
      $('#usageState').textContent = `额度读取失败：${error.message}`;
    } finally {
      if (force) setTimeout(() => button.classList.remove('spin'), 700);
    }
  }

  /* ---------------- attachments ---------------- */
  function renderChips() {
    const box = $('#attachChips');
    box.hidden = !state.attachments.length;
    box.innerHTML = state.attachments.map((a, i) =>
      `<span class="chip"><span class="chip-name" data-view="${esc(a.path)}" title="点击预览">${esc(a.name || basename(a.path))}</span><button data-remove="${i}" title="移除"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span>`).join('');
  }
  async function handleFiles(files) {
    for (const file of files) {
      try {
        const contentBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const data = await api('/api/attach', {
          method: 'POST',
          body: { cwd: state.cwd, name: file.name, contentBase64 },
        });
        state.attachments.push(data.attachment);
        renderChips();
      } catch (error) { toast(`${file.name}: ${error.message}`, true); }
    }
    $('#fileInput').value = '';
  }

  /* ---------------- autocomplete ---------------- */
  function acMatch() {
    const input = $('#input');
    const before = input.value.slice(0, input.selectionStart);
    return before.match(/(^|\s)([/@])([^\s/@]*)$/);
  }
  function hideAutocomplete() {
    state.ac.open = false;
    $('#autocomplete').hidden = true;
  }
  function showAutocomplete(items, kind, match) {
    state.ac = { open: true, items, index: 0, kind, match };
    const box = $('#autocomplete');
    const rect = $('#composer').getBoundingClientRect();
    box.style.left = `${rect.left + 10}px`;
    box.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    box.style.top = 'auto';
    box.style.minWidth = `${Math.min(rect.width - 20, 460)}px`;
    box.hidden = false;
    renderAutocomplete();
  }
  function renderAutocomplete() {
    const box = $('#autocomplete');
    const { items, index, kind } = state.ac;
    if (!items.length) {
      box.innerHTML = `<div class="pop-empty">${kind === '/' ? '没有找到技能，直接输入 / 命令即可' : '没有匹配的文件'}</div>`;
      return;
    }
    box.innerHTML = `<div class="pop-head">${kind === '/' ? '技能 / 命令' : '引用文件'}</div>` + items.slice(0, 12).map((item, i) =>
      `<div class="ac-item${i === index ? ' hl' : ''}" data-index="${i}">
        <span class="ac-name">${esc(kind + item.name)}</span>
        <span class="ac-desc">${esc(item.description || item.path || '')}</span>
      </div>`).join('');
  }
  function applyAutocomplete(index) {
    const item = state.ac.items[index];
    if (!item) return;
    const input = $('#input');
    const match = state.ac.match;
    const cursor = input.selectionStart;
    const before = input.value.slice(0, cursor);
    const token = match[2] + match[3];
    const start = before.length - token.length;
    const replacement = `${state.ac.kind}${item.name} `;
    input.value = input.value.slice(0, start) + replacement + input.value.slice(cursor);
    const pos = start + replacement.length;
    input.setSelectionRange(pos, pos);
    if (state.ac.kind === '@' && !state.attachments.some((a) => a.path === item.path)) {
      state.attachments.push({ path: item.path, name: basename(item.path) });
      renderChips();
    }
    hideAutocomplete();
    autoHeight(input);
    input.focus();
  }
  async function updateAutocomplete() {
    const match = acMatch();
    if (!match) return hideAutocomplete();
    const kind = match[2];
    const query = match[3].toLowerCase();
    if (kind === '/') {
      if (!state.skills || state.skillsCwd !== state.cwd) {
        try {
          const data = await api(`/api/skills?cwd=${encodeURIComponent(state.cwd)}`);
          state.skills = data.skills; state.skillsCwd = state.cwd;
        } catch (_) { state.skills = []; }
      }
      const items = state.skills.filter((s) => s.name.toLowerCase().includes(query)).map((s) => ({
        name: s.name, description: s.description, path: '',
      }));
      showAutocomplete(items, kind, match);
    } else {
      const key = `${state.cwd}|${query}`;
      let files = state.fileCache.get(key);
      if (!files) {
        try {
          const data = await api(`/api/files?cwd=${encodeURIComponent(state.cwd)}&q=${encodeURIComponent(query)}`);
          files = data.files.map((f) => ({ name: f, path: f, description: '' }));
          state.fileCache.set(key, files);
        } catch (_) { files = []; }
      }
      showAutocomplete(files.slice(0, 12), kind, match);
    }
  }

  /* ---------------- popovers ---------------- */
  function closePopover() { $('#popover').hidden = true; }
  function openPopover(anchor, html, onClick) {
    const box = $('#popover');
    box.innerHTML = html;
    const rect = anchor.getBoundingClientRect();
    box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 240))}px`;
    box.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    box.style.top = 'auto';
    box.hidden = false;
    box.onclick = (event) => {
      const item = event.target.closest('[data-action]');
      if (!item) return;
      closePopover();
      onClick(item.dataset.action, item.dataset.value || '');
    };
  }

  function modelPopover() {
    const items = state.models.length ? state.models : [{ id: state.defaultModel, name: state.defaultModel }];
    openPopover($('#modelBtn'),
      `<div class="pop-head">选择模型（来自 ~/.atomcode/config.toml）</div>` +
      items.map((m) => `<button class="pop-item${m.name === state.model ? ' active' : ''}" data-action="model" data-value="${esc(m.name)}">
        <svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg><span>${esc(m.name)}</span>
        <span class="pop-sub">${m.contextWindow ? `${Math.round(m.contextWindow / 1024)}K` : ''}</span></button>`).join(''),
      (action, value) => {
        state.model = value; savePrefs(); updateHeader();
        if (state.activeId) api(`/api/sessions/${encodeURIComponent(state.activeId)}`, { method: 'PATCH', body: { model: value } }).catch(() => {});
        toast(`模型已切换为 ${value}`);
      });
  }

  function infoPopover() {
    const s = state.sessions.find((x) => x.id === state.activeId);
    openPopover($('#resetBtn'),
      `<div class="pop-head">会话运行信息</div>
       <div class="pop-item"><span>CLI 会话</span><span class="pop-sub">${esc(s?.cliSessionId || '尚未建立')}</span></div>
       <div class="pop-item"><span>模型</span><span class="pop-sub">${esc(state.model || '默认')}</span></div>
       <div class="pop-item"><span>工作目录</span><span class="pop-sub">${esc(basename(state.cwd))}</span></div>
       <div class="pop-item"><span>消息数</span><span class="pop-sub">${state.messages.length}</span></div>
       <div class="pop-sep"></div>
       <button class="pop-item" data-action="reset"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>重置 CLI 上下文（保留消息）</button>
       <button class="pop-item" data-action="settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M4 12h2M18 12h2M12 4v2M12 18v2"/></svg>打开设置</button>`,
      async (action) => {
        if (action === 'settings') return openSettings();
        if (action === 'reset') {
          try {
            await api(`/api/sessions/${encodeURIComponent(state.activeId)}/reset-context`, { method: 'POST', body: {} });
            const s = state.sessions.find((x) => x.id === state.activeId);
            if (s) s.cliSessionId = null;
            toast('上下文已重置，下一条消息将开启新的 CLI 会话');
          } catch (error) { toast(error.message, true); }
        }
      });
  }

  function plusPopover() {
    openPopover($('#plusBtn'),
      `<button class="pop-item" data-action="attach"><svg viewBox="0 0 24 24"><path d="M21.4 11.6l-8.9 8.9a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>附加文件</button>
       <button class="pop-item" data-action="cwd"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18"/></svg>选择工作目录</button>
       <button class="pop-item" data-action="settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M4 12h2M18 12h2M12 4v2M12 18v2"/></svg>设置</button>
       <button class="pop-item" data-action="clear"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>清空当前对话</button>
       <div class="pop-sep"></div>
       <div class="pop-head">CLI ${esc(state.version || '')}</div>`,
      async (action) => {
        if (action === 'attach') return $('#fileInput').click();
        if (action === 'cwd') return openDirectory();
        if (action === 'settings') return openSettings();
        if (action === 'clear') {
          if (!confirm('清空当前对话的全部消息？')) return;
          try {
            await api(`/api/sessions/${encodeURIComponent(state.activeId)}/clear`, { method: 'POST', body: {} });
            state.messages = []; renderMessages();
            const s = state.sessions.find((x) => x.id === state.activeId);
            if (s) { s.title = '新对话'; s.messageCount = 0; s.cliSessionId = null; }
            renderSessions(); updateHeader();
          } catch (error) { toast(error.message, true); }
        }
      });
  }

  /* ---------------- modal ---------------- */
  function showModal(title, bodyHtml, footHtml, onMount) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHtml;
    $('#modalFoot').innerHTML = footHtml;
    $('#modal').hidden = false;
    if (onMount) onMount($('#modalBody'), $('#modalFoot'));
  }
  function closeModal() { $('#modal').hidden = true; }

  function switchRow(key, title, desc, on) {
    return `<div class="switch-row"><div><div class="sr-title">${esc(title)}</div><div class="sr-desc">${esc(desc)}</div></div>
      <button class="switch${on ? ' on' : ''}" data-switch="${key}" aria-label="${esc(title)}"></button></div>`;
  }

  function openSettings() {
    const modelOptions = (state.models.length ? state.models : [{ id: state.defaultModel, name: state.defaultModel }])
      .map((m) => `<option value="${esc(m.name)}"${m.name === state.model ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
    const body = `
      <div class="form-row"><label>CLI 可执行文件</label><div class="info-grid" style="grid-template-columns:90px 1fr">
        <span class="k">路径</span><span class="v">${esc(window.__cliPath || '')}</span>
        <span class="k">版本</span><span class="v">${esc(state.version || '未知')}</span>
        <span class="k">登录</span><span class="v">${esc(state.status?.user || '未登录')}</span>
      </div></div>
      <div class="form-row"><label>模型</label><select class="field" id="setModel">${modelOptions}</select>
        <span class="help">实际调用：--model &lt;模型 ID&gt;，来自 CLI 配置文件</span></div>
      <div class="form-row"><label>工作目录</label><input class="field" id="setCwd" value="${esc(state.cwd)}" />
        <span class="help">实际调用：-C &lt;目录&gt;，工具读写都限定在此目录</span></div>
      ${switchRow('skip', '自动批准工具调用', '等价于 -y / --dangerously-skip-permissions，跳过所有权限确认', state.skipPermissions)}
      ${switchRow('noTools', '禁用工具', '等价于 --no-tools，仅做纯文本问答', state.noTools)}
      ${switchRow('reason', '显示思考过程', '在回复中展示模型的推理片段（reasoning.delta）', state.showReasoning)}
      ${switchRow('theme', '深色主题', '切换界面配色', state.theme === 'dark')}
      <div class="form-row" style="margin-top:14px"><label>会话维护</label>
        <button class="btn danger" id="setClear">清空当前对话</button>
        <button class="btn" id="setReset" style="margin-left:8px">重置 CLI 上下文</button>
      </div>`;
    showModal('设置', body,
      `<button class="btn" data-close>取消</button><button class="btn primary" id="setSave">保存</button>`,
      (root, foot) => {
        root.querySelectorAll('[data-switch]').forEach((btn) => {
          btn.addEventListener('click', () => {
            btn.classList.toggle('on');
            const on = btn.classList.contains('on');
            const key = btn.dataset.switch;
            if (key === 'skip') state.skipPermissions = on;
            if (key === 'noTools') state.noTools = on;
            if (key === 'reason') state.showReasoning = on;
            if (key === 'theme') { state.theme = on ? 'dark' : 'light'; applyTheme(); }
          });
        });
        root.querySelector('#setClear').addEventListener('click', async () => {
          if (!confirm('清空当前对话的全部消息？')) return;
          await api(`/api/sessions/${encodeURIComponent(state.activeId)}/clear`, { method: 'POST', body: {} });
          state.messages = []; renderMessages(); closeModal(); toast('对话已清空');
        });
        root.querySelector('#setReset').addEventListener('click', async () => {
          await api(`/api/sessions/${encodeURIComponent(state.activeId)}/reset-context`, { method: 'POST', body: {} });
          closeModal(); toast('上下文已重置');
        });
        foot.querySelector('[data-close]').addEventListener('click', closeModal);
        foot.querySelector('#setSave').addEventListener('click', async () => {
          const cwd = root.querySelector('#setCwd').value.trim();
          state.model = root.querySelector('#setModel').value;
          if (cwd && cwd !== state.cwd) {
            try {
              const data = await api(`/api/dirs?q=${encodeURIComponent(cwd)}`);
              if (!data.suggestions.some((d) => d.toLowerCase() === cwd.toLowerCase())) {
                toast('该目录不存在，请检查路径', true); return;
              }
              state.cwd = cwd;
            } catch (error) { toast(error.message, true); return; }
          }
          savePrefs();
          if (state.activeId) {
            try {
              // cwd is fixed at session creation and cannot be changed here.
              await api(`/api/sessions/${encodeURIComponent(state.activeId)}`, {
                method: 'PATCH', body: { model: state.model, skipPermissions: state.skipPermissions, noTools: state.noTools },
              });
              const s = state.sessions.find((x) => x.id === state.activeId);
              if (s) Object.assign(s, { model: state.model, skipPermissions: state.skipPermissions, noTools: state.noTools });
            } catch (error) { toast(error.message, true); }
          }
          updateHeader(); renderSessions(); renderMessages();
          closeModal(); toast('设置已保存');
        });
      });
  }

  function openDirectory(prefill) {
    const renderForm = (fillValue) => {
      showModal('选择工作目录',
        `<div class="form-row"><label>仓库 / 项目路径</label>
          <div style="display:flex;gap:8px">
            <input class="field" id="dirInput" value="${esc(fillValue !== undefined ? fillValue : state.cwd)}" placeholder="例如 D:\\www\\my-project" style="flex:1" spellcheck="false" />
            <button class="btn" id="dirBrowse" type="button">浏览</button>
          </div>
          <span class="help">工作区在会话创建后不可更改：选择目录将新建一个绑定该目录的会话，文件与命令工具都作用于该目录。</span></div>
         <div class="form-row"><label>常用目录</label><div class="dir-suggestions" id="dirSuggestions"></div></div>`,
        `<button class="btn" data-close>取消</button><button class="btn primary" id="dirSave">使用此目录</button>`,
        (root, foot) => {
          const input = root.querySelector('#dirInput');
          const list = root.querySelector('#dirSuggestions');
          const fill = (items) => {
            list.innerHTML = items.length ? items.map((d) => `<button data-dir="${esc(d)}">${esc(d)}</button>`).join('')
              : '<div class="pop-empty">没有匹配的目录</div>';
          };
          fill([state.cwd, ...state.recentDirs].filter(Boolean));
          list.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-dir]');
            if (btn) input.value = btn.dataset.dir;
          });
          let timer;
          input.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(async () => {
              try {
                const data = await api(`/api/dirs?cwd=${encodeURIComponent(state.cwd)}&q=${encodeURIComponent(input.value.trim())}`);
                fill(data.suggestions);
              } catch (_) { /* ignore */ }
            }, 250);
          });
          root.querySelector('#dirBrowse').addEventListener('click', async () => {
            const btn = root.querySelector('#dirBrowse');
            btn.disabled = true;
            try {
              const data = await api('/api/pick-dir', { method: 'POST', body: { initial: input.value.trim() } });
              if (data.path) input.value = data.path;
              else if (data.error) toast(`选择文件夹失败：${data.error.split('\n').pop().slice(0, 120)}`, true);
            } catch (error) { toast(error.message, true); }
            btn.disabled = false;
          });
          foot.querySelector('[data-close]').addEventListener('click', closeModal);
          foot.querySelector('#dirSave').addEventListener('click', async () => {
            const value = input.value.trim();
            if (!value) return;
            try {
              const data = await api(`/api/dirs?q=${encodeURIComponent(value)}`);
              const hit = data.suggestions.find((d) => d.toLowerCase() === value.toLowerCase());
              if (!hit) { toast('目录不存在，请检查路径', true); return; }
              state.cwd = hit;
              savePrefs();
              // Workspace is fixed at session creation: picking a directory opens a new session in it.
              closeModal();
              await createSession({ cwd: hit });
              toast(`已在新工作区新建会话：${hit}`);
            } catch (error) { toast(error.message, true); }
          });
        });
    };
    renderForm(prefill);
  }

  /* ---------------- misc UI ---------------- */
  function applyTheme() {
    document.documentElement.dataset.theme = state.theme;
  }
  // composer 卡片固定 130px：padding 12 + textarea 78 + toolbar 30 + padding 8 + border 2
  const MIN_INPUT_H = 78;
  function autoHeight(el) {
    el.style.height = 'auto';
    el.style.height = `${Math.max(MIN_INPUT_H, Math.min(el.scrollHeight, 200))}px`;
  }

  function bindEvents() {
    $('#sendBtn').addEventListener('click', () => send());
    $('#input').addEventListener('keydown', (event) => {
      if (state.ac.open) {
        if (event.key === 'ArrowDown') { event.preventDefault(); state.ac.index = Math.min(state.ac.index + 1, Math.min(state.ac.items.length - 1, 11)); renderAutocomplete(); return; }
        if (event.key === 'ArrowUp') { event.preventDefault(); state.ac.index = Math.max(state.ac.index - 1, 0); renderAutocomplete(); return; }
        if (event.key === 'Escape') { event.preventDefault(); hideAutocomplete(); return; }
        if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
          if (state.ac.items.length) { event.preventDefault(); applyAutocomplete(state.ac.index); return; }
        }
      }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
    });
    let acTimer;
    $('#input').addEventListener('input', (event) => {
      autoHeight(event.target);
      clearTimeout(acTimer);
      acTimer = setTimeout(updateAutocomplete, 160);
    });
    $('#input').addEventListener('blur', () => setTimeout(hideAutocomplete, 160));
    $('#input').addEventListener('paste', (event) => {
      const files = [...(event.clipboardData?.items || [])]
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter(Boolean)
        .map((file, i) => {
          const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
          const name = i === 0 ? `screenshot-${stamp}.${ext}` : `screenshot-${stamp}-${i + 1}.${ext}`;
          return new File([file], name, { type: file.type });
        });
      if (files.length) {
        event.preventDefault();
        handleFiles(files);
      }
    });
    $('#autocomplete').addEventListener('mousedown', (event) => {
      const item = event.target.closest('[data-index]');
      if (item) { event.preventDefault(); applyAutocomplete(Number(item.dataset.index)); }
    });

    $('#fileInput').addEventListener('change', (event) => handleFiles([...event.target.files]));
    $('#usageRefresh').addEventListener('click', () => refreshUsage(true));
    $('#attachChips').addEventListener('click', (event) => {
      const viewBtn = event.target.closest('.chip-name[data-view]');
      if (viewBtn) {
        openImageViewer(`/api/attachment?cwd=${encodeURIComponent(state.cwd)}&path=${encodeURIComponent(viewBtn.dataset.view)}`);
        return;
      }
      const btn = event.target.closest('[data-remove]');
      if (!btn) return;
      state.attachments.splice(Number(btn.dataset.remove), 1);
      renderChips();
    });

    $('#newChatTop').addEventListener('click', () => createSession());
    $('#searchInput').addEventListener('input', renderSessions);
    $$('.group-head').forEach((btn) => btn.addEventListener('click', () => btn.parentElement.classList.toggle('collapsed')));
    $('#modelBtn').addEventListener('click', (event) => { event.stopPropagation(); modelPopover(); });
    $('#cwdBtn').addEventListener('click', (event) => {
      event.stopPropagation();
      if (state.activeId && state.messages.length > 0) {
        toast('会话已开始，工作目录不可更改；请通过「选择仓库」新建会话', true);
        return;
      }
      openDirectory();
    });
    $('#plusBtn').addEventListener('click', (event) => { event.stopPropagation(); plusPopover(); });
    $('#resetBtn').addEventListener('click', (event) => { event.stopPropagation(); infoPopover(); });
    $('#sideSettingsBtn').addEventListener('click', openSettings);
    $('#themeBtn').addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme(); savePrefs();
    });
    $('#modalClose').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', (event) => { if (event.target.id === 'modal') closeModal(); });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('#popover') && !event.target.closest('#modelBtn') && !event.target.closest('#plusBtn')
        && !event.target.closest('#resetBtn')) closePopover();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { closeModal(); closePopover(); hideAutocomplete(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); createSession(); }
    });
    $('#thread').addEventListener('click', (event) => {
      const view = event.target.closest('[data-view]');
      if (view) {
        openImageViewer(`/api/attachment?cwd=${encodeURIComponent(state.cwd)}&path=${encodeURIComponent(view.dataset.view)}`);
        return;
      }
      const copy = event.target.closest('[data-copy]');
      if (copy) {
        const code = copy.parentElement.querySelector('code');
        navigator.clipboard.writeText(code ? code.textContent : '').then(() => toast('代码已复制'));
        return;
      }
      const copyMsg = event.target.closest('[data-copy-msg]');
      if (copyMsg) {
        const content = copyMsg.closest('.msg-body').querySelector('.assistant-content');
        navigator.clipboard.writeText(content ? content.innerText : '').then(() => toast('回复已复制'));
        return;
      }
      const copyUser = event.target.closest('[data-copy-user]');
      if (copyUser) {
        const msg = findMessage(copyUser.closest('.msg'));
        navigator.clipboard.writeText(msg ? msg.content : '').then(() => toast('消息已复制'));
        return;
      }
      const editUser = event.target.closest('[data-edit-user]');
      if (editUser) {
        const msg = findMessage(editUser.closest('.msg'));
        if (!msg) return;
        const input = $('#input');
        input.value = msg.content;
        autoHeight(input);
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        toast('内容已复制到输入框');
      }
    });
  }

  function findMessage(msgEl) {
    if (!msgEl) return null;
    const id = msgEl.dataset.id;
    if (!id) return null;
    return state.messages.find((m) => m.id === id) || null;
  }

  function openImageViewer(src) {
    const mask = document.createElement('div');
    mask.className = 'img-viewer';
    mask.innerHTML = `<img src="${esc(src)}" alt="图片预览" />
      <button class="img-viewer-close" aria-label="关闭预览"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    mask.addEventListener('click', (event) => {
      if (event.target === mask || event.target.closest('.img-viewer-close')) mask.remove();
    });
    document.body.appendChild(mask);
  }

  /* ---------------- boot ---------------- */
  async function boot() {
    const prefs = loadPrefs();
    Object.assign(state, {
      theme: prefs.theme || 'light',
      showReasoning: !!prefs.showReasoning,
      skipPermissions: prefs.skipPermissions !== false,
      noTools: !!prefs.noTools,
    });
    applyTheme();
    bindEvents();
    bindScrollGuard();
    autoHeight($('#input'));

    try {
      const data = await api('/api/bootstrap');
      window.__cliPath = data.cliPath;
      state.models = data.models || [];
      state.defaultModel = data.defaultModel || '';
      state.defaultCwd = data.defaultCwd;
      state.recentDirs = data.recentDirs || [];
      state.version = data.version;
      state.status = data.status;
      state.sessions = data.sessions || [];
      state.model = prefs.model || data.defaultModel;
      state.cwd = prefs.cwd || data.defaultCwd;
      const modelHit = state.models.find((m) => m.id === state.model || m.name === state.model);
      if (modelHit) state.model = modelHit.name;

      const ok = data.status?.loggedIn;
      $('#cliBadge').className = `cli-badge ${ok ? 'ok' : 'bad'}`;
      $('#cliBadgeText').textContent = ok ? 'CLI 已连接' : 'CLI 未登录';
      $('#sideStatusDot').className = `status-dot ${ok ? 'ok' : 'bad'}`;
      $('#sideStatusText').textContent = ok ? 'AtomCode CLI 已连接' : '请先运行 atomcode login';
      $('#emptySub').textContent = ok
        ? `已连接 AtomCode CLI · 工作目录 ${basename(state.cwd)} · 工具调用在本机执行`
        : 'CLI 未登录，请在终端运行 atomcode login 后刷新页面';
    } catch (error) {
      toast(`无法连接 Harness 服务：${error.message}`, true);
      state.defaultCwd = '.';
      state.cwd = '.';
    }

    // Restore the session the user was last viewing, if it still exists.
    const savedId = prefs.activeId;
    const saved = savedId && state.sessions.find((s) => s.id === savedId);
    if (!state.sessions.length) await createSession();
    else await loadSession(saved ? saved.id : state.sessions[0].id);
    renderSessions();
    updateHeader();
    // Keep the run timer / composer state fresh while sessions stream.
    setInterval(syncComposerState, 500);
    // Keep the 5h window / reset time / context figures fresh.
    setInterval(() => { if (!document.hidden) refreshUsage(); }, 60000);
  }

  boot();
})();
