(function () {
  const vscode = acquireVsCodeApi();
  const { escapeHtml, renderMarkdown, splitStreamingReply, summarizeArgs, diffViewHtml, rankFiles, mentionAt, highlightCode } = window.CortexRender;

  // ---------- icons ----------
  // Inline line icons (24px grid), so they take the theme's colour and look
  // the same on every platform — emoji do neither.
  const ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    'arrow-up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
    'arrow-down': '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2.5"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-9 9"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
    slash: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m14.5 8-5 8"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>',
    shield: '<path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.600-1 8-4 8-9V6z"/>',
    'shield-check': '<path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.600-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
    edit: '<path d="M12 20h9"/><path d="M16.500 3.500a2.100 2.100 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    retry: '<path d="M21 12a9 9 0 1 1-3-6.700L21 8"/><path d="M21 3v5h-5"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    'file-plus': '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 12v6M9 15h6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.500-3.500"/>',
    terminal: '<path d="m5 8 4 4-4 4M12 16h7"/><rect x="2" y="3" width="20" height="18" rx="3"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    move: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    git: '<circle cx="6" cy="6" r="2.500"/><circle cx="6" cy="18" r="2.500"/><circle cx="18" cy="9" r="2.500"/><path d="M6 8.500v7M18 11.500c0 3-3 4-6 4H8.500"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 0V7a3 3 0 0 0-3-3zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 0"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.500 6 1 1 2-2M3.500 12l1 1 2-2M3.500 18l1 1 2-2"/>',
    bug: '<rect x="8" y="7" width="8" height="12" rx="4"/><path d="M12 7V4M4 12h4M16 12h4M5 6l3 3M19 6l-3 3M5 19l3-2M19 19l-3-2"/>',
    users: '<circle cx="9" cy="8" r="3.500"/><path d="M2.500 20a6.500 6.500 0 0 1 13 0M16 4.500a3.500 3.500 0 0 1 0 7M18 14.500a6.500 6.500 0 0 1 3.500 5.500"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4"/>',
    wrench: '<path d="M14.500 6.500a4 4 0 0 0 5 5L11 20a2.100 2.100 0 0 1-3-3z"/><path d="M14.500 6.500 18 3"/>',
    paperclip: '<path d="m20 11-8.500 8.500a5 5 0 0 1-7-7L13 4a3.500 3.500 0 0 1 5 5l-8.500 8.500a2 2 0 0 1-3-3L14 7"/>',
    code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>',
    sparkle: '<path d="M12 3l1.800 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800z"/><path d="M19 15v4M17 17h4"/>',
    beaker: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M7.500 15h9"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.100-1.300l2-1.500-2-3.400-2.300 1a7 7 0 0 0-2.300-1.300L14 3h-4l-.300 2.500a7 7 0 0 0-2.300 1.300l-2.300-1-2 3.400 2 1.500a7 7 0 0 0 0 2.600l-2 1.500 2 3.400 2.300-1a7 7 0 0 0 2.300 1.300L10 21h4l.300-2.500a7 7 0 0 0 2.300-1.300l2.300 1 2-3.400-2-1.500A7 7 0 0 0 19 12z"/>',
    logs: '<path d="M4 6h16M4 12h10M4 18h13"/>',
    fork: '<circle cx="6" cy="5" r="2.500"/><circle cx="18" cy="5" r="2.500"/><circle cx="12" cy="19" r="2.500"/><path d="M6 7.500c0 4 6 3 6 9M18 7.500c0 4-6 3-6 9"/>',
  };
  function icon(name) {
    return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.wrench}</svg>`;
  }
  document.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
  });

  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const bannerEl = document.getElementById('banner');
  const modelBadge = document.getElementById('model-badge');
  const sessionStatsEl = document.getElementById('session-stats');
  const jumpBtn = document.getElementById('jump-bottom');
  const historyBtn = document.getElementById('history-btn');
  const settingsBtn = document.getElementById('settings-btn');
  const newChatBtn = document.getElementById('new-chat-btn');
  const historyPanel = document.getElementById('panel-history');
  const approvalsPanel = document.getElementById('panel-approvals');
  const memoryPanel = document.getElementById('panel-memory');
  const settingsPanel = document.getElementById('panel-settings');
  const drawer = document.getElementById('drawer');
  const scrim = document.getElementById('scrim');
  const composerEl = document.getElementById('composer');
  const contextRow = document.getElementById('context-row');
  const modePill = document.getElementById('mode-pill');
  const approvePill = document.getElementById('approve-pill');
  const meterEl = document.getElementById('context-meter');
  const sessionTitleEl = document.getElementById('session-title');
  const modelNameEl = modelBadge.querySelector('.model-name') || modelBadge;

  let config = {}; // the last 'config' the host sent
  let currentMode = 'act';

  let currentAssistantEl = null; // streaming bubble currently being written to
  let currentAssistantBuf = '';
  let busy = false;
  const sessionStats = { toolCalls: 0, totalMs: 0, promptTokens: 0, completionTokens: 0, lastPrompt: 0, contextBudget: 0, step: 0, files: 0 };
  const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  function renderSessionStats() {
    if (!sessionStatsEl) return;
    const tok = sessionStats.promptTokens + sessionStats.completionTokens;
    const cell = (k, v) => `<span>${k}<b>${v}</b></span>`;
    const cells = [cell('steps', `${sessionStats.step || 0}/${config.maxSteps || 50}`), cell('tokens', tok ? fmtTok(tok) : '—'), cell('files', sessionStats.files || 0)];
    if (sessionStats.totalMs) cells.push(cell('time', `${(sessionStats.totalMs / 1000).toFixed(1)}s`));
    sessionStatsEl.innerHTML = cells.join('');
    // Context use is the number that predicts trouble, so it gets a gauge of
    // its own in the header rather than a figure in the status bar.
    if (!meterEl) return;
    const used = sessionStats.lastPrompt;
    const budget = sessionStats.contextBudget;
    if (!used || !budget) {
      meterEl.classList.add('hidden');
      return;
    }
    const frac = Math.min(1, used / budget);
    meterEl.classList.remove('hidden');
    meterEl.classList.toggle('high', frac >= 0.7 && frac < 0.9);
    meterEl.classList.toggle('full', frac >= 0.9);
    const bars = meterEl.querySelectorAll('.meter-bars i');
    bars.forEach((el, i) => el.classList.toggle('on', frac * bars.length > i + 0.001));
    meterEl.querySelector('.meter-label').textContent = `${Math.round(frac * 100)}%`;
    meterEl.title = `Context: ${fmtTok(used)} of ${fmtTok(budget)} tokens used. Older conversation is summarized automatically when it fills up.`;
  }

  // Code blocks are highlighted after rendering, so the Markdown renderer
  // itself stays a plain, testable string function.
  function decorate(container) {
    container.querySelectorAll('.code-wrap').forEach((wrap) => {
      const code = wrap.querySelector('code');
      if (!code || code.dataset.hl) return;
      code.dataset.hl = '1';
      const lang = wrap.querySelector('.code-lang')?.textContent || '';
      const html = highlightCode(code.textContent, lang);
      if (html !== code.innerHTML) code.innerHTML = html;
    });
    bindLinks(container);
  }

  function bindLinks(container) {
    container.querySelectorAll('a.md-link').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({ type: 'openExternal', url: a.dataset.href });
      });
    });
  }

  // Copy buttons on code blocks — delegated, since bubbles are re-rendered
  // on every streamed token.
  messagesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const code = btn.closest('.code-wrap')?.querySelector('code');
    if (!code) return;
    vscode.postMessage({ type: 'copy', text: code.textContent });
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = 'Copy'), 1200);
  });

  // Stick-to-bottom, rather than force-to-bottom.
  //
  // scrollToBottom() runs on every streamed token. Unconditionally jumping to
  // the end means that while a reply streams, any attempt to scroll up is
  // undone milliseconds later — the transcript is not unscrollable, it is
  // being yanked back several times a second, which is indistinguishable from
  // broken. So: follow the tail only while the reader is already at the tail,
  // and stop the moment they scroll away.
  let stickToBottom = true;
  const NEAR_BOTTOM_PX = 40;

  function atBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= NEAR_BOTTOM_PX;
  }

  messagesEl.addEventListener('scroll', () => {
    stickToBottom = atBottom();
    if (jumpBtn) jumpBtn.classList.toggle('hidden', stickToBottom);
  });

  function scrollToBottom(force) {
    if (!force && !stickToBottom) return; // the reader is looking at something
    messagesEl.scrollTop = messagesEl.scrollHeight;
    stickToBottom = true;
    if (jumpBtn) jumpBtn.classList.add('hidden');
  }

  // ---------- working indicator ----------
  // Local models can take a long time before the first token: loading the
  // model, evaluating the prompt on CPU. A panel that shows nothing in that
  // window looks frozen, so there is always a visible "what it's doing now"
  // line at the end of the transcript while a turn runs.
  let workingEl = null;
  let workingTimer = null;
  let workingSince = 0;

  function setWorking(label) {
    if (!label) {
      if (workingEl) workingEl.remove();
      workingEl = null;
      clearInterval(workingTimer);
      workingTimer = null;
      return;
    }
    if (!workingEl) {
      workingEl = document.createElement('div');
      workingEl.className = 'working';
      workingEl.innerHTML =
        '<span class="spinner"></span><span class="working-label"></span><span class="working-time"></span><span class="working-hint"><kbd>Esc</kbd> to stop</span>';
      workingSince = Date.now();
      workingTimer = setInterval(updateWorkingTime, 1000);
    }
    workingEl.querySelector('.working-label').textContent = label;
    messagesEl.appendChild(workingEl); // always last
    updateWorkingTime();
    scrollToBottom();
  }

  function updateWorkingTime() {
    if (!workingEl) return;
    const secs = Math.floor((Date.now() - workingSince) / 1000);
    workingEl.querySelector('.working-time').textContent = secs >= 3 ? `${secs}s` : '';
  }

  // Everything appended to the transcript goes above the working line.
  function append(el) {
    if (workingEl && workingEl.parentNode === messagesEl) messagesEl.insertBefore(el, workingEl);
    else messagesEl.appendChild(el);
  }

  // The empty panel states facts — where you are, what state the repo is
  // in, what you were last doing — and offers a few ways to start.
  const STARTS = ['Explain how this project is structured', 'Find and fix a bug in the open file', 'Write tests for the selected code', 'Review my uncommitted changes'];
  let wsInfo = null;

  function ageOf(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  }

  function emptyStateHtml() {
    const w = wsInfo || {};
    const facts = [];
    if (w.name) facts.push(['workspace', escapeHtml(w.name)]);
    if (w.branch) facts.push(['branch', `${escapeHtml(w.branch)}${w.changed ? ` · <b>${w.changed} changed</b>` : ' · clean'}`]);
    if (config.model) facts.push(['model', escapeHtml(config.model)]);
    const recent = (w.recent || [])
      .map((r, i) => `<button class="recent-row" data-id="${escapeHtml(r.id)}"><span class="n">${i + 1}</span><span class="t">${escapeHtml(r.title || 'untitled')}</span><span class="age">${ageOf(r.updatedAt)}</span></button>`)
      .join('');
    return `
      <div class="ready-line"><span class="lamp on"></span><span class="key">${w.name === null ? 'no folder open' : 'ready'}</span></div>
      ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt class="key">${k}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
      ${recent ? `<div class="block-head key">resume</div>${recent}` : ''}
      <div class="block-head key">start</div>
      ${STARTS.map((t, i) => `<button class="start-row" data-text="${escapeHtml(t)}"><span class="n">${String.fromCharCode(97 + i)}</span><span class="t">${escapeHtml(t)}</span></button>`).join('')}
      <div class="empty-keys"><span><b>@</b> file</span><span><b>/</b> command</span><span><b>enter</b> send</span><span><b>shift+enter</b> newline</span><span><b>esc</b> stop</span></div>
    `;
  }

  function bindEmptyState(div) {
    div.querySelectorAll('.start-row').forEach((b) =>
      b.addEventListener('click', () => {
        inputEl.value = b.dataset.text;
        inputEl.focus();
        onInputChanged();
      })
    );
    div.querySelectorAll('.recent-row').forEach((b) => b.addEventListener('click', () => vscode.postMessage({ type: 'loadSession', id: b.dataset.id })));
  }

  function showEmptyState() {
    const existing = messagesEl.querySelector('.empty-state');
    if (!existing && messagesEl.children.length) return;
    const div = existing || document.createElement('div');
    div.className = 'empty-state';
    div.innerHTML = emptyStateHtml();
    bindEmptyState(div);
    if (!existing) messagesEl.appendChild(div);
  }

  function clearEmptyState() {
    const el = messagesEl.querySelector('.empty-state');
    if (el) el.remove();
  }

  let turnCount = 0;

  function addUserMessage(text, image) {
    clearEmptyState();
    turnCount++;
    const rule = document.createElement('div');
    rule.className = 'turn-rule';
    rule.innerHTML = `<span class="turn-no">turn ${String(turnCount).padStart(2, '0')}</span><span class="turn-time"></span>`;
    append(rule);
    const div = document.createElement('div');
    div.className = 'msg user';
    if (typeof image === 'string' && image.startsWith('data:')) {
      const img = document.createElement('img');
      img.src = image;
      img.className = 'msg-attached-image';
      div.appendChild(img);
    }
    if (text) {
      const span = document.createElement('span');
      span.textContent = text;
      div.appendChild(span);
    }
    append(div);
    markLastUserMessage();
    if (sessionTitleEl && !sessionTitleEl.textContent && text) sessionTitleEl.textContent = text.replace(/\s+/g, ' ').slice(0, 80);
    currentAssistantEl = null;
    currentAssistantBuf = '';
    thinking = null;
    scrollToBottom(true); // sending is an explicit request to see the newest message
  }

  // Retry / Edit live on the most recent message the user sent, and only
  // there: going further back is what checkpoints' "Rewind here" is for.
  function markLastUserMessage() {
    messagesEl.querySelectorAll('.msg-actions').forEach((el) => el.remove());
    const users = messagesEl.querySelectorAll('.msg.user');
    const last = users[users.length - 1];
    if (!last) return;
    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    bar.innerHTML =
      `<button data-act="copy" title="Copy this message">${icon('copy')}Copy</button>` +
      `<button data-act="editLast" title="Edit this message and resend (undoes this turn's file changes)">${icon('edit')}Edit</button>` +
      `<button data-act="retryLast" title="Run this message again (undoes this turn's file changes)">${icon('retry')}Retry</button>`;
    bar.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.act === 'copy') vscode.postMessage({ type: 'copy', text: last.textContent });
        else if (!busy) vscode.postMessage({ type: b.dataset.act });
      })
    );
    last.insertAdjacentElement('afterend', bar);
  }

  function addAttachedChips(paths) {
    const users = messagesEl.querySelectorAll('.msg.user');
    const last = users[users.length - 1];
    if (!last || !paths.length) return;
    const row = document.createElement('div');
    row.className = 'attached-row';
    row.innerHTML = paths.map((p) => `<span class="attached-chip" title="Attached for the model">${icon('paperclip')}${escapeHtml(p)}</span>`).join('');
    (last.nextElementSibling && last.nextElementSibling.classList.contains('msg-actions') ? last.nextElementSibling : last).insertAdjacentElement('afterend', row);
  }

  function addSystemNote(text, cls) {
    const div = document.createElement('div');
    div.className = 'msg system' + (cls ? ` ${cls}` : '');
    div.textContent = text;
    append(div);
    scrollToBottom();
  }

  // ---------- thinking (reasoning models) ----------
  let thinking = null; // {el, buf, startedAt, done}

  function appendThinking(text) {
    if (!thinking || thinking.done) {
      const el = document.createElement('details');
      el.className = 'thinking';
      el.innerHTML = '<summary><span class="thinking-label">Thinking…</span></summary><div class="thinking-body"></div>';
      append(el);
      thinking = { el, buf: '', startedAt: Date.now(), done: false };
      setWorking(null);
    }
    thinking.buf += text;
    thinking.el.querySelector('.thinking-body').textContent = thinking.buf;
    scrollToBottom();
  }

  function finishThinking() {
    if (!thinking || thinking.done) return;
    thinking.done = true;
    const secs = Math.max(1, Math.round((Date.now() - thinking.startedAt) / 1000));
    thinking.el.querySelector('.thinking-label').textContent = `Thought for ${secs}s`;
  }

  // ---------- streaming assistant reply ----------
  function ensureAssistantBubble() {
    if (!currentAssistantEl) {
      currentAssistantEl = document.createElement('div');
      currentAssistantEl.className = 'msg assistant';
      append(currentAssistantEl);
    }
    return currentAssistantEl;
  }

  // Re-rendering markdown for every token is quadratic over a long reply;
  // batching to one render per animation frame keeps it smooth.
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderStreaming();
    });
  }

  function renderStreaming() {
    if (!currentAssistantBuf) return;
    const { text, toolPending, toolName } = splitStreamingReply(currentAssistantBuf);
    if (text.trim()) {
      const el = ensureAssistantBubble();
      el.innerHTML = renderMarkdown(text);
      decorate(el);
    } else if (currentAssistantEl) {
      currentAssistantEl.remove();
      currentAssistantEl = null;
    }
    if (toolPending) setWorking(toolName ? `Preparing ${toolName}…` : 'Preparing a tool call…');
    else if (text.trim()) setWorking(null);
    scrollToBottom();
  }

  function appendToken(text) {
    finishThinking();
    currentAssistantBuf += text;
    scheduleRender();
  }

  function finalizeAssistant(text, steps, elapsedMs) {
    finishThinking();
    setWorking(null);
    const finalContent = text || splitStreamingReply(currentAssistantBuf).text;
    if (!finalContent && !currentAssistantEl) {
      currentAssistantBuf = '';
      return;
    }
    const el = ensureAssistantBubble();
    el.innerHTML = renderMarkdown(finalContent);
    decorate(el);
    if (typeof elapsedMs === 'number' && elapsedMs > 0) {
      const rules = messagesEl.querySelectorAll('.turn-rule .turn-time');
      if (rules.length) rules[rules.length - 1].textContent = `${(elapsedMs / 1000).toFixed(1)}s`;
      const stats = document.createElement('div');
      stats.className = 'turn-stats';
      const secs = (elapsedMs / 1000).toFixed(1);
      stats.innerHTML =
        `<span>${steps ? `${steps} step${steps === 1 ? '' : 's'} · ` : ''}${secs}s</span>` +
        `<button title="Copy this answer">${icon('copy')}copy</button>`;
      stats.querySelector('button').addEventListener('click', () => vscode.postMessage({ type: 'copy', text: finalContent }));
      el.appendChild(stats);
    }
    currentAssistantEl = null;
    currentAssistantBuf = '';
    scrollToBottom();
  }

  // ---------- tool cards ----------
  // [icon, label] — what the step is called in the transcript.
  const TOOL_META = {
    read_file: ['file', 'Read'],
    write_file: ['file-plus', 'Write'],
    edit_file: ['edit', 'Edit'],
    multi_edit: ['edit', 'Edit+'],
    delete_file: ['trash', 'Delete'],
    rename_file: ['move', 'Move'],
    list_dir: ['folder', 'List'],
    glob: ['search', 'Glob'],
    search_code: ['search', 'Search'],
    semantic_search: ['sparkle', 'Recall'],
    find_symbol: ['code', 'Def'],
    find_references: ['code', 'Refs'],
    run_command: ['terminal', 'Run'],
    run_background: ['terminal', 'Start'],
    read_background_output: ['terminal', 'Output'],
    stop_background_process: ['stop', 'Halt'],
    git_status: ['git', 'Status'],
    git_diff: ['git', 'Diff'],
    git_commit: ['git', 'Commit'],
    diagnostics: ['bug', 'Check'],
    read_url: ['globe', 'Fetch'],
    remember: ['brain', 'Note'],
    save_plan: ['list', 'Plan'],
    delegate_task: ['users', 'Agent'],
    notify_webhook: ['bell', 'Notify'],
  };
  const toolMeta = (name) => TOOL_META[name] || ['wrench', 'Tool'];

  // The plan a save_plan call carries, as a checklist with a progress bar.
  function planHtml(steps) {
    const lines = String(steps || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return '';
    const items = lines.map((l) => {
      const done = /^(?:[-*]\s*)?\[[xX]\]/.test(l);
      return { done, text: l.replace(/^(?:[-*\d.)]+\s*)?(?:\[[ xX]\]\s*)?/, '') };
    });
    const doneCount = items.filter((i) => i.done).length;
    return (
      `<div class="plan-progress"><span style="width:${Math.round((doneCount / items.length) * 100)}%"></span></div>` +
      items
        .map((i) => `<div class="plan-item${i.done ? ' done' : ''}"><span class="plan-box">${i.done ? icon('check') : ''}</span><span class="plan-text">${escapeHtml(i.text)}</span></div>`)
        .join('')
    );
  }

  function setStatPill(block, add, del) {
    const header = block.querySelector('.tool-header');
    if (!header || (!add && !del)) return;
    let pill = header.querySelector('.stat-pill');
    if (!pill) {
      pill = document.createElement('span');
      pill.className = 'stat-pill';
      header.insertBefore(pill, header.querySelector('.step-time') || header.querySelector('.status'));
    }
    pill.innerHTML = `${add ? `<span class="stat-add">+${add}</span>` : ''}${del ? `<span class="stat-del">-${del}</span>` : ''}`;
  }

  function setStatus(block, state) {
    const el = block.querySelector('.status');
    if (!el) return;
    el.className = `status ${state}`;
    block.dataset.state = state;
    el.textContent = state === 'ok' ? 'ok' : state === 'error' ? 'fail' : state === 'waiting' ? 'review' : state === 'running' ? 'run' : '';
  }

  function createToolCard(name, args, id, { readOnly = false } = {}) {
    const block = document.createElement('div');
    block.className = 'tool-block';
    if (id) block.dataset.callId = id;
    if (readOnly) block.dataset.readOnly = '1';
    block.dataset.tool = name;
    const [ic, label] = toolMeta(name);
    const header = document.createElement('div');
    header.className = 'tool-header';
    header.innerHTML =
      `<span class="icon">${icon(ic)}</span><span class="name">${escapeHtml(label)}</span>` +
      `<span class="args">${escapeHtml(summarizeArgs(name, args))}</span>` +
      `<span class="step-time"></span><span class="status running">run</span><span class="collapse-hint">▾</span>`;
    block.dataset.state = 'running';
    block.dataset.startedAt = String(Date.now());
    header.title = `${name}\n${JSON.stringify(args || {}, null, 2).slice(0, 1500)}`;
    header.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      block.classList.toggle('collapsed');
    });
    block.appendChild(header);
    if (name === 'save_plan' && args && (args.steps || args.markdown)) {
      const body = document.createElement('div');
      body.className = 'tool-body plan';
      body.innerHTML = planHtml(args.steps || args.markdown);
      block.appendChild(body);
    }
    append(block);
    return block;
  }

  function addToolCall(name, args, id, readOnly) {
    // Keep the prose the model wrote before the TOOL_CALL marker. Rendered
    // from the buffer, not the bubble: a fast model can deliver the call
    // before the next animation frame has created the bubble at all.
    const { text } = splitStreamingReply(currentAssistantBuf);
    if (text.trim()) {
      const el = ensureAssistantBubble();
      el.innerHTML = renderMarkdown(text);
      decorate(el);
    } else if (currentAssistantEl) {
      currentAssistantEl.remove();
    }
    finishThinking();
    currentAssistantEl = null;
    currentAssistantBuf = '';
    const block = createToolCard(name, args, id, { readOnly });
    setWorking(`${toolMeta(name)[1]}…`);
    scrollToBottom();
    return block;
  }

  function findToolBlock(id) {
    if (!id) return null;
    return messagesEl.querySelector(`.tool-block[data-call-id="${id}"]`);
  }

  function appendDiff(block, diffView) {
    if (!diffView) return;
    const html = diffViewHtml(diffView);
    if (!html) return;
    const body = document.createElement('div');
    body.className = 'tool-body diff';
    body.innerHTML = html;
    block.appendChild(body);
    setStatPill(block, diffView.add, diffView.del);
  }

  function addApprovalUI(id, name, args, previewError, diffView, diffId) {
    // The 'toolCall' event (fired first, for every call) already created
    // this card — reuse it instead of spawning a duplicate.
    const block = findToolBlock(id) || addToolCall(name, args, id);
    setWorking(null);
    setStatus(block, 'waiting');
    block.classList.remove('collapsed');

    if (previewError) {
      const body = document.createElement('div');
      body.className = 'tool-body error';
      body.textContent = previewError;
      block.appendChild(body);
    } else {
      appendDiff(block, diffView);
    }
    if (name === 'run_command' || name === 'run_background') {
      const body = document.createElement('div');
      body.className = 'tool-body command';
      body.textContent = `$ ${args && args.command}`;
      block.appendChild(body);
    }

    const row = document.createElement('div');
    row.className = 'approval-row';
    if (diffId) {
      const viewBtn = document.createElement('button');
      viewBtn.className = 'view-diff ghost';
      viewBtn.textContent = 'Diff';
      viewBtn.title = 'Open this change in the diff editor';
      viewBtn.onclick = () => vscode.postMessage({ type: 'openDiff', diffId });
      row.appendChild(viewBtn);
    }
    const approveBtn = document.createElement('button');
    approveBtn.className = 'primary';
    approveBtn.textContent = 'Approve';
    const rejectBtn = document.createElement('button');
    rejectBtn.textContent = 'Reject';

    function resolve(approved) {
      // Remembered on the card so the result that follows knows whether to
      // render: an approved action's output is the whole point of the card.
      block.dataset.verdict = approved ? 'approved' : 'rejected';
      row.classList.add('resolved');
      row.innerHTML = `<span class="verdict">${approved ? 'Approved' : 'Rejected'}</span>`;
      setStatus(block, approved ? 'running' : 'error');
      if (approved) {
        block.dataset.startedAt = String(Date.now()); // time the action, not the wait for a click
        setWorking(`${toolMeta(name)[1]}…`);
      }
      vscode.postMessage({ type: 'approve', id, approved });
    }

    approveBtn.onclick = () => resolve(true);
    rejectBtn.onclick = () => resolve(false);
    row.appendChild(approveBtn);
    row.appendChild(rejectBtn);
    // "Always allow" stops asking for this kind of action from here on —
    // never offered for a command flagged as dangerous.
    if (!block.querySelector('.danger-warning')) {
      const alwaysBtn = document.createElement('button');
      alwaysBtn.className = 'ghost';
      alwaysBtn.textContent = 'Always';
      alwaysBtn.title = `Approve, and stop asking before ${name} in this workspace (change it under Permissions)`;
      alwaysBtn.onclick = () => {
        vscode.postMessage({ type: 'setAutoApproveTool', name, enabled: true });
        resolve(true);
      };
      row.appendChild(alwaysBtn);
    }
    // Buttons read left to right as approve / reject / always, then the diff link.
    const view = row.querySelector('.view-diff');
    if (view) {
      const gap = document.createElement('span');
      gap.className = 'approval-spacer';
      row.appendChild(gap);
      row.appendChild(view);
    }
    block.appendChild(row);
    scrollToBottom();
    approveBtn.focus({ preventScroll: true });
  }

  function cancelApproval(id) {
    const block = findToolBlock(id);
    if (!block) return;
    const row = block.querySelector('.approval-row');
    if (row && !row.classList.contains('resolved')) {
      block.dataset.verdict = 'cancelled';
      row.classList.add('resolved');
      row.innerHTML = '<span class="verdict">Cancelled</span>';
      setStatus(block, 'error');
    }
  }

  function addToolResult(result, isError, id, revertAvailable, diffView) {
    if (!id) {
      addSystemNote(`⚠ ${result}`);
      return;
    }
    const block = findToolBlock(id);
    if (!block) return;
    setStatus(block, isError ? 'error' : 'ok');
    // A command that ran but exited non-zero is not "ok": show its exit code.
    const exit = !isError && /^(?:\[sandboxed\]\n)?EXIT CODE: (\d+)/.exec(String(result));
    if (exit) {
      setStatus(block, 'error');
      block.querySelector('.status').textContent = `exit ${exit[1]}`;
    }
    const took = Date.now() - Number(block.dataset.startedAt || 0);
    const timeEl = block.querySelector('.step-time');
    if (timeEl && block.dataset.startedAt) timeEl.textContent = took >= 60000 ? `${Math.round(took / 60000)}m` : `${(took / 1000).toFixed(1)}s`;
    // A rejected/cancelled card already says so; the "User declined" text
    // that goes back to the model would only repeat it.
    if (block.dataset.verdict === 'rejected' || block.dataset.verdict === 'cancelled') return;

    // Auto-approved edits skip the approval step, so this is the first
    // chance to show what actually changed — same diff view either way.
    appendDiff(block, diffView);

    // A plan's result only confirms it was saved; the checklist is the content.
    if (!(block.dataset.tool === 'save_plan' && !isError)) {
      const body = document.createElement('div');
      body.className = 'tool-body result' + (isError ? ' error' : '');
      body.textContent = result;
      block.appendChild(body);
    }

    // Successful reads are reference material, not news: keep the card to
    // its header so the transcript stays readable. Errors stay open.
    if (block.dataset.readOnly && !isError) block.classList.add('collapsed');

    if (revertAvailable && id) {
      const footer = document.createElement('div');
      footer.className = 'tool-footer';
      const revertBtn = document.createElement('button');
      revertBtn.className = 'revert-btn';
      revertBtn.innerHTML = `${icon('undo')}revert this change`;
      revertBtn.onclick = () => {
        revertBtn.disabled = true;
        revertBtn.textContent = 'Reverting…';
        vscode.postMessage({ type: 'revert', id });
      };
      footer.appendChild(revertBtn);
      block.appendChild(footer);
    }
    if (busy) setWorking('Thinking…');
    scrollToBottom();
  }

  function markReverted(id, path) {
    const block = findToolBlock(id);
    if (!block) return;
    const footer = block.querySelector('.tool-footer');
    if (footer) footer.innerHTML = `<span class="verdict">Reverted ${escapeHtml(path)}</span>`;
  }

  // Sub-agent progress lands inside the delegate_task card that started it.
  function addSubTaskLine(text, isError) {
    const cards = messagesEl.querySelectorAll('.tool-block');
    const card = [...cards].reverse().find((c) => c.dataset.tool === 'delegate_task');
    if (!card) return;
    let body = card.querySelector('.subtask-log');
    if (!body) {
      body = document.createElement('div');
      body.className = 'tool-body subtask-log';
      card.appendChild(body);
    }
    const line = document.createElement('div');
    line.className = isError ? 'error' : '';
    line.textContent = text;
    body.appendChild(line);
    scrollToBottom();
  }

  function setBusy(value) {
    busy = value;
    messagesEl.classList.toggle('busy', value);
    const lamp = document.getElementById('lamp');
    if (lamp) {
      lamp.classList.toggle('busy', value);
      lamp.title = value ? 'Working' : 'Idle';
    }
    sendBtn.classList.toggle('hidden', value);
    stopBtn.classList.toggle('hidden', !value);
    if (value) {
      if (!workingEl) setWorking('Thinking…');
    } else {
      setWorking(null);
      finishThinking();
      // Leave the bubble's visible text as-is but stop treating it as live.
      if (currentAssistantEl && currentAssistantBuf) renderStreaming();
      setWorking(null);
    }
  }

  let pendingImage = null; // data: URL of an attached image, cleared after send

  function send() {
    const text = inputEl.value;
    if ((!text.trim() && !pendingImage) || busy) return;
    inputEl.value = '';
    onInputChanged();
    const image = pendingImage;
    clearPendingImage();
    vscode.postMessage({ type: 'send', text, image });
  }

  function clearPendingImage() {
    pendingImage = null;
    const chip = document.getElementById('image-chip');
    if (chip) chip.remove();
  }

  function setPendingImage(dataUrl) {
    clearPendingImage(); // remove any previous chip first
    pendingImage = dataUrl;
    const chip = document.createElement('div');
    chip.id = 'image-chip';
    chip.innerHTML = `<img src="${dataUrl}"><button title="Remove">×</button>`;
    chip.querySelector('button').onclick = () => clearPendingImage();
    contextRow.appendChild(chip);
  }

  // ---------- composer chrome ----------
  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, Math.round(window.innerHeight * 0.38))}px`;
  }
  function onInputChanged() {
    autosize();
    sendBtn.classList.toggle('empty', !inputEl.value.trim() && !pendingImage);
  }

  // The file (and selection) the editor is on: sent with every message, so
  // it is shown here before sending rather than left for the user to guess.
  function renderEditorContext(ctx) {
    contextRow.querySelector('.chip.editor')?.remove();
    if (!ctx || !ctx.file) return;
    const chip = document.createElement('span');
    chip.className = 'chip editor';
    const sel = ctx.selection;
    const lines = sel ? (sel.startLine === sel.endLine ? ` · line ${sel.startLine}` : ` · lines ${sel.startLine}–${sel.endLine}`) : '';
    chip.title = sel ? 'The selected lines are sent with your message' : 'Cortex knows this is the file you have open';
    chip.innerHTML = `${icon(sel ? 'code' : 'file')}${escapeHtml(ctx.file.split('/').pop())}${lines}`;
    contextRow.insertBefore(chip, contextRow.firstChild);
  }

  // A small option menu anchored above the composer (mode, approvals).
  let openMenuEl = null;
  function closeMenu() {
    if (openMenuEl) openMenuEl.remove();
    openMenuEl = null;
  }
  function showOptionMenu(title, options) {
    const wasOpen = openMenuEl && openMenuEl.dataset.title === title;
    closeMenu();
    if (wasOpen) return;
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.dataset.title = title;
    menu.innerHTML =
      `<div class="menu-title">${escapeHtml(title)}</div>` +
      options
        .map((o, i) =>
          o.sep
            ? '<div class="menu-sep"></div>'
            : `<div class="menu-item option" data-i="${i}"><span class="opt-icon">${icon(o.icon)}</span><span class="opt-body"><span class="opt-title">${escapeHtml(o.title)}</span><span class="opt-desc">${escapeHtml(o.desc || '')}</span></span>${o.checked ? `<span class="opt-check">${icon('check')}</span>` : ''}</div>`
        )
        .join('');
    menu.querySelectorAll('.menu-item').forEach((el) =>
      el.addEventListener('click', () => {
        closeMenu();
        options[Number(el.dataset.i)].run();
      })
    );
    composerEl.appendChild(menu);
    openMenuEl = menu;
  }
  document.addEventListener('mousedown', (e) => {
    if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.closest('.seg')) closeMenu();
  });

  const imageInput = document.getElementById('image-input');
  const attachBtn = document.getElementById('attach-btn');
  if (attachBtn && imageInput) {
    attachBtn.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', () => {
      const file = imageInput.files && imageInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => setPendingImage(reader.result);
      reader.readAsDataURL(file);
      imageInput.value = '';
    });
  }

  // Pasting a screenshot straight into the composer attaches it.
  inputEl.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    const reader = new FileReader();
    reader.onload = () => setPendingImage(reader.result);
    reader.readAsDataURL(item.getAsFile());
  });

  if (jumpBtn) jumpBtn.addEventListener('click', () => scrollToBottom(true));
  if (modelBadge) modelBadge.addEventListener('click', () => vscode.postMessage({ type: 'selectModel' }));
  if (newChatBtn) newChatBtn.addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
  document.getElementById('mention-btn')?.addEventListener('click', () => {
    const at = inputEl.selectionStart ?? inputEl.value.length;
    const before = inputEl.value.slice(0, at);
    const insert = before && !/\s$/.test(before) ? ' @' : '@';
    inputEl.value = before + insert + inputEl.value.slice(at);
    inputEl.focus();
    inputEl.setSelectionRange(at + insert.length, at + insert.length);
    onInputChanged();
    updateMentionMenu();
  });
  document.getElementById('slash-btn')?.addEventListener('click', () => {
    if (!inputEl.value.trim()) inputEl.value = '/';
    inputEl.focus();
    onInputChanged();
    updateSlashMenu();
  });

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  inputEl.addEventListener('keydown', (e) => {
    if (slashMenuKey(e)) return;
    if (mentionMenuKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' && openMenuEl) {
      closeMenu();
    } else if (e.key === 'Escape' && busy) {
      vscode.postMessage({ type: 'stop' });
    }
  });

  // ---------- / command menu ----------
  // Typing "/" at the start of a message offers the built-in commands and
  // the project's own (.cortex/commands/*.md).
  let slashCommands = [];
  let slashItems = [];
  let slashIndex = 0;
  const slashMenu = document.createElement('div');
  slashMenu.id = 'slash-menu';
  slashMenu.className = 'menu hidden';
  composerEl.appendChild(slashMenu);

  function updateSlashMenu() {
    const m = inputEl.value.match(/^\/([\w-]*)$/);
    if (!m) {
      slashMenu.classList.add('hidden');
      slashItems = [];
      return;
    }
    const q = m[1].toLowerCase();
    slashItems = slashCommands.filter((c) => c.name.toLowerCase().startsWith(q));
    if (!slashItems.length) slashItems = slashCommands.filter((c) => c.name.toLowerCase().includes(q));
    slashIndex = Math.min(slashIndex, Math.max(0, slashItems.length - 1));
    if (!slashItems.length) {
      slashMenu.classList.add('hidden');
      return;
    }
    slashMenu.innerHTML =
      '<div class="menu-title">Commands</div>' +
      slashItems
        .map(
          (c, i) =>
            `<div class="menu-item${i === slashIndex ? ' active' : ''}" data-i="${i}"><span class="menu-name">/${escapeHtml(c.name)}</span><span class="menu-desc">${escapeHtml(c.description || '')}</span>${c.custom ? '<span class="menu-tag">yours</span>' : ''}</div>`
        )
        .join('');
    slashMenu.querySelectorAll('.menu-item').forEach((el) =>
      el.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        pickSlash(Number(el.dataset.i));
      })
    );
    slashMenu.classList.remove('hidden');
  }

  function pickSlash(i) {
    const cmd = slashItems[i];
    if (!cmd) return;
    slashMenu.classList.add('hidden');
    slashItems = [];
    // Commands with nothing to add run straight away; custom ones usually
    // take arguments, so they are left in the box to be completed.
    if (!cmd.custom) {
      inputEl.value = `/${cmd.name}`;
      send();
    } else {
      inputEl.value = `/${cmd.name} `;
      inputEl.focus();
      onInputChanged();
    }
  }

  function slashMenuKey(e) {
    if (slashMenu.classList.contains('hidden') || !slashItems.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      slashIndex = (slashIndex + (e.key === 'ArrowDown' ? 1 : -1) + slashItems.length) % slashItems.length;
      updateSlashMenu();
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      pickSlash(slashIndex);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      slashMenu.classList.add('hidden');
      return true;
    }
    return false;
  }

  // ---------- @-mention menu ----------
  // Typing "@" offers workspace files; picking one inserts its path, and the
  // host attaches that file to the message on send.
  let workspaceFileList = null;
  let filesFetchedAt = 0;
  let mentionItems = [];
  let mentionIndex = 0;
  const mentionMenu = document.createElement('div');
  mentionMenu.id = 'mention-menu';
  mentionMenu.className = 'hidden';
  composerEl.appendChild(mentionMenu);

  function currentMention() {
    return mentionAt(inputEl.value, inputEl.selectionStart ?? inputEl.value.length);
  }

  function updateMentionMenu() {
    const m = currentMention();
    if (!m) {
      mentionMenu.classList.add('hidden');
      mentionItems = [];
      return;
    }
    if (!workspaceFileList || Date.now() - filesFetchedAt > 15_000) {
      filesFetchedAt = Date.now(); // one request in flight at a time
      vscode.postMessage({ type: 'listFiles' });
      if (!workspaceFileList) {
        mentionMenu.innerHTML = '<div class="mention-empty">Loading files…</div>';
        mentionMenu.classList.remove('hidden');
        return;
      }
    }
    mentionItems = rankFiles(m.query, workspaceFileList, 10);
    mentionIndex = Math.min(mentionIndex, Math.max(0, mentionItems.length - 1));
    if (!mentionItems.length) {
      mentionMenu.innerHTML = '<div class="mention-empty">No matching files</div>';
    } else {
      mentionMenu.innerHTML = mentionItems
        .map((f, i) => {
          const slash = f.lastIndexOf('/');
          return `<div class="mention-item${i === mentionIndex ? ' active' : ''}" data-i="${i}"><span class="mention-base">${escapeHtml(f.slice(slash + 1))}</span><span class="mention-dir">${escapeHtml(f.slice(0, slash + 1))}</span></div>`;
        })
        .join('');
      mentionMenu.querySelectorAll('.mention-item').forEach((el) =>
        el.addEventListener('mousedown', (ev) => {
          ev.preventDefault(); // keep focus in the textarea
          pickMention(Number(el.dataset.i));
        })
      );
    }
    mentionMenu.classList.remove('hidden');
  }

  function pickMention(i) {
    const m = currentMention();
    const file = mentionItems[i];
    if (!m || !file) return;
    const cursor = inputEl.selectionStart ?? inputEl.value.length;
    const insert = `@${file} `;
    inputEl.value = inputEl.value.slice(0, m.start) + insert + inputEl.value.slice(cursor);
    const at = m.start + insert.length;
    inputEl.setSelectionRange(at, at);
    mentionMenu.classList.add('hidden');
    mentionItems = [];
    inputEl.focus();
    onInputChanged();
  }

  // Returns true when the key was handled by the open menu.
  function mentionMenuKey(e) {
    if (mentionMenu.classList.contains('hidden') || !mentionItems.length) {
      if (e.key === 'Escape' && !mentionMenu.classList.contains('hidden')) {
        mentionMenu.classList.add('hidden');
        return true;
      }
      return false;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      mentionIndex = (mentionIndex + (e.key === 'ArrowDown' ? 1 : -1) + mentionItems.length) % mentionItems.length;
      updateMentionMenu();
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      pickMention(mentionIndex);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      mentionMenu.classList.add('hidden');
      return true;
    }
    return false;
  }

  inputEl.addEventListener('input', () => {
    mentionIndex = 0;
    slashIndex = 0;
    onInputChanged();
    updateMentionMenu();
    updateSlashMenu();
  });
  inputEl.addEventListener('click', updateMentionMenu);
  inputEl.addEventListener('blur', () =>
    setTimeout(() => {
      mentionMenu.classList.add('hidden');
      slashMenu.classList.add('hidden');
    }, 150)
  );

  // ---------- Plan/Act mode ----------
  modePill.addEventListener('click', () =>
    showOptionMenu('Mode', [
      { icon: 'zap', title: 'Act', desc: 'Make changes: edit files and run commands.', checked: currentMode === 'act', run: () => vscode.postMessage({ type: 'setMode', mode: 'act' }) },
      { icon: 'map', title: 'Plan', desc: 'Read-only: investigate and propose a plan, change nothing.', checked: currentMode === 'plan', run: () => vscode.postMessage({ type: 'setMode', mode: 'plan' }) },
    ])
  );

  function setModeUI(mode) {
    currentMode = mode === 'plan' ? 'plan' : 'act';
    const plan = currentMode === 'plan';
    modePill.classList.toggle('on', plan);
    modePill.querySelector('.pill-label').textContent = plan ? 'plan' : 'act';
    composerEl.classList.toggle('plan-mode', plan);
    inputEl.placeholder = plan ? 'describe what to investigate — nothing will be changed' : 'describe a change';
  }

  // ---------- approvals ----------
  approvePill.addEventListener('click', () =>
    showOptionMenu('Approvals', [
      { icon: 'shield', title: 'Ask first', desc: 'Review every edit and command before it runs.', checked: !config.autoApprove, run: () => vscode.postMessage({ type: 'setAutoApprove', enabled: false }) },
      { icon: 'shield-check', title: 'Auto-approve', desc: 'Run edits and commands without asking. Destructive commands still ask.', checked: !!config.autoApprove, run: () => vscode.postMessage({ type: 'setAutoApprove', enabled: true }) },
      { sep: true },
      { icon: 'sliders', title: 'Per-action permissions…', desc: 'Choose which actions never need approval.', run: () => openDrawer('approvals') },
    ])
  );

  function setApproveUI(autoApprove) {
    approvePill.classList.toggle('warn', !!autoApprove);
    approvePill.querySelector('.pill-label').textContent = autoApprove ? 'auto' : 'ask';
  }

  // ---------- sandbox ----------
  const sandboxSeg = document.getElementById('sandbox-seg');
  const SANDBOX_SHORT = { 'read-only': 'read-only', 'workspace-write': 'workspace', 'danger-full-access': 'full' };
  function setSandboxUI(mode) {
    if (!sandboxSeg) return;
    sandboxSeg.querySelector('.pill-label').textContent = SANDBOX_SHORT[mode] || 'full';
    sandboxSeg.classList.toggle('on', mode === 'read-only' || mode === 'workspace-write');
  }
  if (sandboxSeg) {
    const pick = (value) => () => vscode.postMessage({ type: 'setSetting', key: 'sandboxMode', value });
    sandboxSeg.addEventListener('click', () =>
      showOptionMenu('Sandbox', [
        { icon: 'shield', title: 'Read-only', desc: 'No edits and no commands at all.', checked: config.sandboxMode === 'read-only', run: pick('read-only') },
        { icon: 'shield', title: 'Workspace', desc: 'Edits stay in this folder; commands run sandboxed with the network off (Linux, needs bwrap).', checked: config.sandboxMode === 'workspace-write', run: pick('workspace-write') },
        { icon: 'shield', title: 'Full access', desc: 'No containment. Approvals are the only safeguard.', checked: !config.sandboxMode || config.sandboxMode === 'danger-full-access', run: pick('danger-full-access') },
      ])
    );
  }

  // ---------- drawer: History / Settings / Permissions / Memory ----------
  const PANELS = { history: historyPanel, settings: settingsPanel, approvals: approvalsPanel, memory: memoryPanel };
  let openTab = null;

  function closePanels() {
    drawer.classList.add('hidden');
    scrim.classList.add('hidden');
    openTab = null;
    historyBtn.classList.remove('active');
    settingsBtn.classList.remove('active');
  }

  function openDrawer(tab) {
    closeMenu();
    openTab = tab;
    for (const [name, el] of Object.entries(PANELS)) el.classList.toggle('hidden', name !== tab);
    drawer.querySelectorAll('.drawer-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    drawer.classList.remove('hidden');
    scrim.classList.remove('hidden');
    historyBtn.classList.toggle('active', tab === 'history');
    settingsBtn.classList.toggle('active', tab !== 'history');
    if (tab === 'history') vscode.postMessage({ type: 'listSessions' });
    if (tab === 'memory') vscode.postMessage({ type: 'getMemory' });
    if (tab === 'settings') renderSettings();
  }

  historyBtn.addEventListener('click', () => (openTab === 'history' ? closePanels() : openDrawer('history')));
  settingsBtn.addEventListener('click', () => (openTab && openTab !== 'history' ? closePanels() : openDrawer('settings')));
  drawer.querySelectorAll('.drawer-tab').forEach((t) => t.addEventListener('click', () => openDrawer(t.dataset.tab)));
  document.getElementById('drawer-close').addEventListener('click', closePanels);
  scrim.addEventListener('click', closePanels);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openTab) closePanels();
  });

  function relativeDay(iso) {
    const d = new Date(iso);
    const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return 'This week';
    if (days < 31) return 'This month';
    return 'Older';
  }

  function renderSessions(items, currentId) {
    historyPanel.innerHTML = '';
    const actions = document.createElement('div');
    actions.className = 'panel-actions';
    actions.innerHTML = `<button class="btn primary" data-act="newChat">${icon('plus')}New chat</button><button class="btn" data-act="forkSession" title="Continue this conversation in a copy, leaving the original as it is">${icon('fork')}Fork this chat</button>`;
    actions.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        vscode.postMessage({ type: b.dataset.act });
        closePanels();
      })
    );
    historyPanel.appendChild(actions);
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.textContent = 'No previous chats yet. Conversations are saved per workspace.';
      historyPanel.appendChild(empty);
      return;
    }
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'session-search';
    search.placeholder = 'Search conversations…';
    historyPanel.appendChild(search);
    const list = document.createElement('div');
    list.className = 'session-list';
    historyPanel.appendChild(list);

    const draw = () => {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = '';
      let group = null;
      for (const s of items) {
        if (q && !(s.title || '').toLowerCase().includes(q)) continue;
        const g = relativeDay(s.updatedAt);
        if (g !== group) {
          group = g;
          const head = document.createElement('div');
          head.className = 'session-group';
          head.textContent = g;
          list.appendChild(head);
        }
        const row = document.createElement('div');
        row.className = 'session-row' + (s.id === currentId ? ' current' : '');
        const info = document.createElement('div');
        info.className = 'session-info';
        const title = document.createElement('div');
        title.className = 'session-title';
        title.textContent = s.title || 'New chat';
        const date = document.createElement('div');
        date.className = 'session-date';
        date.textContent = new Date(s.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        info.appendChild(title);
        info.appendChild(date);
        info.addEventListener('click', () => {
          vscode.postMessage({ type: 'loadSession', id: s.id });
          closePanels();
        });
        const del = document.createElement('button');
        del.className = 'session-delete';
        del.innerHTML = icon('trash');
        del.title = 'Delete this chat';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'deleteSession', id: s.id });
        });
        row.appendChild(info);
        row.appendChild(del);
        list.appendChild(row);
      }
      if (!list.children.length) list.innerHTML = '<div class="panel-empty">No conversations match.</div>';
    };
    search.addEventListener('input', draw);
    draw();
  }

  // ---------- Settings panel ----------
  function switchEl(checked, onChange) {
    const label = document.createElement('label');
    label.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    const track = document.createElement('span');
    track.className = 'track';
    label.appendChild(input);
    label.appendChild(track);
    return label;
  }

  function settingRow(label, desc, control, stack) {
    const row = document.createElement('div');
    row.className = 'row' + (stack ? ' stack' : '');
    row.innerHTML = `<div class="row-text"><div class="row-label">${escapeHtml(label)}</div>${desc ? `<div class="row-desc">${escapeHtml(desc)}</div>` : ''}</div>`;
    const wrap = document.createElement('div');
    wrap.className = 'row-control';
    wrap.appendChild(control);
    row.appendChild(wrap);
    return row;
  }

  function selectEl(value, options, onChange) {
    const sel = document.createElement('select');
    for (const [v, text] of options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = text;
      sel.appendChild(o);
    }
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  function section(title, rows) {
    const sec = document.createElement('div');
    sec.className = 'section';
    sec.innerHTML = `<div class="section-title">${escapeHtml(title)}</div>`;
    const card = document.createElement('div');
    card.className = 'card';
    rows.forEach((r) => card.appendChild(r));
    sec.appendChild(card);
    return sec;
  }

  const set = (key, value) => vscode.postMessage({ type: 'setSetting', key, value });
  const run = (command) => vscode.postMessage({ type: 'runCommand', command });

  function renderSettings() {
    const c = config;
    settingsPanel.innerHTML = '';

    const modelBtn = document.createElement('button');
    modelBtn.className = 'btn';
    modelBtn.textContent = 'Change…';
    modelBtn.onclick = () => run('cortex.selectModel');
    const modelRows = [settingRow('Model', c.model || '—', modelBtn)];
    if (c.profiles && c.profiles.length) {
      modelRows.push(
        settingRow(
          'Profile',
          'A saved preset of model and permissions.',
          selectEl(c.activeProfile || '', [['', 'None'], ...c.profiles.map((p) => [p, p])], (v) => vscode.postMessage({ type: 'setProfile', name: v }))
        )
      );
    }
    const where = document.createElement('span');
    where.className = 'row-value';
    where.textContent = c.host || '';
    where.title = c.host || '';
    modelRows.push(settingRow('Provider', c.provider === 'openai-compatible' ? 'OpenAI-compatible API' : 'Ollama', where));
    modelRows.push(
      settingRow(
        'Tool calling',
        'How tools are offered to the model.',
        selectEl(c.toolCalling || 'auto', [['auto', 'Automatic'], ['native', 'Native'], ['text', 'Text protocol']], (v) => set('toolCalling', v))
      )
    );
    settingsPanel.appendChild(section('Model', modelRows));

    settingsPanel.appendChild(
      section('Permissions', [
        settingRow(
          'Approval policy',
          'When Cortex asks before changing something.',
          selectEl(c.approvalPolicy || 'untrusted', [['untrusted', 'Always ask'], ['on-request', 'Ask outside the sandbox'], ['never', 'Never ask']], (v) => set('approvalPolicy', v))
        ),
        settingRow(
          'Sandbox',
          'How much a command is allowed to touch.',
          selectEl(c.sandboxMode || 'danger-full-access', [['read-only', 'Read-only'], ['workspace-write', 'Workspace only'], ['danger-full-access', 'Full access']], (v) => set('sandboxMode', v))
        ),
        settingRow('Review approvals with a model', 'A model checks each pending action and approves the safe ones for you.', switchEl(c.approveForMe, (v) => set('approveForMe', v))),
      ])
    );

    const steps = document.createElement('input');
    steps.type = 'number';
    steps.min = '1';
    steps.max = '500';
    steps.value = String(c.maxSteps ?? 50);
    steps.addEventListener('change', () => {
      const n = parseInt(steps.value, 10);
      if (n >= 1 && n <= 500) set('maxSteps', n);
    });
    const testCmd = document.createElement('input');
    testCmd.type = 'text';
    testCmd.placeholder = 'e.g. npm test';
    testCmd.value = c.testCommand || '';
    testCmd.addEventListener('change', () => set('testCommand', testCmd.value.trim()));
    settingsPanel.appendChild(
      section('Behaviour', [
        settingRow('Step limit', 'Model round-trips allowed per request.', steps),
        settingRow('Test command', 'Run after a turn that changed files; failures go back to the model.', testCmd, true),
        settingRow('Run commands in the terminal', 'Use the visible integrated terminal instead of a hidden process.', switchEl(c.useTerminal, (v) => set('useTerminal', v))),
        settingRow('Animate edits', 'Play each edit as a sweep through the diff view.', switchEl(c.animateEdits, (v) => set('animateEdits', v))),
      ])
    );

    const tools = document.createElement('div');
    tools.className = 'section';
    tools.innerHTML = '<div class="section-title">Tools</div>';
    const grid = document.createElement('div');
    grid.className = 'tool-grid';
    for (const [ic, text, command, title] of [
      ['undo', 'Revert last turn', 'cortex.revertLastTurn', 'Undo every file change the last turn made'],
      ['git', 'Commit message', 'cortex.generateCommitMessage', 'Write a commit message from the staged changes'],
      ['search', 'Build code index', 'cortex.buildCodeIndex', 'Index the workspace for semantic search'],
      ['beaker', 'Benchmark models', 'cortex.benchmarkModels', 'Score your installed models on real tasks'],
      ['sparkle', 'Probe model', 'cortex.probeModel', 'Check what the current model can do'],
      ['logs', 'Show logs', 'cortex.showLogs', 'Open the Cortex output channel'],
      ['list', 'Audit log', 'cortex.showAuditLog', 'Everything Cortex ran in this workspace'],
      ['gear', 'All settings', 'openSettings', 'Open every Cortex setting'],
    ]) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.title = title;
      b.innerHTML = `${icon(ic)}${text}`;
      b.onclick = () => {
        run(command);
        closePanels();
      };
      grid.appendChild(b);
    }
    tools.appendChild(grid);
    settingsPanel.appendChild(tools);
  }

  // ---------- Auto-approve panel ----------
  function renderApprovals(toolNames, enabled) {
    approvalsPanel.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'panel-note';
    note.textContent =
      'Actions switched on here run without asking. Auto-approve overrides all of them. Destructive commands (rm -rf, sudo, force-push, …) always ask.';
    approvalsPanel.appendChild(note);
    const card = document.createElement('div');
    card.className = 'card';
    for (const name of toolNames) {
      const [ic, label] = toolMeta(name);
      const row = document.createElement('label');
      row.className = 'row approval-toggle';
      row.innerHTML = `<div class="row-text"><div class="row-label">${icon(ic)}${escapeHtml(label)}</div><div class="row-desc">${escapeHtml(name)}</div></div>`;
      row.appendChild(switchEl(enabled.includes(name), (v) => vscode.postMessage({ type: 'setAutoApproveTool', name, enabled: v })));
      card.appendChild(row);
    }
    approvalsPanel.appendChild(card);
  }

  // ---------- Memory panel ----------
  // Shows exactly what's in .cortex/MEMORY.md — the durable notes Cortex
  // injects into every system prompt — and lets the user read/edit it
  // directly instead of it being an invisible black box.
  function renderMemory(content) {
    memoryPanel.innerHTML = '<div class="panel-title">Project memory</div>';
    const note = document.createElement('div');
    note.className = 'panel-note';
    note.textContent = 'Notes Cortex keeps about this project (.cortex/MEMORY.md). They are sent with every message, across chats and restarts. Edit them freely.';
    memoryPanel.appendChild(note);

    const textarea = document.createElement('textarea');
    textarea.className = 'memory-textarea';
    textarea.value = content || '';
    textarea.rows = 8;
    memoryPanel.appendChild(textarea);

    const row = document.createElement('div');
    row.className = 'memory-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = 'Save';
    saveBtn.onclick = () => {
      vscode.postMessage({ type: 'saveMemory', content: textarea.value });
      saveBtn.textContent = 'Saved';
      setTimeout(() => (saveBtn.textContent = 'Save'), 1200);
    };
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear all';
    clearBtn.onclick = () => {
      textarea.value = '';
      vscode.postMessage({ type: 'saveMemory', content: '' });
    };
    row.appendChild(saveBtn);
    row.appendChild(clearBtn);
    memoryPanel.appendChild(row);
  }

  function resetTranscript() {
    setWorking(null);
    messagesEl.innerHTML = '';
    turnCount = 0;
    if (sessionTitleEl) sessionTitleEl.textContent = '';
    currentAssistantEl = null;
    currentAssistantBuf = '';
    thinking = null;
  }

  function restoreSession(messages) {
    resetTranscript();
    if (!messages.length) {
      showEmptyState();
      return;
    }
    for (const m of messages) {
      if (m.role === 'user') addUserMessage(m.text, m.image);
      else if (m.role === 'assistant') {
        const div = document.createElement('div');
        div.className = 'msg assistant';
        div.innerHTML = renderMarkdown(m.text);
        decorate(div);
        append(div);
      } else if (m.role === 'tool') {
        const block = createToolCard(m.name, m.args, null);
        setStatus(block, m.result === undefined ? '' : m.isError ? 'error' : 'ok');
        if (m.result !== undefined) {
          const body = document.createElement('div');
          body.className = 'tool-body result' + (m.isError ? ' error' : '');
          body.textContent = m.result;
          block.appendChild(body);
        }
        block.classList.add('collapsed');
      } else addSystemNote(m.text);
    }
    scrollToBottom(true);
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'config':
        config = msg;
        modelNameEl.textContent = msg.model;
        modelBadge.title = `${msg.model} · ${msg.provider === 'openai-compatible' ? 'OpenAI-compatible' : 'Ollama'} — click to switch`;
        setApproveUI(msg.autoApprove);
        setSandboxUI(msg.sandboxMode);
        renderSessionStats();
        if (messagesEl.querySelector('.empty-state')) showEmptyState();
        if (openTab === 'settings') renderSettings();
        break;
      case 'commands':
        slashCommands = msg.items || [];
        break;
      case 'workspaceInfo':
        wsInfo = msg;
        if (messagesEl.querySelector('.empty-state')) showEmptyState();
        break;
      case 'editorContext':
        renderEditorContext(msg);
        break;
      case 'mode':
        setModeUI(msg.mode);
        break;
      case 'autoApproveTools':
        renderApprovals(msg.tools, msg.enabled);
        break;
      case 'memoryContent':
        renderMemory(msg.content);
        break;
      case 'sessions':
        renderSessions(msg.items, msg.currentId);
        break;
      case 'restoreSession':
        restoreSession(msg.messages);
        break;
      case 'banner':
        bannerEl.textContent = msg.text;
        bannerEl.classList.remove('hidden');
        break;
      case 'insertText':
        inputEl.value = msg.replace ? msg.text : msg.text + (inputEl.value ? '\n' + inputEl.value : '');
        inputEl.focus();
        inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
        onInputChanged();
        break;
      case 'testRun': {
        const div = document.createElement('div');
        div.className = 'msg system' + (msg.failed ? ' test-fail' : ' test-pass');
        div.textContent = `${msg.failed ? '✗' : '✓'} ${msg.command}\n${msg.result.slice(0, 400)}`;
        append(div);
        scrollToBottom();
        break;
      }
      case 'userMessage':
        addUserMessage(msg.text, msg.image);
        break;
      case 'step':
        // A new model request: anything streamed so far belongs to the
        // previous step, and nothing is visible until the first token.
        if (currentAssistantEl && currentAssistantBuf) {
          // The previous step ended in prose without a tool call or a final
          // answer (a retry, a failed test run). Keep what it said; start
          // the next step's text in a bubble of its own.
          currentAssistantEl = null;
          currentAssistantBuf = '';
        }
        if (!(thinking && !thinking.done)) setWorking('Thinking…');
        sessionStats.step = msg.step || sessionStats.step;
        renderSessionStats();
        break;
      case 'thinking':
        appendThinking(msg.text);
        break;
      case 'token':
        appendToken(msg.text);
        break;
      case 'notice':
        addSystemNote(msg.text);
        break;
      case 'attached':
        addAttachedChips(msg.paths || []);
        break;
      case 'files':
        workspaceFileList = msg.files || [];
        filesFetchedAt = Date.now();
        updateMentionMenu();
        break;
      case 'checkpointCreated': {
        const div = document.createElement('div');
        div.className = 'checkpoint-marker';
        const label = document.createElement('span');
        label.textContent = `checkpoint · ${msg.count} file${msg.count === 1 ? '' : 's'}`;
        sessionStats.files += msg.count || 0;
        renderSessionStats();
        const btn = document.createElement('button');
        btn.textContent = 'rewind';
        btn.title = 'Restore files and conversation to just before this turn';
        btn.onclick = () => {
          btn.disabled = true;
          vscode.postMessage({ type: 'rewindTo', checkpointId: msg.id });
        };
        div.appendChild(label);
        div.appendChild(btn);
        append(div);
        scrollToBottom();
        break;
      }
      case 'rewound':
        restoreSession(msg.messages);
        addSystemNote(`Rewound — restored ${msg.paths.length} file(s): ${msg.paths.join(', ') || 'none'}`);
        break;
      case 'turnReverted':
        addSystemNote(`Reverted the last turn — restored ${msg.paths.length} file(s): ${msg.paths.join(', ') || 'none'}`);
        break;
      case 'dangerWarning': {
        const block = findToolBlock(msg.id);
        const warn = document.createElement('div');
        warn.className = 'danger-warning';
        warn.textContent = `⚠ Flagged as dangerous: ${msg.why}. This can never be auto-approved.`;
        if (block) block.appendChild(warn);
        else append(warn);
        scrollToBottom();
        break;
      }
      case 'autoReview': {
        const block = findToolBlock(msg.id);
        if (block && msg.reason) {
          const note = document.createElement('div');
          note.className = 'tool-body review';
          note.textContent = `${msg.safe ? 'Auto-approved' : 'Needs your review'}: ${msg.reason}`;
          block.appendChild(note);
        }
        break;
      }
      case 'usage':
        sessionStats.promptTokens += msg.promptTokens || 0;
        sessionStats.completionTokens += msg.completionTokens || 0;
        sessionStats.lastPrompt = msg.promptTokens || sessionStats.lastPrompt;
        sessionStats.contextBudget = msg.contextBudget || sessionStats.contextBudget;
        renderSessionStats();
        break;
      case 'toolCall':
        addToolCall(msg.name, msg.args, msg.id, msg.readOnly);
        sessionStats.toolCalls++;
        renderSessionStats();
        break;
      case 'needsApproval':
        addApprovalUI(msg.id, msg.name, msg.args, msg.previewError, msg.diffView, msg.diffId);
        break;
      case 'approvalCancelled':
        cancelApproval(msg.id);
        break;
      case 'toolResult':
        addToolResult(msg.result, msg.isError, msg.id, msg.revertAvailable, msg.diffView);
        break;
      case 'subTaskCall':
        addSubTaskLine(`↳ ${msg.name} ${summarizeArgs(msg.name, msg.args)}`);
        break;
      case 'subTaskResult':
        if (msg.isError) addSubTaskLine(`  ✗ ${String(msg.result).slice(0, 200)}`, true);
        break;
      case 'reverted':
        markReverted(msg.id, msg.path);
        break;
      case 'final':
        finalizeAssistant(msg.text, msg.steps, msg.elapsedMs);
        sessionStats.totalMs += msg.elapsedMs || 0;
        renderSessionStats();
        break;
      case 'error':
        finishThinking();
        setWorking(null);
        if (currentAssistantEl && currentAssistantBuf) renderStreaming();
        addSystemNote(`⚠ ${msg.text}`, 'error');
        currentAssistantEl = null;
        currentAssistantBuf = '';
        if (busy) setWorking('Thinking…');
        break;
      case 'busy':
        setBusy(msg.value);
        break;
      case 'cleared':
        resetTranscript();
        sessionStats.toolCalls = 0;
        sessionStats.totalMs = 0;
        sessionStats.promptTokens = 0;
        sessionStats.completionTokens = 0;
        sessionStats.lastPrompt = 0;
        sessionStats.step = 0;
        sessionStats.files = 0;
        renderSessionStats();
        showEmptyState();
        break;
      default:
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
  showEmptyState();
  setModeUI('act');
  onInputChanged();
  renderSessionStats();
}());
