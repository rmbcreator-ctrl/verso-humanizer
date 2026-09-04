(() => {
  const gate = document.getElementById('gate');
  const panel = document.getElementById('panel');
  const gateForm = document.getElementById('gateForm');
  const gatePassword = document.getElementById('gatePassword');
  const gateError = document.getElementById('gateError');

  const saveStatus = document.getElementById('saveStatus');
  const saveBtn = document.getElementById('saveBtn');
  const resetBtn = document.getElementById('resetBtn');
  const logoutBtn = document.getElementById('logoutBtn');

  const fields = {
    apiKey1: document.getElementById('apiKey1'),
    apiKey2: document.getElementById('apiKey2'),
    apiKey3: document.getElementById('apiKey3'),
    apiKey4: document.getElementById('apiKey4'),
    apiKey5: document.getElementById('apiKey5'),
    modelMain: document.getElementById('modelMain'),
    modelFlash: document.getElementById('modelFlash'),
    modelLite: document.getElementById('modelLite'),
    maxChunkChars: document.getElementById('maxChunkChars'),
    tempExtract: document.getElementById('tempExtract'),
    tempDraft: document.getElementById('tempDraft'),
    topPDraft: document.getElementById('topPDraft'),
    tempGuard: document.getElementById('tempGuard'),
    promptExtract: document.getElementById('promptExtract'),
    promptDraft: document.getElementById('promptDraft'),
    promptGuard: document.getElementById('promptGuard'),
    intensityLight: document.getElementById('intensityLight'),
    intensityBalanced: document.getElementById('intensityBalanced'),
    intensityThorough: document.getElementById('intensityThorough'),
    bannedPhrases: document.getElementById('bannedPhrases'),
  };

  function configToFields(config) {
    const keys = config.apiKeys || [];
    fields.apiKey1.value = keys[0] || '';
    fields.apiKey2.value = keys[1] || '';
    fields.apiKey3.value = keys[2] || '';
    fields.apiKey4.value = keys[3] || '';
    fields.apiKey5.value = keys[4] || '';
    fields.modelMain.value = config.models.main || '';
    fields.modelFlash.value = config.models.flash || '';
    fields.modelLite.value = config.models.lite || '';
    fields.maxChunkChars.value = config.chunking.maxChunkChars;
    fields.tempExtract.value = config.generation.extract.temperature;
    fields.tempDraft.value = config.generation.draft.temperature;
    fields.topPDraft.value = config.generation.draft.topP;
    fields.tempGuard.value = config.generation.guard.temperature;
    fields.promptExtract.value = config.prompts.extract || '';
    fields.promptDraft.value = config.prompts.draft || '';
    fields.promptGuard.value = config.prompts.guard || '';
    fields.intensityLight.value = config.intensity.light || '';
    fields.intensityBalanced.value = config.intensity.balanced || '';
    fields.intensityThorough.value = config.intensity.thorough || '';
    fields.bannedPhrases.value = (config.bannedPhrases || []).join(', ');
  }

  function fieldsToConfig() {
    return {
      apiKeys: [fields.apiKey1, fields.apiKey2, fields.apiKey3, fields.apiKey4, fields.apiKey5]
        .map((f) => f.value.trim())
        .filter(Boolean),
      models: {
        main: fields.modelMain.value.trim(),
        flash: fields.modelFlash.value.trim(),
        lite: fields.modelLite.value.trim(),
      },
      chunking: {
        maxChunkChars: Number(fields.maxChunkChars.value) || 1400,
      },
      generation: {
        extract: { temperature: Number(fields.tempExtract.value) },
        draft: { temperature: Number(fields.tempDraft.value), topP: Number(fields.topPDraft.value) },
        guard: { temperature: Number(fields.tempGuard.value) },
      },
      prompts: {
        extract: fields.promptExtract.value,
        draft: fields.promptDraft.value,
        guard: fields.promptGuard.value,
      },
      intensity: {
        light: fields.intensityLight.value,
        balanced: fields.intensityBalanced.value,
        thorough: fields.intensityThorough.value,
      },
      bannedPhrases: fields.bannedPhrases.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }

  function showPanel(config) {
    gate.hidden = true;
    panel.hidden = false;
    configToFields(config);
  }

  function showGate() {
    gate.hidden = false;
    panel.hidden = true;
  }

  async function loadSettings() {
    const res = await fetch('/api/settings');
    if (res.status === 401) {
      showGate();
      return;
    }
    const data = await res.json();
    showPanel(data.config);
  }

  async function checkSession() {
    const res = await fetch('/api/settings/session');
    const data = await res.json();
    if (data.authenticated) {
      await loadSettings();
    } else {
      showGate();
    }
  }

  gateForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    gateError.hidden = true;
    const submitBtn = gateForm.querySelector('button');
    submitBtn.disabled = true;
    try {
      const res = await fetch('/api/settings/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: gatePassword.value }),
      });
      const data = await res.json();
      if (!res.ok) {
        gateError.textContent = data.error || 'Incorrect password.';
        gateError.hidden = false;
        gatePassword.value = '';
        gatePassword.focus();
        return;
      }
      gatePassword.value = '';
      await loadSettings();
    } catch (err) {
      gateError.textContent = 'Could not reach the server.';
      gateError.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });

  document.querySelectorAll('.toggle-key').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  function setStatus(text, kind) {
    saveStatus.textContent = text;
    saveStatus.className = 'save-status' + (kind ? ` is-${kind}` : '');
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    setStatus('Saving…');
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fieldsToConfig()),
      });
      if (res.status === 401) {
        showGate();
        return;
      }
      const data = await res.json();
      configToFields(data.config);
      setStatus('Saved just now.', 'success');
    } catch (err) {
      setStatus('Save failed — could not reach the server.', 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  resetBtn.addEventListener('click', async () => {
    if (!confirm('Reset every prompt, model, and parameter to Verso\'s defaults? This cannot be undone.')) return;
    resetBtn.disabled = true;
    setStatus('Resetting…');
    try {
      const res = await fetch('/api/settings/reset', { method: 'POST' });
      if (res.status === 401) {
        showGate();
        return;
      }
      const data = await res.json();
      configToFields(data.config);
      setStatus('Reset to defaults.', 'success');
    } catch (err) {
      setStatus('Reset failed — could not reach the server.', 'error');
    } finally {
      resetBtn.disabled = false;
    }
  });

  logoutBtn.addEventListener('click', async () => {
    await fetch('/api/settings/logout', { method: 'POST' });
    showGate();
  });

  // ---------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------
  const tabBtns = Array.from(document.querySelectorAll('.tab-btn'));
  const tabSettings = document.getElementById('tabSettings');
  const tabHistory = document.getElementById('tabHistory');

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabBtns.forEach((b) => b.classList.toggle('is-active', b === btn));
      const isHistory = btn.dataset.tab === 'history';
      tabSettings.hidden = isHistory;
      tabHistory.hidden = !isHistory;
      if (isHistory && !historyLoadedOnce) loadHistory();
    });
  });

  // ---------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------
  const historyList = document.getElementById('historyList');
  const historyStatus = document.getElementById('historyStatus');
  const historyRefreshBtn = document.getElementById('historyRefreshBtn');
  const historyClearBtn = document.getElementById('historyClearBtn');
  const historyCountLabel = document.getElementById('historyCountLabel');

  const historyModal = document.getElementById('historyModal');
  const modalTimestamp = document.getElementById('modalTimestamp');
  const modalMeta = document.getElementById('modalMeta');
  const modalOriginal = document.getElementById('modalOriginal');
  const modalHumanized = document.getElementById('modalHumanized');
  const modalCloseBtn = document.getElementById('modalCloseBtn');
  const modalDownloadBtn = document.getElementById('modalDownloadBtn');
  const modalDeleteBtn = document.getElementById('modalDeleteBtn');

  let historyLoadedOnce = false;
  let currentEntries = [];
  let openEntry = null;

  function formatTimestamp(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    } catch {
      return iso;
    }
  }

  function firstLine(text, max) {
    const line = (text || '').replace(/\s+/g, ' ').trim();
    return line.length > max ? line.slice(0, max - 1) + '…' : line;
  }

  async function loadHistory() {
    historyLoadedOnce = true;
    historyList.innerHTML = '<p class="history-empty">Loading…</p>';
    try {
      // No limit param — fetches the entire, unbounded history in one go.
      const res = await fetch('/api/settings/history');
      if (res.status === 401) {
        showGate();
        return;
      }
      const data = await res.json();
      currentEntries = data.entries;
      renderHistoryList();
    } catch (err) {
      historyList.innerHTML = '<p class="history-empty">Could not load history.</p>';
    }
  }

  function renderHistoryList() {
    if (historyCountLabel) {
      historyCountLabel.textContent = currentEntries.length
        ? `${currentEntries.length} conversion${currentEntries.length === 1 ? '' : 's'}`
        : '';
    }

    if (!currentEntries.length) {
      historyList.innerHTML = '<p class="history-empty">No conversions yet — run something through Verso and it will show up here.</p>';
      return;
    }

    historyList.innerHTML = '';
    for (const entry of currentEntries) {
      const row = document.createElement('div');
      row.className = 'history-row';

      const main = document.createElement('div');
      main.className = 'history-row-main';
      const time = document.createElement('div');
      time.className = 'history-row-time';
      time.textContent = formatTimestamp(entry.timestamp);
      const preview = document.createElement('div');
      preview.className = 'history-row-preview';
      preview.textContent = firstLine(entry.humanized || entry.original, 110);
      main.appendChild(time);
      main.appendChild(preview);

      const meta = document.createElement('div');
      meta.className = 'history-row-meta';

      const badge = document.createElement('span');
      badge.className = 'history-badge' + (entry.hadError ? ' is-error' : '');
      badge.textContent = entry.hadError ? 'partial' : entry.intensity;
      meta.appendChild(badge);

      const words = document.createElement('span');
      words.className = 'history-row-words';
      words.textContent = `${entry.wordsBefore} → ${entry.wordsAfter} words`;
      meta.appendChild(words);

      const del = document.createElement('button');
      del.className = 'history-row-delete';
      del.title = 'Delete this entry';
      del.textContent = '✕';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteEntry(entry.id);
      });
      meta.appendChild(del);

      row.appendChild(main);
      row.appendChild(meta);
      row.addEventListener('click', () => openModal(entry));

      historyList.appendChild(row);
    }
  }

  historyRefreshBtn.addEventListener('click', () => loadHistory());

  historyClearBtn.addEventListener('click', async () => {
    if (!confirm('Delete all conversion history? This cannot be undone.')) return;
    try {
      await fetch('/api/settings/history', { method: 'DELETE' });
      historyOffset = 0;
      loadHistory();
    } catch (err) {
      historyStatus.textContent = 'Could not clear history.';
    }
  });

  async function deleteEntry(id) {
    try {
      await fetch(`/api/settings/history/${id}`, { method: 'DELETE' });
      loadHistory();
    } catch (err) {
      historyStatus.textContent = 'Could not delete that entry.';
    }
  }

  function openModal(entry) {
    openEntry = entry;
    modalTimestamp.textContent = formatTimestamp(entry.timestamp);
    modalMeta.textContent = `${entry.intensity}${entry.hadError ? ' · partial (one or more passages failed)' : ''} · ${entry.wordsBefore} → ${entry.wordsAfter} words`;
    modalOriginal.textContent = entry.original;
    modalHumanized.textContent = entry.humanized;
    historyModal.hidden = false;
  }

  function closeModal() {
    historyModal.hidden = true;
    openEntry = null;
  }

  modalCloseBtn.addEventListener('click', closeModal);
  historyModal.addEventListener('click', (e) => {
    if (e.target === historyModal) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !historyModal.hidden) closeModal();
  });

  document.querySelectorAll('.modal-copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!openEntry) return;
      const text = btn.dataset.target === 'original' ? openEntry.original : openEntry.humanized;
      try {
        await navigator.clipboard.writeText(text);
        const label = btn.querySelector('.btn-text');
        const old = label.textContent;
        label.textContent = 'Copied';
        btn.classList.add('is-done');
        setTimeout(() => {
          label.textContent = old;
          btn.classList.remove('is-done');
        }, 1200);
      } catch {}
    });
  });

  modalDownloadBtn.addEventListener('click', () => {
    if (!openEntry) return;
    const blob = new Blob([openEntry.humanized], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `verso-${openEntry.timestamp.slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  modalDeleteBtn.addEventListener('click', async () => {
    if (!openEntry) return;
    if (!confirm('Delete this history entry?')) return;
    await deleteEntry(openEntry.id);
    closeModal();
  });

  checkSession();
})();
