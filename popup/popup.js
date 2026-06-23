/**
 * Popup UI: connect to background, render status, handle actions.
 */

const $ = (id) => document.getElementById(id);

async function getStatus() {
  return chrome.runtime.sendMessage({ type: 'GET_STATUS' });
}

function renderProfile(s) {
  const id = s.profileId || '';
  const status = $('profile-status');
  const input = $('profile-id');
  if (id) {
    status.textContent = `✓ ${id}`;
    status.className = 'profile-status profile-status--set';
    input.value = id;
  } else {
    status.textContent = 'not set';
    status.className = 'profile-status profile-status--unset';
  }
}

function renderChannels(s) {
  const list = $('channel-list');
  const count = $('channel-count');
  count.textContent = `${(s.channels || []).length}/${s.maxChannels || 10}`;
  if (!s.channels || s.channels.length === 0) {
    list.innerHTML = '<div class="empty-state">No channels yet. Add 5–10 competitors below.</div>';
    return;
  }
  list.innerHTML = '';
  for (const ch of s.channels) {
    const item = document.createElement('div');
    item.className = 'channel-item';
    const ageText = ch.lastRefresh ? `${Math.round((Date.now() - new Date(ch.lastRefresh).getTime()) / 3600000)}h ago` : 'never';
    item.innerHTML = `
      <div class="channel-row">
        <div class="channel-info">
          <div class="channel-name">${escapeHtml(ch.displayName || ch.handle)}</div>
          <div class="channel-meta">
            <span class="niche-tag">${escapeHtml(ch.niche || '—')}</span>
            <span>${(ch.videos || []).length} videos</span>
            <span>refreshed ${ageText}</span>
            <span>${Math.round((ch.confidence || 0) * 100)}%</span>
          </div>
        </div>
        <div class="channel-actions">
          <button data-action="refresh" data-id="${ch.id}" title="Re-detect this channel">↻</button>
          <button data-action="remove" data-id="${ch.id}" class="remove" title="Remove">✕</button>
        </div>
      </div>
    `;
    list.appendChild(item);
  }
  // Attach handlers
  list.querySelectorAll('button[data-action="refresh"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '…';
      await chrome.runtime.sendMessage({ type: 'REFRESH_CHANNEL', channelId: btn.dataset.id });
      setTimeout(render, 500);
    });
  });
  list.querySelectorAll('button[data-action="remove"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Remove this channel?`)) return;
      await chrome.runtime.sendMessage({ type: 'REMOVE_CHANNEL', channelId: btn.dataset.id });
      setTimeout(render, 500);
    });
  });
}

