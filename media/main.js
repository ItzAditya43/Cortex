(function () {
  const vscode = acquireVsCodeApi();
  const { escapeHtml, renderMarkdown, splitStreamingReply, summarizeArgs, diffViewHtml, rankFiles, mentionAt } = window.CortexRender;

  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const bannerEl = document.getElementById('banner');
  const modelBadge = document.getElementById('model-badge');
  const sessionStatsEl = document.getElementById('session-stats');
  const jumpBtn = document.getElementById('jump-bottom');
  const historyBtn = document.getElementById('history-btn');
  const approvalsBtn = document.getElementById('approvals-btn');
  const memoryBtn = document.getElementById('memory-btn');
  const historyPanel = document.getElementById('panel-history');
  const approvalsPanel = document.getElementById('panel-approvals');
  const memoryPanel = document.getElementById('panel-memory');
  const modeButtons = document.querySelectorAll('.mode-btn');
  const approveButtons = document.querySelectorAll('.approve-btn');

  let currentAssistantEl = null; // streaming bubble currently being written to
  let currentAssistantBuf = '';
  let busy = false;
  const sessionStats = { toolCalls: 0, totalMs: 0, promptTokens: 0, completionTokens: 0, lastPrompt: 0, contextBudget: 0 };
  function renderSessionStats() {
    if (!sessionStatsEl) return;
    if (!sessionStats.toolCalls && !sessionStats.totalMs) {
      sessionStatsEl.textContent = '';
      return;
    }
    const tok = sessionStats.promptTokens + sessionStats.completionTokens;
    const parts = [`${sessionStats.toolCalls} call${sessionStats.toolCalls === 1 ? '' : 's'}`, `${(sessionStats.totalMs / 1000).toFixed(1)}s`];
    if (tok) parts.push(`${tok > 1000 ? (tok / 1000).toFixed(1) + 'k' : tok} tok`);
    // context utilisation is the number that actually predicts truncation
    if (sessionStats.lastPrompt && sessionStats.contextBudget) {
      parts.push(`${Math.round((sessionStats.lastPrompt / sessionStats.contextBudget) * 100)}% ctx`);
    }
    sessionStatsEl.textContent = parts.join(' · ');
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
      workingEl.innerHTML = '<span class="spinner"></span><span class="working-label"></span><span class="working-time"></span>';
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

  function showEmptyState() {
    if (messagesEl.querySelector('.empty-state') || messagesEl.children.length) return;
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.innerHTML = `
      <div class="empty-glyph">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <ellipse cx="8" cy="12" rx="5.5" ry="4.7"></ellipse>
          <ellipse cx="16" cy="12" rx="5.5" ry="4.7"></ellipse>
        </svg>
      </div>
      <div class="empty-title">Ask Cortex anything</div>
      <div class="empty-sub">It can read, write, and run code in this workspace.</div>
      <div class="empty-examples">
        <button class="example">Explain how this project is structured</button>
        <button class="example">Find and fix a bug in the open file</button>
        <button class="example">Write tests for the selected code</button>
      </div>
    `;
    div.querySelectorAll('.example').forEach((b) =>
      b.addEventListener('click', () => {
        inputEl.value = b.textContent;
        inputEl.focus();
      })
    );
    messagesEl.appendChild(div);
  }

  function clearEmptyState() {
    const el = messagesEl.querySelector('.empty-state');
    if (el) el.remove();
  }

  function addUserMessage(text, image) {
    clearEmptyState();
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
      '<button data-act="editLast" title="Edit this message and resend (undoes this turn\'s file changes)">✎ Edit</button>' +
      '<button data-act="retryLast" title="Run this message again (undoes this turn\'s file changes)">↻ Retry</button>';
    bar.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => !busy && vscode.postMessage({ type: b.dataset.act })));
    last.insertAdjacentElement('afterend', bar);
  }

  function addAttachedChips(paths) {
    const users = messagesEl.querySelectorAll('.msg.user');
    const last = users[users.length - 1];
    if (!last || !paths.length) return;
    const row = document.createElement('div');
    row.className = 'attached-row';
    row.innerHTML = paths.map((p) => `<span class="attached-chip" title="Attached for the model">📎 ${escapeHtml(p)}</span>`).join('');
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
      bindLinks(el);
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
    bindLinks(el);
    if (typeof elapsedMs === 'number' && elapsedMs > 0) {
      const stats = document.createElement('div');
      stats.className = 'turn-stats';
      const secs = (elapsedMs / 1000).toFixed(1);
      stats.textContent = `${secs}s${steps ? ` · ${steps} step${steps === 1 ? '' : 's'}` : ''}`;
      el.appendChild(stats);
    }
    currentAssistantEl = null;
    currentAssistantBuf = '';
    scrollToBottom();
  }

  // ---------- tool cards ----------
  const TOOL_ICONS = {
    read_file: '📖',
    write_file: '📝',
    edit_file: '✏️',
    multi_edit: '✏️',
    delete_file: '🗑',
    rename_file: '🔀',
    list_dir: '📁',
    search_code: '🔍',
    semantic_search: '🔍',
    find_symbol: '🔎',
    find_references: '🔎',
    run_command: '⚡',
    run_background: '⚡',
    read_background_output: '📟',
    stop_background_process: '⏹',
    git_status: '🌿',
    git_diff: '🌿',
    git_commit: '🌿',
    diagnostics: '🩺',
    read_url: '🌐',
    remember: '🧠',
    save_plan: '☑',
    delegate_task: '🤝',
    notify_webhook: '🔔',
  };

  function setStatPill(block, add, del) {
    const header = block.querySelector('.tool-header');
    if (!header || (!add && !del)) return;
    let pill = header.querySelector('.stat-pill');
    if (!pill) {
      pill = document.createElement('span');
      pill.className = 'stat-pill';
      header.insertBefore(pill, header.querySelector('.status'));
    }
    pill.innerHTML = `${add ? `<span class="stat-add">+${add}</span>` : ''}${del ? `<span class="stat-del">-${del}</span>` : ''}`;
  }

  function setStatus(block, state) {
    const el = block.querySelector('.status');
    if (!el) return;
    el.className = `status ${state}`;
    el.textContent = state === 'ok' ? '✓' : state === 'error' ? '✗' : state === 'waiting' ? 'needs approval' : '';
  }

  function createToolCard(name, args, id, { readOnly = false } = {}) {
    const block = document.createElement('div');
    block.className = 'tool-block';
    if (id) block.dataset.callId = id;
    if (readOnly) block.dataset.readOnly = '1';
    const header = document.createElement('div');
    header.className = 'tool-header';
    header.innerHTML =
      `<span class="icon">${TOOL_ICONS[name] || '🔧'}</span><span class="name">${escapeHtml(name)}</span>` +
      `<span class="args">${escapeHtml(summarizeArgs(name, args))}</span>` +
      `<span class="status running"></span><span class="collapse-hint">▾</span>`;
    header.title = JSON.stringify(args || {}, null, 2).slice(0, 2000);
    header.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      block.classList.toggle('collapsed');
    });
    block.appendChild(header);
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
      bindLinks(el);
    } else if (currentAssistantEl) {
      currentAssistantEl.remove();
    }
    finishThinking();
    currentAssistantEl = null;
    currentAssistantBuf = '';
    const block = createToolCard(name, args, id, { readOnly });
    setWorking(`Running ${name}…`);
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
      viewBtn.className = 'view-diff';
      viewBtn.textContent = 'Open Diff Editor';
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
      if (approved) setWorking(`Running ${name}…`);
      vscode.postMessage({ type: 'approve', id, approved });
    }

    approveBtn.onclick = () => resolve(true);
    rejectBtn.onclick = () => resolve(false);
    row.appendChild(approveBtn);
    row.appendChild(rejectBtn);
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
    // A rejected/cancelled card already says so; the "User declined" text
    // that goes back to the model would only repeat it.
    if (block.dataset.verdict === 'rejected' || block.dataset.verdict === 'cancelled') return;

    // Auto-approved edits skip the approval step, so this is the first
    // chance to show what actually changed — same diff view either way.
    appendDiff(block, diffView);

    const body = document.createElement('div');
    body.className = 'tool-body result' + (isError ? ' error' : '');
    body.textContent = result;
    block.appendChild(body);

    // Successful reads are reference material, not news: keep the card to
    // its header so the transcript stays readable. Errors stay open.
    if (block.dataset.readOnly && !isError) block.classList.add('collapsed');

    if (revertAvailable && id) {
      const footer = document.createElement('div');
      footer.className = 'tool-footer';
      const revertBtn = document.createElement('button');
      revertBtn.className = 'revert-btn';
      revertBtn.textContent = '↩ Revert this change';
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
    const card = [...cards].reverse().find((c) => c.querySelector('.name')?.textContent === 'delegate_task');
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
    document.getElementById('composer').insertBefore(chip, inputEl);
  }

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

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  inputEl.addEventListener('keydown', (e) => {
    if (mentionMenuKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' && busy) {
      vscode.postMessage({ type: 'stop' });
    }
  });

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
  document.getElementById('composer').appendChild(mentionMenu);

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
    updateMentionMenu();
  });
  inputEl.addEventListener('click', updateMentionMenu);
  inputEl.addEventListener('blur', () => setTimeout(() => mentionMenu.classList.add('hidden'), 150));

  // ---------- Plan/Act mode ----------
  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'setMode', mode: btn.dataset.mode });
    });
  });

  function setModeUI(mode) {
    modeButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
    inputEl.placeholder =
      mode === 'plan'
        ? 'Ask Cortex to investigate and propose a plan (no changes will be made)... @ to attach a file'
        : 'Ask Cortex to do something... @ to attach a file, Enter to send, Shift+Enter for a new line';
  }

  // ---------- Manual/Auto approval toggle ----------
  approveButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'setAutoApprove', enabled: btn.dataset.approve === 'auto' });
    });
  });

  function setApproveUI(autoApprove) {
    approveButtons.forEach((btn) => btn.classList.toggle('active', (btn.dataset.approve === 'auto') === !!autoApprove));
  }

  // ---------- History / Approvals / Memory panels ----------
  function closePanels() {
    historyPanel.classList.add('hidden');
    approvalsPanel.classList.add('hidden');
    memoryPanel.classList.add('hidden');
  }

  historyBtn.addEventListener('click', () => {
    const willOpen = historyPanel.classList.contains('hidden');
    closePanels();
    if (willOpen) {
      vscode.postMessage({ type: 'listSessions' });
      historyPanel.classList.remove('hidden');
    }
  });

  approvalsBtn.addEventListener('click', () => {
    const willOpen = approvalsPanel.classList.contains('hidden');
    closePanels();
    if (willOpen) approvalsPanel.classList.remove('hidden');
  });

  memoryBtn.addEventListener('click', () => {
    const willOpen = memoryPanel.classList.contains('hidden');
    closePanels();
    if (willOpen) {
      vscode.postMessage({ type: 'getMemory' });
      memoryPanel.classList.remove('hidden');
    }
  });

  function renderSessions(items, currentId) {
    historyPanel.innerHTML = '<div class="panel-title">Chat History</div>';
    if (!items.length) {
      historyPanel.innerHTML += '<div class="panel-empty">No previous chats yet.</div>';
      return;
    }
    const list = document.createElement('div');
    list.className = 'session-list';
    for (const s of items) {
      const row = document.createElement('div');
      row.className = 'session-row' + (s.id === currentId ? ' current' : '');
      const info = document.createElement('div');
      info.className = 'session-info';
      const title = document.createElement('div');
      title.className = 'session-title';
      title.textContent = s.title || 'New chat';
      const date = document.createElement('div');
      date.className = 'session-date';
      date.textContent = new Date(s.updatedAt).toLocaleString();
      info.appendChild(title);
      info.appendChild(date);
      info.addEventListener('click', () => {
        vscode.postMessage({ type: 'loadSession', id: s.id });
        closePanels();
      });
      const del = document.createElement('button');
      del.className = 'session-delete';
      del.textContent = '🗑';
      del.title = 'Delete this chat';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteSession', id: s.id });
      });
      row.appendChild(info);
      row.appendChild(del);
      list.appendChild(row);
    }
    historyPanel.appendChild(list);
  }

  // ---------- Auto-approve panel ----------
  function renderApprovals(toolNames, enabled) {
    approvalsPanel.innerHTML = '<div class="panel-title">Auto-approve per action</div>';
    const note = document.createElement('div');
    note.className = 'panel-note';
    note.textContent =
      'When checked, Cortex will run this action without asking. The Auto switch overrides all of these. Dangerous commands (rm -rf, sudo, force-push, …) always ask.';
    approvalsPanel.appendChild(note);
    for (const name of toolNames) {
      const row = document.createElement('label');
      row.className = 'approval-toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = enabled.includes(name);
      checkbox.addEventListener('change', () => {
        vscode.postMessage({ type: 'setAutoApproveTool', name, enabled: checkbox.checked });
      });
      const label = document.createElement('span');
      label.textContent = `${TOOL_ICONS[name] || '🔧'} ${name}`;
      row.appendChild(checkbox);
      row.appendChild(label);
      approvalsPanel.appendChild(row);
    }
  }

  // ---------- Memory panel ----------
  // Shows exactly what's in .cortex/MEMORY.md — the durable notes Cortex
  // injects into every system prompt — and lets the user read/edit it
  // directly instead of it being an invisible black box.
  function renderMemory(content) {
    memoryPanel.innerHTML = '<div class="panel-title">Memory (.cortex/MEMORY.md)</div>';
    const note = document.createElement('div');
    note.className = 'panel-note';
    note.textContent = "This is injected into every message so Cortex remembers it across chats and restarts. Edit freely, or let Cortex's \"remember\" tool add to it.";
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
      saveBtn.textContent = 'Saved ✓';
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
        bindLinks(div);
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
        modelBadge.textContent = msg.model;
        setApproveUI(msg.autoApprove);
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
        label.textContent = `checkpoint · ${msg.count} file change${msg.count === 1 ? '' : 's'}`;
        const btn = document.createElement('button');
        btn.textContent = 'Rewind here';
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
        renderSessionStats();
        showEmptyState();
        break;
      default:
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
  showEmptyState();
}());
