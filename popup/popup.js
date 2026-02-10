/**
 * Instagram Follower Remover - Popup Script
 *
 * The popup is a *view* of state that lives in the background service
 * worker.  All removal work happens in the background and persists to
 * chrome.storage.local, so closing/reopening the popup shows live
 * progress without interrupting the job.
 */

(function () {
  'use strict';

  // ---- DOM refs ----
  const screenNotLoggedIn = document.getElementById('screen-not-logged-in');
  const screenMain        = document.getElementById('screen-main');
  const screenProgress    = document.getElementById('screen-progress');

  const userAvatar    = document.getElementById('user-avatar');
  const userUsername   = document.getElementById('user-username');
  const userFullname   = document.getElementById('user-fullname');
  const statFollowers  = document.getElementById('stat-followers');
  const statFollowing  = document.getElementById('stat-following');
  const statPosts      = document.getElementById('stat-posts');

  const followersList    = document.getElementById('followers-list');
  const followersLoading = document.getElementById('followers-loading');
  const searchInput      = document.getElementById('search-input');
  const btnSelectAll     = document.getElementById('btn-select-all');
  const btnRefresh       = document.getElementById('btn-refresh');
  const btnLoadMore      = document.getElementById('btn-load-more');
  const btnRemoveAll     = document.getElementById('btn-remove-all');

  const actionBar      = document.getElementById('action-bar');
  const selectedCountEl = document.getElementById('selected-count');
  const btnRemove      = document.getElementById('btn-remove');

  const progressIcon     = document.getElementById('progress-icon');
  const progressTitle    = document.getElementById('progress-title');
  const progressSubtitle = document.getElementById('progress-subtitle');
  const progressFill     = document.getElementById('progress-fill');
  const progressText     = document.getElementById('progress-text');
  const progressLog      = document.getElementById('progress-log');
  const btnStop          = document.getElementById('btn-stop');
  const btnDone          = document.getElementById('btn-done');

  // ---- State ----
  let currentUser = null;
  let followers = [];
  let selectedIds = new Set();
  let nextMaxId = null;
  let isLoadingMore = false;
  let pollTimer = null;

  // ---- Helpers ----
  function showScreen(screen) {
    [screenNotLoggedIn, screenMain, screenProgress].forEach(s => s.classList.add('hidden'));
    screen.classList.remove('hidden');
  }

  function fmtNum(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 10_000)    return (n / 1_000).toFixed(1) + 'K';
    if (n >= 1_000)     return n.toLocaleString();
    return String(n);
  }

  function msg(action, data = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action, ...data }, (resp) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp);
      });
    });
  }

  // ---- Render followers list ----
  function renderFollowers(filter = '') {
    const q = filter.toLowerCase();
    const filtered = followers.filter(f =>
      (f.full_name || '').toLowerCase().includes(q) ||
      (f.username || '').toLowerCase().includes(q)
    );

    followersList.innerHTML = '';

    if (filtered.length === 0) {
      followersList.innerHTML = `<div class="no-results">${
        followers.length > 0 ? 'No followers match your search' : 'No followers loaded yet'
      }</div>`;
      return;
    }

    filtered.forEach(f => {
      const item = document.createElement('div');
      item.className = `follower-item${selectedIds.has(f.pk) ? ' selected' : ''}`;
      item.dataset.pk = f.pk;

      const checkbox = document.createElement('div');
      checkbox.className = 'follower-checkbox';
      checkbox.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#fff" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
      item.appendChild(checkbox);

      const avatar = document.createElement('img');
      avatar.className = 'follower-avatar';
      avatar.src = f.profile_pic_url || '';
      avatar.alt = '';
      avatar.onerror = function () { this.style.display = 'none'; };
      item.appendChild(avatar);

      const info = document.createElement('div');
      info.className = 'follower-info';
      const uname = document.createElement('span');
      uname.className = 'follower-username';
      uname.textContent = f.username;
      const fname = document.createElement('span');
      fname.className = 'follower-name';
      fname.textContent = f.full_name || '';
      info.appendChild(uname);
      info.appendChild(fname);
      item.appendChild(info);

      if (f.is_verified) {
        const b = document.createElement('span');
        b.className = 'follower-badge';
        b.textContent = 'Verified';
        item.appendChild(b);
      }
      if (f.is_private) {
        const b = document.createElement('span');
        b.className = 'follower-badge';
        b.textContent = 'Private';
        item.appendChild(b);
      }

      item.addEventListener('click', () => {
        if (selectedIds.has(f.pk)) { selectedIds.delete(f.pk); item.classList.remove('selected'); }
        else { selectedIds.add(f.pk); item.classList.add('selected'); }
        updateActionBar();
      });

      followersList.appendChild(item);
    });
  }

  function updateActionBar() {
    if (selectedIds.size > 0) {
      actionBar.classList.remove('hidden');
      selectedCountEl.textContent = selectedIds.size;
    } else {
      actionBar.classList.add('hidden');
    }
    const allSel = followers.length > 0 && followers.every(f => selectedIds.has(f.pk));
    btnSelectAll.textContent = allSel ? 'Deselect All' : 'Select All';
  }

  // ---- Load followers (for manual selection) ----
  async function loadFollowers(reset = false) {
    if (isLoadingMore) return;
    isLoadingMore = true;

    if (reset) {
      followers = [];
      selectedIds.clear();
      nextMaxId = null;
      followersList.innerHTML = '';
      updateActionBar();
    }

    followersLoading.classList.remove('hidden');
    btnLoadMore.classList.add('hidden');

    try {
      const res = await msg('getFollowers', { userId: currentUser.pk, maxId: nextMaxId });
      if (res.error) throw new Error(res.error);

      followers = followers.concat(res.users || []);
      nextMaxId = res.next_max_id || null;
      renderFollowers(searchInput.value);

      if (nextMaxId) {
        btnLoadMore.classList.remove('hidden');
        btnLoadMore.textContent = `Load more followers (${followers.length} loaded)`;
      }
    } catch (err) {
      console.error('Failed to load followers:', err);
      followersList.innerHTML = '<div class="no-results">Failed to load followers. Please try again.</div>';
    } finally {
      followersLoading.classList.add('hidden');
      isLoadingMore = false;
    }
  }

  // ---- Progress screen ----
  function renderProgress(job) {
    const pct = job.total > 0 ? ((job.completed + job.failed) / job.total) * 100 : 0;
    progressFill.style.width = `${pct}%`;
    progressText.textContent = `${job.completed + job.failed} / ${job.total}`;

    if (job.status === 'running') {
      progressTitle.textContent = 'Removing Followers...';
      progressSubtitle.textContent = 'Running in the background. You can close this popup safely.';
      progressIcon.style.animation = 'pulse 2s ease-in-out infinite';
      btnStop.classList.remove('hidden');
      btnStop.disabled = job.stopRequested;
      btnStop.textContent = job.stopRequested ? 'Stopping...' : 'Stop';
      btnDone.classList.add('hidden');
    } else if (job.status === 'stopped') {
      progressTitle.textContent = 'Stopped';
      progressSubtitle.textContent = `Removed ${job.completed} of ${job.total}. ${job.failed} failed.`;
      progressIcon.style.animation = 'none';
      btnStop.classList.add('hidden');
      btnDone.classList.remove('hidden');
    } else if (job.status === 'done') {
      progressTitle.textContent = 'Complete!';
      progressSubtitle.textContent = `Removed ${job.completed} follower${job.completed !== 1 ? 's' : ''}. ${job.failed > 0 ? job.failed + ' failed.' : ''}`;
      progressIcon.style.animation = 'none';
      btnStop.classList.add('hidden');
      btnDone.classList.remove('hidden');
    }

    // Render log entries
    progressLog.innerHTML = '';
    (job.log || []).forEach(entry => {
      const el = document.createElement('div');
      el.className = `log-entry ${entry.type}`;
      const dot = document.createElement('span');
      dot.className = 'log-dot';
      const span = document.createElement('span');
      span.textContent = entry.text;
      el.appendChild(dot);
      el.appendChild(span);
      progressLog.appendChild(el);
    });
    progressLog.scrollTop = progressLog.scrollHeight;
  }

  // Poll background job state
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      const job = await msg('getJob');
      renderProgress(job);
      // Stop polling if job is no longer running
      if (job.status !== 'running') {
        stopPolling();
      }
    }, 800);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ---- Event listeners ----

  searchInput.addEventListener('input', () => renderFollowers(searchInput.value));

  btnSelectAll.addEventListener('click', () => {
    const allSel = followers.length > 0 && followers.every(f => selectedIds.has(f.pk));
    if (allSel) selectedIds.clear();
    else followers.forEach(f => selectedIds.add(f.pk));
    renderFollowers(searchInput.value);
    updateActionBar();
  });

  btnRefresh.addEventListener('click', () => loadFollowers(true));
  btnLoadMore.addEventListener('click', () => loadFollowers(false));

  // Remove ALL followers
  btnRemoveAll.addEventListener('click', async () => {
    const count = currentUser.follower_count || '?';
    if (!confirm(`This will remove ALL ${count} followers from your account. This cannot be undone.\n\nContinue?`)) return;

    const res = await msg('startRemoveAll', { userId: currentUser.pk });
    if (res.error) { alert(res.error); return; }
    showScreen(screenProgress);
    renderProgress(await msg('getJob'));
    startPolling();
  });

  // Remove selected followers
  btnRemove.addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    if (!confirm(`Remove ${count} follower${count > 1 ? 's' : ''}? This cannot be undone.`)) return;

    // Build the follower objects to pass to background
    const selected = followers.filter(f => selectedIds.has(f.pk)).map(f => ({ pk: f.pk, username: f.username }));
    const res = await msg('startRemoveSelected', { followers: selected });
    if (res.error) { alert(res.error); return; }
    showScreen(screenProgress);
    renderProgress(await msg('getJob'));
    startPolling();
  });

  btnStop.addEventListener('click', async () => {
    btnStop.disabled = true;
    btnStop.textContent = 'Stopping...';
    await msg('requestStop');
  });

  btnDone.addEventListener('click', async () => {
    await msg('clearJob');
    showScreen(screenMain);
    loadFollowers(true);
  });

  // ---- Initialize ----
  function showLoginError(errorCode) {
    const title = document.getElementById('login-error-title');
    const desc  = document.getElementById('login-error-desc');
    if (errorCode === 'NO_IG_TAB') {
      title.textContent = 'No Instagram Tab Open';
      desc.textContent = 'Please open Instagram in a browser tab and keep it open, then click this extension again.';
    } else {
      title.textContent = 'Not Logged In';
      desc.textContent = 'Please open Instagram and log in to your account first, then reopen this extension.';
    }
    showScreen(screenNotLoggedIn);
  }

  async function init() {
    try {
      // First check if there's already a running job
      const job = await msg('getJob');
      if (job.status === 'running' || job.status === 'stopped' || job.status === 'done') {
        // Show progress screen immediately (even if we need login for the main screen)
        showScreen(screenProgress);
        renderProgress(job);
        if (job.status === 'running') startPolling();
        return;
      }

      // Normal login flow
      const response = await msg('checkLogin');
      if (!response || !response.loggedIn) {
        showLoginError(response?.error);
        return;
      }

      currentUser = response.user;
      userAvatar.src = currentUser.profile_pic_url || '';
      userUsername.textContent = `@${currentUser.username}`;
      userFullname.textContent = currentUser.full_name || '';
      statFollowers.textContent = fmtNum(currentUser.follower_count || 0);
      statFollowing.textContent = fmtNum(currentUser.following_count || 0);
      statPosts.textContent = fmtNum(currentUser.media_count || 0);

      showScreen(screenMain);
      loadFollowers(true);
    } catch (err) {
      console.error('Init error:', err);
      showLoginError();
    }
  }

  init();
})();