function renderNiches(s) {
  const list = $('niche-list');
  const count = $('niche-count');
  const builtIn = s.builtInNiches || [];
  const custom = s.customNiches || {};
  const customIds = Object.keys(custom);
  const hiddenIds = new Set(s.deletedBuiltInNiches || []);
  const visibleBuiltIn = builtIn.filter((n) => !hiddenIds.has(n.id));
  count.textContent = `${visibleBuiltIn.length + customIds.length}`;
  // Niche select dropdown for "Add channel"
  const sel = $('niche-select');
  if (sel) {
    const currentVal = sel.value || '__none__';
    // Default = "No niche (just watch their videos)"
    sel.innerHTML = '';
    const optNone = document.createElement('option');
    optNone.value = '__none__';
    optNone.textContent = 'No niche (default)';
    sel.appendChild(optNone);
    const optAuto = document.createElement('option');
    optAuto.value = '';
    optAuto.textContent = 'Auto-detect from videos';
    sel.appendChild(optAuto);
    if (visibleBuiltIn.length) {
      const og = document.createElement('optgroup');
      og.label = 'Default';
      for (const n of visibleBuiltIn) {
        const o = document.createElement('option');
        o.value = n.id;
        o.textContent = n.label;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    if (customIds.length) {
      const og = document.createElement('optgroup');
      og.label = 'My niches';
      for (const id of customIds) {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = custom[id].label;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    sel.value = currentVal;
  }
  // Niche list
  list.innerHTML = '';
  // If there are hidden defaults, show a "Restore" row at the top
  if (hiddenIds.size > 0) {
    const restore = document.createElement('div');
    restore.className = 'niche-restore';
    const hiddenLabels = builtIn
      .filter((n) => hiddenIds.has(n.id))
      .map((n) => n.label)
      .join(', ');
    restore.innerHTML = `
      <div class="niche-restore-text">
        <span class="niche-source niche-source--hidden">hidden</span>
        ${hiddenIds.size} default${hiddenIds.size === 1 ? '' : 's'} hidden: <b>${escapeHtml(hiddenLabels)}</b>
      </div>
      <div class="niche-actions">
        <button data-action="restore-all-defaults" class="btn btn-tiny">Restore all</button>
      </div>
    `;
    list.appendChild(restore);
  }
  for (const n of visibleBuiltIn) {
    const item = document.createElement('div');
    item.className = 'niche-item default';
    item.innerHTML = `
      <div class="niche-row">
        <div class="niche-info">
          <span class="niche-label">${escapeHtml(n.label)}</span>
          <span class="niche-id">${escapeHtml(n.id)}</span>
          <span class="niche-source">default</span>
        </div>
        <div class="niche-keywords">${escapeHtml(n.keywords.join(', '))}</div>
        <div class="niche-actions">
          <button data-action="delete-niche" data-id="${escapeHtml(n.id)}" class="remove" title="Remove this default niche">✕</button>
        </div>
      </div>
    `;
    list.appendChild(item);
  }
  for (const id of customIds) {
    const n = custom[id];
    const item = document.createElement('div');
    item.className = 'niche-item user';
    item.innerHTML = `
      <div class="niche-row">
        <div class="niche-info">
          <span class="niche-label">${escapeHtml(n.label)}</span>
          <span class="niche-id">${escapeHtml(id)}</span>
          <span class="niche-source niche-source--user">yours</span>
        </div>
        <div class="niche-keywords">${escapeHtml(n.keywords.join(', '))}</div>
        <div class="niche-actions">
          <button data-action="delete-niche" data-id="${escapeHtml(id)}" class="remove" title="Delete this niche">✕</button>
        </div>
      </div>
    `;
    list.appendChild(item);
  }
  list.querySelectorAll('button[data-action="delete-niche"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const isDefault = visibleBuiltIn.some((n) => n.id === id);
      const msg = isDefault
        ? `Remove default niche "${id}"? You can restore it later from the Niches section.`
        : `Delete niche "${id}"?`;
      if (!confirm(msg)) return;
      await chrome.runtime.sendMessage({ type: 'DELETE_NICHE', nicheId: id });
      setTimeout(render, 500);
    });
  });
  list.querySelectorAll('button[data-action="restore-all-defaults"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Restore all hidden default niches?')) return;
      await chrome.runtime.sendMessage({ type: 'RESTORE_DEFAULT_NICHE', nicheId: 'all' });
      setTimeout(render, 500);
    });
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

