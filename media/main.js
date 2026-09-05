(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const bannerEl = document.getElementById('banner');
  const modelBadge = document.getElementById('model-badge');
  const sessionStatsEl = document.getElementById('session-stats');
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
    sessionStatsEl.textContent = parts.join(' \u00b7 ');
  }

  // ---------- tiny, dependency-free markdown renderer ----------
  // Supports: fenced code blocks, inline code, bold/italic, headings,
  // bullet/numbered lists, links. Escapes HTML first so nothing else in the
  // text can inject markup.
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderInline(text) {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="#" data-href="$2" class="md-link">$1</a>');
    return s;
  }

  function renderMarkdown(text) {
    const lines = String(text || '').split('\n');
    let html = '';
    let i = 0;
    let inList = null; // 'ul' | 'ol'

    function closeList() {
      if (inList) {
        html += inList === 'ul' ? '</ul>' : '</ol>';
        inList = null;
      }
    }

    while (i < lines.length) {
      const line = lines[i];

      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        closeList();
        const lang = fence[1] || '';
        const codeLines = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        html += `<pre class="md-code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`;
        continue;
      }

      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        closeList();
        const level = heading[1].length;
        html += `<h${level} class="md-h">${renderInline(heading[2])}</h${level}>`;
        i++;
        continue;
      }

      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        if (inList !== 'ul') {
          closeList();
          html += '<ul class="md-list">';
          inList = 'ul';
        }
        html += `<li>${renderInline(bullet[1])}</li>`;
        i++;
        continue;
      }

      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (numbered) {
        if (inList !== 'ol') {
          closeList();
          html += '<ol class="md-list">';
          inList = 'ol';
        }
        html += `<li>${renderInline(numbered[1])}</li>`;
        i++;
        continue;
      }

      closeList();
      if (line.trim() === '') {
        html += '<div class="md-br"></div>';
      } else {
        html += `<p class="md-p">${renderInline(line)}</p>`;
      }
      i++;
    }
    closeList();
    return html;
  }

  function bindLinks(container) {
    container.querySelectorAll('a.md-link').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({ type: 'openExternal', url: a.dataset.href });
      });
    });
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
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
      <div class="empty-sub">It can read, write, and run code in this workspace. Try "list the files here" to start.</div>
    `;
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
    if (image) {
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
    messagesEl.appendChild(div);
    currentAssistantEl = null;
    currentAssistantBuf = '';
    scrollToBottom();
  }

  function addSystemNote(text) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.textContent = text;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function ensureAssistantBubble() {
    if (!currentAssistantEl) {
      currentAssistantEl = document.createElement('div');
      currentAssistantEl.className = 'msg assistant';
      messagesEl.appendChild(currentAssistantEl);
    }
    return currentAssistantEl;
  }

  function appendToken(text) {
    currentAssistantBuf += text;
    const el = ensureAssistantBubble();
    el.innerHTML = renderMarkdown(currentAssistantBuf);
    bindLinks(el);
    scrollToBottom();
  }

  function finalizeAssistant(text, steps, elapsedMs) {
    const el = ensureAssistantBubble();
    const finalContent = text || currentAssistantBuf;
    el.innerHTML = renderMarkdown(finalContent);
    bindLinks(el);
    if (typeof elapsedMs === 'number') {
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

  const TOOL_ICONS = {
    read_file: '📖',
    write_file: '📝',
    edit_file: '✏️',
    list_dir: '📁',
    search_code: '🔍',
    run_command: '⚡',
    remember: '🧠',
  };

  // Returns { html, add, del } — a cheap line-level diff (no LCS), good
  // enough for the small, targeted edits this agent makes.
  function diffHtmlAndStats(diff) {
    if (!diff || diff.error) return null;
    const before = (diff.before || '').split('\n');
    const after = (diff.after || '').split('\n');
    if (before.join('\n') === after.join('\n')) {
      return { html: '<div class="diff-line">(no changes)</div>', add: 0, del: 0 };
    }
    let html = '';
    let add = 0;
    let del = 0;
    const max = Math.max(before.length, after.length);
    let sameCount = 0;
    for (let i = 0; i < max; i++) {
      if (before[i] === after[i]) sameCount++;
    }
    if (sameCount / max > 0.4) {
      for (let i = 0; i < max; i++) {
        if (before[i] === after[i]) {
          if (before[i] !== undefined) html += `<span class="diff-line">  ${escapeHtml(before[i])}</span>\n`;
        } else {
          if (before[i] !== undefined) {
            html += `<span class="diff-line diff-del">- ${escapeHtml(before[i])}</span>\n`;
            del++;
          }
          if (after[i] !== undefined) {
            html += `<span class="diff-line diff-add">+ ${escapeHtml(after[i])}</span>\n`;
            add++;
          }
        }
      }
    } else {
      html += before.map((l) => `<span class="diff-line diff-del">- ${escapeHtml(l)}</span>`).join('\n');
      html += '\n';
      html += after.map((l) => `<span class="diff-line diff-add">+ ${escapeHtml(l)}</span>`).join('\n');
      del = before.length;
      add = after.length;
    }
    return { html, add, del };
  }

  function setStatPill(block, add, del) {
    const header = block.querySelector('.tool-header');
    if (!header || (!add && !del)) return;
    let pill = header.querySelector('.stat-pill');
    if (!pill) {
      pill = document.createElement('span');
      pill.className = 'stat-pill';
      header.insertBefore(pill, header.querySelector('.collapse-hint'));
    }
    pill.innerHTML = `${add ? `<span class="stat-add">+${add}</span>` : ''}${del ? `<span class="stat-del">-${del}</span>` : ''}`;
  }

  function addToolCall(name, args, id) {
    // The streaming bubble was filled live with the model's raw output,
    // which includes the literal "TOOL_CALL: {...}" line now being replaced
    // by the clean card below — left as-is it duplicates as ugly raw JSON
    // text in the transcript. Keep any real commentary the model wrote
    // before the marker, discard the rest.
    if (currentAssistantEl) {
      const idx = currentAssistantBuf.indexOf('TOOL_CALL:');
      const commentary = (idx === -1 ? currentAssistantBuf : currentAssistantBuf.slice(0, idx)).trim();
      if (commentary) {
        currentAssistantEl.innerHTML = renderMarkdown(commentary);
        bindLinks(currentAssistantEl);
      } else {
        currentAssistantEl.remove();
      }
    }
    currentAssistantEl = null;
    currentAssistantBuf = '';
    const block = document.createElement('div');
    block.className = 'tool-block';
    if (id) block.dataset.callId = id;
    const header = document.createElement('div');
    header.className = 'tool-header';
    header.innerHTML = `<span class="icon">${TOOL_ICONS[name] || '🔧'}</span><span class="name">${escapeHtml(name)}</span><span class="args">${escapeHtml(JSON.stringify(args || {}))}</span><span class="collapse-hint">▾</span>`;
    header.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      block.classList.toggle('collapsed');
    });
    block.appendChild(header);
    messagesEl.appendChild(block);
    scrollToBottom();
    return block;
  }

  function findToolBlock(id) {
    if (!id) return null;
    return messagesEl.querySelector(`.tool-block[data-call-id="${id}"]`);
  }

  function addApprovalUI(id, name, args, preview, diffId) {
    // The 'toolCall' event (fired first, for every call) already created
    // this card — reuse it instead of spawning a duplicate.
    const block = findToolBlock(id) || addToolCall(name, args, id);

    if (preview && !preview.error) {
      const diffResult = diffHtmlAndStats(preview);
      if (diffResult) {
        const body = document.createElement('div');
        body.className = 'tool-body';
        body.innerHTML = diffResult.html;
        block.appendChild(body);
        setStatPill(block, diffResult.add, diffResult.del);
      }
    } else if (preview && preview.error) {
      const body = document.createElement('div');
      body.className = 'tool-body error';
      body.textContent = preview.error;
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
      row.classList.add('resolved');
      const verdict = document.createElement('span');
      verdict.className = 'verdict';
      verdict.textContent = approved ? 'Approved' : 'Rejected';
      row.innerHTML = '';
      row.appendChild(verdict);
      vscode.postMessage({ type: 'approve', id, approved });
    }

    approveBtn.onclick = () => resolve(true);
    rejectBtn.onclick = () => resolve(false);
    row.appendChild(approveBtn);
    row.appendChild(rejectBtn);
    block.appendChild(row);
    scrollToBottom();
  }

  function addToolResult(result, isError, id, revertAvailable, diff) {
    if (!id) {
      addSystemNote(`⚠ ${result}`);
      return;
    }
    const block = findToolBlock(id);
    if (!block) return;
    if (block.querySelector('.approval-row')) return; // already resolved visually

    // Auto-approved edits skip the approval step, so this is the first
    // chance to show what actually changed — same diff view either way.
    if (diff && !diff.error) {
      const diffResult = diffHtmlAndStats(diff);
      if (diffResult) {
        const diffBody = document.createElement('div');
        diffBody.className = 'tool-body';
        diffBody.innerHTML = diffResult.html;
        block.appendChild(diffBody);
        setStatPill(block, diffResult.add, diffResult.del);
      }
    }

    const body = document.createElement('div');
    body.className = 'tool-body' + (isError ? ' error' : '');
    body.textContent = result;
    block.appendChild(body);

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
    scrollToBottom();
  }

  function markReverted(id, path) {
    const block = findToolBlock(id);
    if (!block) return;
    const footer = block.querySelector('.tool-footer');
    if (footer) footer.innerHTML = `<span class="verdict">Reverted ${escapeHtml(path)}</span>`;
  }

  function setBusy(value) {
    busy = value;
    sendBtn.classList.toggle('hidden', value);
    stopBtn.classList.toggle('hidden', !value);
    inputEl.disabled = value;
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

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

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
        ? 'Ask Cortex to investigate and propose a plan (no changes will be made)...'
        : 'Ask Cortex to do something in this workspace...';
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
    note.textContent = 'When checked, Cortex will run this action without asking. Global "autoApprove" setting overrides all of these.';
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

  function restoreSession(messages) {
    messagesEl.innerHTML = '';
    currentAssistantEl = null;
    currentAssistantBuf = '';
    if (!messages.length) {
      addSystemNote('(empty chat)');
      return;
    }
    for (const m of messages) {
      if (m.role === 'user') addUserMessage(m.text);
      else if (m.role === 'assistant') {
        const div = document.createElement('div');
        div.className = 'msg assistant';
        div.innerHTML = renderMarkdown(m.text);
        bindLinks(div);
        messagesEl.appendChild(div);
      } else addSystemNote(m.text);
    }
    scrollToBottom();
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
        inputEl.value = msg.text + (inputEl.value ? '\n' + inputEl.value : '');
        inputEl.focus();
        inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
        break;
      case 'testRun': {
        const div = document.createElement('div');
        div.className = 'msg system' + (msg.failed ? ' test-fail' : ' test-pass');
        div.textContent = `${msg.failed ? '✗' : '✓'} ${msg.command}\n${msg.result.slice(0, 400)}`;
        messagesEl.appendChild(div);
        scrollToBottom();
        break;
      }
      case 'userMessage':
        addUserMessage(msg.text, msg.image);
        break;
      case 'token':
        appendToken(msg.text);
        break;
      case 'checkpointCreated': {
        const div = document.createElement('div');
        div.className = 'checkpoint-marker';
        const label = document.createElement('span');
        label.textContent = `checkpoint \u00b7 ${msg.count} file change${msg.count === 1 ? '' : 's'}`;
        const btn = document.createElement('button');
        btn.textContent = 'Rewind here';
        btn.title = 'Restore files and conversation to just before this turn';
        btn.onclick = () => {
          btn.disabled = true;
          vscode.postMessage({ type: 'rewindTo', checkpointId: msg.id });
        };
        div.appendChild(label);
        div.appendChild(btn);
        messagesEl.appendChild(div);
        scrollToBottom();
        break;
      }
      case 'rewound':
        restoreSession(msg.messages);
        addSystemNote(`Rewound \u2014 restored ${msg.paths.length} file(s): ${msg.paths.join(', ') || 'none'}`);
        break;
      case 'dangerWarning': {
        const block = findToolBlock(msg.id);
        const warn = document.createElement('div');
        warn.className = 'danger-warning';
        warn.textContent = `\u26a0 Flagged as dangerous: ${msg.why}. This can never be auto-approved.`;
        (block || messagesEl).appendChild(warn);
        scrollToBottom();
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
        addToolCall(msg.name, msg.args, msg.id);
        sessionStats.toolCalls++;
        renderSessionStats();
        break;
      case 'needsApproval':
        addApprovalUI(msg.id, msg.name, msg.args, msg.preview, msg.diffId);
        break;
      case 'toolResult':
        addToolResult(msg.result, msg.isError, msg.id, msg.revertAvailable, msg.diff);
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
        addSystemNote(`⚠ ${msg.text}`);
        currentAssistantEl = null;
        currentAssistantBuf = '';
        break;
      case 'busy':
        setBusy(msg.value);
        break;
      case 'cleared':
        messagesEl.innerHTML = '';
        currentAssistantEl = null;
        currentAssistantBuf = '';
        showEmptyState();
        break;
      default:
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
  showEmptyState();
}());