async function render() {
  const s = await getStatus();
  if (!s) return;

  $('status-running').textContent = s.running ? '🟢 Running' : '⚪ Stopped';
  $('status-niche').textContent = s.primaryNiche || '—';
  $('status-channels').textContent = `${(s.channels || []).length} / ${s.maxChannels || 10}`;
  $('status-seeds').textContent = `${s.seedsCount} video${s.seedsCount === 1 ? '' : 's'}`;
  $('status-age').textContent = `${s.ageDays} day${s.ageDays === 1 ? '' : 's'}${s.ageDays < 30 ? ' 🌱' : ''}`;
  $('status-hours').textContent = `${s.settings.activeHours.start}:00 – ${s.settings.activeHours.end}:00`;

  $('stat-watch').textContent = s.today.watch || 0;
  $('stat-like').textContent = s.today.like || 0;
  $('stat-comment').textContent = s.today.comment || 0;
  $('stat-sub').textContent = s.today.subscribe || 0;

  const btn = $('btn-toggle');
  if (s.running) {
    btn.textContent = '⏸ Stop nurturing';
    btn.classList.add('running');
  } else {
    btn.textContent = '▶ Start nurturing';
    btn.classList.remove('running');
  }

  const gate = $('gate-info');
  if (s.canAct.allowed) {
    gate.textContent = `✓ OK — ${s.canAct.remaining}/${s.canAct.cap} actions left today`;
    gate.className = 'gate ok';
  } else {
    gate.textContent = `⛔ ${s.canAct.reason}`;
    gate.className = 'gate blocked';
  }
  if (s.lastCheckpointAt) {
    const h = Math.floor((Date.now() - new Date(s.lastCheckpointAt).getTime()) / 3600000);
    gate.textContent += ` · checkpoint ${h}h ago`;
  }

  $('hour-start').value = s.settings.activeHours.start;
  $('hour-end').value = s.settings.activeHours.end;
  $('max-actions').value = s.settings.actionsPerDay.max;

  renderProfile(s);
  renderChannels(s);
  renderNiches(s);

  // Hint when user is visiting a channel not in list
  const lv = s.lastVisitedChannel;
  if (lv && lv.handle) {
    const ageMin = (Date.now() - (lv.at || 0)) / 60000;
    if (ageMin < 30) {
      const exists = (s.channels || []).some((c) => c.handle?.toLowerCase() === lv.handle.toLowerCase());
      if (!exists && (s.channels || []).length < (s.maxChannels || 10)) {
        const hint = $('add-hint');
        if (hint) {
          hint.style.display = 'block';
          hint.innerHTML = `You're on <b>@${escapeHtml(lv.handle)}</b> — not in your list yet. <button id="btn-add-visited">Add to list</button>`;
          const btn = $('btn-add-visited');
          if (btn) {
            btn.onclick = () => {
              $('channel-url').value = lv.url;
              $('channel-url').focus();
              $('btn-add').click();
            };
          }
        }
      }
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  render();

  $('btn-toggle').addEventListener('click', async () => {
    const s = await getStatus();
    await chrome.runtime.sendMessage({ type: 'SET_RUNNING', running: !s.running });
    setTimeout(render, 500);
  });

  $('btn-refresh-all').addEventListener('click', async () => {
    $('btn-refresh-all').disabled = true;
    $('btn-refresh-all').textContent = 'Refreshing all…';
    await chrome.runtime.sendMessage({ type: 'REFRESH_ALL_CHANNELS' });
    $('btn-refresh-all').disabled = false;
    $('btn-refresh-all').textContent = '🔄 Refresh all';
    setTimeout(render, 500);
  });

  // Add this channel (formerly "Detect & Add")
  $('btn-add').addEventListener('click', async () => {
    const url = $('channel-url').value.trim();
    if (!url) {
      $('add-result').textContent = 'Please enter a channel URL';
      $('add-result').className = 'detect-result err';
      return;
    }
    const rawNiche = $('niche-select').value;
    // "__none__" → null (don't tag any niche)
    // ""        → null (auto-detect from video titles)
    // anything else → force this niche
    const niche = rawNiche === '__none__' ? '__none__' : (rawNiche || null);
    let progressLabel;
    if (rawNiche === '__none__') progressLabel = 'Adding… (no niche — will just watch their videos)';
    else if (rawNiche) progressLabel = `Adding… (forcing niche: ${rawNiche})`;
    else progressLabel = 'Adding… (auto-detecting niche — watch service worker console)';
    $('add-result').textContent = progressLabel;
    $('add-result').className = 'detect-result';
    $('btn-add').disabled = true;
    $('debug-details').open = true;
    $('debug-log').textContent = 'running...\n';
    const res = await chrome.runtime.sendMessage({ type: 'ADD_CHANNEL', url, niche });
    $('btn-add').disabled = false;
    if (res?.ok) {
      const verb = res.updated ? 'Updated' : 'Added';
      $('add-result').textContent = `✓ ${verb}: ${res.channel.displayName} (${res.channel.niche || '—'}, ${(res.channel.videos || []).length} videos). Total: ${res.totalChannels}/${res.maxChannels || 10}.`;
      $('add-result').className = 'detect-result';
      $('channel-url').value = '';
    } else {
      $('add-result').textContent = `✗ ${res?.reason || 'unknown error'}`;
      $('add-result').className = 'detect-result err';
    }
    renderDebugLog();
    setTimeout(render, 500);
  });

  // Create custom niche
  $('btn-add-niche').addEventListener('click', async () => {
    const id = $('new-niche-id').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const label = $('new-niche-label').value.trim();
    // Custom niches added here are pure labels — no keywords (kept for future advanced use).
    const keywords = [];
    const out = $('add-niche-result');
    if (!id || !label) {
      out.textContent = '✗ Need id and label';
      out.className = 'niche-result err';
      return;
    }
    $('btn-add-niche').disabled = true;
    const res = await chrome.runtime.sendMessage({ type: 'ADD_NICHE', id, label, keywords });
    $('btn-add-niche').disabled = false;
    if (res?.ok) {
      out.textContent = `✓ Added "${label}"`;
      out.className = 'niche-result ok';
      $('new-niche-id').value = '';
      $('new-niche-label').value = '';
    } else {
      out.textContent = `✗ ${res?.reason || 'failed'}`;
      out.className = 'niche-result err';
    }
    setTimeout(() => { out.textContent = ''; out.className = 'niche-result'; }, 3000);
    setTimeout(render, 500);
  });

  $('btn-bulk-import').addEventListener('click', async () => {
    const urls = $('bulk-urls').value.split('\n').map((u) => u.trim()).filter(Boolean);
    if (urls.length === 0) {
      $('bulk-result').textContent = 'No URLs to import';
      $('bulk-result').className = 'detect-result err';
      return;
    }
    $('bulk-result').textContent = `Importing ${urls.length} channels… (slow, ~5s each)`;
    $('bulk-result').className = 'detect-result';
    $('btn-bulk-import').disabled = true;
    const res = await chrome.runtime.sendMessage({ type: 'BULK_IMPORT', urls });
    $('btn-bulk-import').disabled = false;
    if (res?.ok) {
      const ok = res.results.filter((r) => r.ok).length;
      const fail = res.results.length - ok;
      const lines = [`✓ Imported ${ok}/${res.results.length}`];
      if (fail > 0) {
        lines.push(`(${fail} failed)`);
        for (const r of res.results.filter((x) => !x.ok)) {
          lines.push(`  ✗ ${(r.url || '').slice(0, 60)}: ${r.reason}`);
        }
      }
      $('bulk-result').textContent = lines.join('\n');
      $('bulk-result').className = fail > 0 ? 'detect-result err' : 'detect-result';
    }
    setTimeout(render, 500);
  });

  $('btn-clear-channels').addEventListener('click', async () => {
    if (!confirm('Remove ALL channels? This cannot be undone.')) return;
    await chrome.runtime.sendMessage({ type: 'CLEAR_CHANNELS' });
    setTimeout(render, 500);
  });

  $('btn-save-profile').addEventListener('click', async () => {
    const raw = $('profile-id').value || '';
    const result = $('profile-result');
    $('btn-save-profile').disabled = true;
    $('btn-save-profile').textContent = '⏳';
    result.textContent = '';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'SET_PROFILE_ID', profileId: raw });
      if (res?.ok) {
        result.textContent = res.changed ? `✓ Saved: ${res.profileId}` : `✓ Same as before: ${res.profileId}`;
        result.className = 'profile-result profile-result--ok';
        setTimeout(render, 500);
      } else {
        result.textContent = `✗ ${res?.reason || 'Failed'}`;
        result.className = 'profile-result profile-result--err';
      }
    } catch (e) {
      result.textContent = `✗ ${e.message}`;
      result.className = 'profile-result profile-result--err';
    }
    $('btn-save-profile').disabled = false;
    $('btn-save-profile').textContent = 'Save';
    setTimeout(() => { result.textContent = ''; }, 3000);
  });

  $('profile-id').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-save-profile').click();
  });

  $('btn-save-settings').addEventListener('click', async () => {
    const s = await getStatus();
    const newSettings = {
      ...s.settings,
      activeHours: {
        start: parseInt($('hour-start').value, 10),
        end: parseInt($('hour-end').value, 10),
      },
      actionsPerDay: {
        ...s.settings.actionsPerDay,
        max: parseInt($('max-actions').value, 10),
      },
    };
    await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: newSettings });
    $('btn-save-settings').textContent = '✓ Saved';
    setTimeout(() => { $('btn-save-settings').textContent = 'Save settings'; }, 1500);
    setTimeout(render, 500);
  });

  $('btn-reset').addEventListener('click', async () => {
    if (!confirm('Reset all stats and history?')) return;
    await chrome.runtime.sendMessage({ type: 'RESET_STATS' });
    setTimeout(render, 500);
  });

  // Auto-download settings: load from storage, then wire up the form
  async function loadAutoDownloadForm() {
    const res = await chrome.runtime.sendMessage({ type: 'GET_AUTO_DOWNLOAD_CONFIG' });
    const cfg = res?.config || {};
    $('autodl-enabled').checked = !!cfg.enabled;
    $('autodl-onarchive').checked = !!cfg.onArchive;
    $('autodl-daily').checked = !!cfg.daily;
    $('autodl-hour').value = cfg.dailyHour ?? 3;
    $('autodl-clear').checked = cfg.clearAfterDownload !== false;
  }
  loadAutoDownloadForm();
  $('btn-save-autodl').addEventListener('click', async () => {
    $('btn-save-autodl').textContent = '⏳ Saving…';
    $('btn-save-autodl').disabled = true;
    const res = await chrome.runtime.sendMessage({
      type: 'UPDATE_AUTO_DOWNLOAD_CONFIG',
      config: {
        enabled: $('autodl-enabled').checked,
        onArchive: $('autodl-onarchive').checked,
        daily: $('autodl-daily').checked,
        dailyHour: parseInt($('autodl-hour').value, 10),
        clearAfterDownload: $('autodl-clear').checked,
      },
    });
    $('btn-save-autodl').disabled = false;
    $('btn-save-autodl').textContent = res?.ok ? '✓ Saved' : '✗ Failed';
    const status = $('autodl-status');
    if (res?.ok) {
      status.textContent = res.config.enabled
        ? (res.config.daily
            ? `Auto-download ON — daily at ${res.config.dailyHour}:00${res.config.onArchive ? ' + on each archive' : ''}`
            : (res.config.onArchive ? 'Auto-download ON — on each archive' : 'Auto-download ON (no schedule)'))
        : 'Auto-download OFF';
      status.className = 'autodl-status ok';
    } else {
      status.textContent = `✗ ${res?.reason || 'save failed'}`;
      status.className = 'autodl-status err';
    }
    setTimeout(() => { $('btn-save-autodl').textContent = 'Save auto-download settings'; }, 1500);
  });
  $('btn-trigger-autodl').addEventListener('click', async () => {
    $('btn-trigger-autodl').textContent = '⏳ Downloading…';
    $('btn-trigger-autodl').disabled = true;
    const res = await chrome.runtime.sendMessage({ type: 'TRIGGER_AUTO_DOWNLOAD' });
    $('btn-trigger-autodl').disabled = false;
    const status = $('autodl-status');
    if (res?.ok) {
      if (res.skipped) {
        status.textContent = '(no log data to download)';
        status.className = 'autodl-status';
        $('btn-trigger-autodl').textContent = '(nothing to download)';
      } else {
        status.textContent = `✓ Saved to ${res.filename} (${res.activeCount || 0} active + ${res.archiveCount || 0} archive events). Storage cleared.`;
        status.className = 'autodl-status ok';
        $('btn-trigger-autodl').textContent = '✓ Saved';
      }
    } else {
      status.textContent = `✗ ${res?.reason || 'download failed'}`;
      status.className = 'autodl-status err';
      $('btn-trigger-autodl').textContent = '✗ Failed';
    }
    setTimeout(() => { $('btn-trigger-autodl').textContent = 'Run now'; }, 2500);
    setTimeout(refreshActivity, 500);
  });

  $('btn-show-log').addEventListener('click', renderDebugLog);
  $('btn-copy-log').addEventListener('click', async () => {
    const txt = $('debug-log').textContent;
    try {
      await navigator.clipboard.writeText(txt);
      $('btn-copy-log').textContent = '✓ Copied';
      setTimeout(() => { $('btn-copy-log').textContent = 'Copy'; }, 1200);
    } catch (e) {
      $('btn-copy-log').textContent = '✗ Failed';
      setTimeout(() => { $('btn-copy-log').textContent = 'Copy'; }, 1200);
    }
  });
  $('btn-clear-log').addEventListener('click', async () => {
    await chrome.storage.local.remove('lastDetectLog');
    $('debug-log').textContent = '(cleared)';
  });

  // Activity log + archives
  let _activityFilter = 'all';
  let _activityEvents = [];
  let _activityArchives = [];
  const ACTIVITY_TYPE_FILTERS = {
    all: () => true,
    tick: (e) => e.type.startsWith('tick_') || e.type === 'scheduler_paused',
    watch: (e) => e.type === 'watch_started' || e.type === 'watch_completed' || e.type === 'watch_failed' || e.type === 'watch_timeout',
    channel: (e) => e.type.startsWith('channel_'),
    niche: (e) => e.type.startsWith('niche_'),
    error: (e) => e.level === 'error' || e.type === 'watch_failed' || e.type === 'watch_timeout',
  };
  function renderActivity() {
    const visible = _activityEvents.filter(ACTIVITY_TYPE_FILTERS[_activityFilter] || (() => true));
    $('activity-count').textContent = `${_activityEvents.length}/500`;
    if (visible.length === 0) {
      $('activity-log').innerHTML = '<div class="activity-empty">No matching events.</div>';
    } else {
      const lines = visible.map((e) => {
        const t = new Date(e.ts);
        const time = `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
        const level = e.level || 'info';
        const msg = escapeHtml(e.message || e.type);
        const data = e.data ? ' <span class="activity-data">' + escapeHtml(JSON.stringify(e.data)) + '</span>' : '';
        return `<div class="activity-event ${level}"><span class="activity-time">${time}</span><span class="activity-type">${escapeHtml(e.type)}</span><span class="activity-msg">${msg}</span>${data}</div>`;
      });
      $('activity-log').innerHTML = lines.join('');
    }
    renderArchives();
  }
  function renderArchives() {
    const section = $('archive-section');
    const list = $('archive-list');
    if (!_activityArchives || _activityArchives.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = 'block';
    $('archive-count').textContent = _activityArchives.length;
    const lines = _activityArchives.map((a) => {
      const first = a.firstTs ? new Date(a.firstTs).toLocaleString() : '?';
      const last = a.lastTs ? new Date(a.lastTs).toLocaleString() : '?';
      return `<div class="archive-item">
        <div class="archive-info">
          <span class="archive-label">Chunk #${a.index} · ${a.count} events</span>
          <span class="archive-range">${first} → ${last}</span>
        </div>
        <div class="archive-actions">
          <button data-archive-action="download" data-index="${a.index}" class="btn btn-tiny">Download JSON</button>
          <button data-archive-action="delete" data-index="${a.index}" class="btn btn-tiny remove">Delete</button>
        </div>
      </div>`;
    });
    lines.push(`<div class="archive-bulk">
      <button id="btn-download-all-archive" class="btn btn-tiny">Download all archives + active</button>
      <button id="btn-clear-archive" class="btn btn-tiny remove">Clear all archives</button>
    </div>`);
    list.innerHTML = lines.join('');
    // Wire up archive buttons
    list.querySelectorAll('[data-archive-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.archiveAction;
        const idx = parseInt(btn.dataset.index, 10);
        if (action === 'download') {
          btn.textContent = '⏳ Downloading…';
          btn.disabled = true;
          const r = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_ARCHIVE', index: idx });
          btn.textContent = r?.ok ? '✓ Saved' : '✗ Failed';
          setTimeout(() => { btn.textContent = 'Download JSON'; btn.disabled = false; }, 1500);
        } else if (action === 'delete') {
          if (!confirm('Delete this archive chunk? Cannot be undone (unless you downloaded).')) return;
          await chrome.runtime.sendMessage({ type: 'DELETE_ARCHIVE', index: idx });
          setTimeout(refreshActivity, 300);
        }
      });
    });
    const btnDownloadAll = $('btn-download-all-archive');
    if (btnDownloadAll) btnDownloadAll.onclick = async () => {
      btnDownloadAll.textContent = '⏳ Downloading…';
      btnDownloadAll.disabled = true;
      const r = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_ARCHIVE', index: 'all', includeActive: true });
      btnDownloadAll.textContent = r?.ok ? '✓ Saved' : '✗ Failed';
      setTimeout(() => { btnDownloadAll.textContent = 'Download all archives + active'; btnDownloadAll.disabled = false; }, 1500);
    };
    const btnClearArchive = $('btn-clear-archive');
    if (btnClearArchive) btnClearArchive.onclick = async () => {
      if (!confirm(`Delete all ${_activityArchives.length} archive chunks?`)) return;
      await chrome.runtime.sendMessage({ type: 'CLEAR_ACTIVITY_ARCHIVE' });
      setTimeout(refreshActivity, 300);
    };
  }
  async function refreshActivity() {
    const [res, arcRes] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_ACTIVITY_LOG', limit: 500 }),
      chrome.runtime.sendMessage({ type: 'GET_ACTIVITY_ARCHIVE' }),
    ]);
    if (res?.ok) _activityEvents = res.events || [];
    if (arcRes?.ok) _activityArchives = arcRes.archives || [];
    renderActivity();
  }
  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      _activityFilter = btn.dataset.filter;
      renderActivity();
    });
  });
  $('btn-refresh-activity').addEventListener('click', refreshActivity);
  $('activity-details').addEventListener('toggle', (e) => {
    if (e.target.open) refreshActivity();
  });
  $('btn-copy-activity').addEventListener('click', async () => {
    const txt = JSON.stringify(_activityEvents, null, 2);
    try {
      await navigator.clipboard.writeText(txt);
      $('btn-copy-activity').textContent = '✓ Copied';
      setTimeout(() => { $('btn-copy-activity').textContent = 'Copy JSON'; }, 1200);
    } catch (e) {
      $('btn-copy-activity').textContent = '✗ Failed';
      setTimeout(() => { $('btn-copy-activity').textContent = 'Copy JSON'; }, 1200);
    }
  });
  $('btn-clear-activity').addEventListener('click', async () => {
    if (!confirm('Clear all active log events? Archives will be kept.')) return;
    await chrome.runtime.sendMessage({ type: 'CLEAR_ACTIVITY_LOG' });
    setTimeout(refreshActivity, 300);
  });
  $('btn-download-all').addEventListener('click', async () => {
    $('btn-download-all').textContent = '⏳ Downloading…';
    $('btn-download-all').disabled = true;
    const r = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_ARCHIVE', index: 'all', includeActive: true });
    $('btn-download-all').textContent = r?.ok ? '✓ Saved' : '✗ Failed';
    setTimeout(() => { $('btn-download-all').textContent = 'Download all (JSON)'; $('btn-download-all').disabled = false; }, 1500);
  });
  setInterval(() => {
    if ($('activity-details')?.open) refreshActivity();
  }, 5000);
});

async function renderDebugLog() {
  const { lastDetectLog } = await chrome.storage.local.get('lastDetectLog');
  const out = $('debug-log');
  if (!lastDetectLog) {
    out.textContent = '(no log yet — click "Add this channel" above)';
    return;
  }
  const lines = [];
  lines.push(`=== DETECT LOG @ ${new Date(lastDetectLog.ts).toLocaleString()} ===`);
  lines.push('');
  for (const step of lastDetectLog.log || []) {
    lines.push(`[+${step.t}ms] ${step.label}`);
    if (step.data) lines.push('  ' + JSON.stringify(step.data, null, 0).replace(/\n/g, '\n  '));
  }
  if (lastDetectLog.debug) {
    const d = lastDetectLog.debug;
    lines.push('');
    lines.push('=== SCRAPE DEBUG ===');
    lines.push(`source:    ${d.source || '(unknown)'}`);
    lines.push(`videos:    ${(d.videos || []).length}`);
    if (d.jsonDebug) {
      lines.push(`ytInitialData found:  ${d.jsonDebug.found}`);
      lines.push(`videos extracted:     ${d.jsonDebug.videoRenderers}`);
      if (d.jsonDebug.sampleVideoNode) {
        const s = d.jsonDebug.sampleVideoNode;
        lines.push(`sample videoId:       ${s.videoId}`);
        lines.push(`sample title:         ${s.titlePreview || '(empty)'}`);
      }
    }
    if (d.microformat) {
      const m = d.microformat;
      lines.push('');
      lines.push('-- microformat --');
      lines.push(`  title:    ${m.title || '(empty)'}`);
      lines.push(`  category: ${m.category || '(empty)'}`);
      if (m.description) lines.push(`  desc:     ${m.description.slice(0, 200)}`);
      if (m.keywords?.length) lines.push(`  keywords: ${m.keywords.join(', ')}`);
    }
    if (d.nicheScores && Object.keys(d.nicheScores).length) {
      lines.push('');
      lines.push('-- niche scores --');
      const sorted = Object.entries(d.nicheScores).sort((a, b) => b[1] - a[1]);
      for (const [n, c] of sorted) lines.push(`  ${String(c).padStart(3)}  ${n}`);
    }
  }
  out.textContent = lines.join('\n');
}

setInterval(render, 3000);
