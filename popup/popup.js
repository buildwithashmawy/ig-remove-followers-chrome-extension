/**
 * Instagram Follower Remover - Popup Script
 * Handles UI interactions, communicates with background service worker
 * for Instagram API calls.
 */

(function () {
  'use strict';

  // ---- DOM Elements ----
  const screenNotLoggedIn = document.getElementById('screen-not-logged-in');
  const screenMain = document.getElementById('screen-main');
  const screenRemoving = document.getElementById('screen-removing');

  const userAvatar = document.getElementById('user-avatar');
  const userUsername = document.getElementById('user-username');
  const userFullname = document.getElementById('user-fullname');
  const statFollowers = document.getElementById('stat-followers');
  const statFollowing = document.getElementById('stat-following');
  const statPosts = document.getElementById('stat-posts');

  const followersList = document.getElementById('followers-list');
  const followersLoading = document.getElementById('followers-loading');
  const searchInput = document.getElementById('search-input');
  const btnSelectAll = document.getElementById('btn-select-all');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnLoadMore = document.getElementById('btn-load-more');

  const actionBar = document.getElementById('action-bar');
  const selectedCountEl = document.getElementById('selected-count');
  const btnRemove = document.getElementById('btn-remove');

  const progressTitle = document.getElementById('progress-title');
  const progressSubtitle = document.getElementById('progress-subtitle');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  const progressLog = document.getElementById('progress-log');
  const btnStop = document.getElementById('btn-stop');
  const btnDone = document.getElementById('btn-done');

  // ---- State ----
  let currentUser = null;
  let followers = [];
  let selectedIds = new Set();
  let nextMaxId = null;
  let isLoadingMore = false;
  let isRemoving = false;
  let stopRequested = false;

  // ---- Helpers ----
  function showScreen(screen) {
    [screenNotLoggedIn, screenMain, screenRemoving].forEach(s => s.classList.add('hidden'));
    screen.classList.remove('hidden');
  }

  function formatNumber(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 10_000) return (n / 1_000).toFixed(1) + 'K';
    if (n >= 1_000) return n.toLocaleString();
    return String(n);
  }

  function sendMessage(action, data = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action, ...data }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function addLogEntry(text, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const dot = document.createElement('span');
    dot.className = 'log-dot';
    const span = document.createElement('span');
    span.textContent = text;
    entry.appendChild(dot);
    entry.appendChild(span);
    progressLog.appendChild(entry);
    progressLog.scrollTop = progressLog.scrollHeight;
  }

  // ---- Render Followers ----
  function renderFollowers(filter = '') {
    const lowerFilter = filter.toLowerCase();
    const filtered = followers.filter(f => {
      const name = (f.full_name || '').toLowerCase();
      const uname = (f.username || '').toLowerCase();
      return name.includes(lowerFilter) || uname.includes(lowerFilter);
    });

    followersList.innerHTML = '';

    if (filtered.length === 0 && followers.length > 0) {
      followersList.innerHTML = '<div class="no-results">No followers match your search</div>';
      return;
    }

    if (filtered.length === 0 && followers.length === 0) {
      followersList.innerHTML = '<div class="no-results">No followers loaded yet</div>';
      return;
    }

    filtered.forEach(f => {
      const item = document.createElement('div');
      item.className = `follower-item${selectedIds.has(f.pk) ? ' selected' : ''}`;
      item.dataset.pk = f.pk;

      // Checkbox
      const checkbox = document.createElement('div');
      checkbox.className = 'follower-checkbox';
      checkbox.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#fff" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
      item.appendChild(checkbox);

      // Avatar
      const avatar = document.createElement('img');
      avatar.className = 'follower-avatar';
      avatar.src = f.profile_pic_url || '';
      avatar.alt = '';
      avatar.onerror = function() { this.style.display = 'none'; };
      item.appendChild(avatar);

      // Info
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

      // Badges
      if (f.is_verified) {
        const badge = document.createElement('span');
        badge.className = 'follower-badge';
        badge.textContent = 'Verified';
        item.appendChild(badge);
      }
      if (f.is_private) {
        const badge = document.createElement('span');
        badge.className = 'follower-badge';
        badge.textContent = 'Private';
        item.appendChild(badge);
      }

      item.addEventListener('click', () => toggleSelect(f.pk, item));
      followersList.appendChild(item);
    });
  }

  function toggleSelect(pk, itemEl) {
    if (selectedIds.has(pk)) {
      selectedIds.delete(pk);
      itemEl.classList.remove('selected');
    } else {
      selectedIds.add(pk);
      itemEl.classList.add('selected');
    }
    updateActionBar();
  }

  function updateActionBar() {
    if (selectedIds.size > 0) {
      actionBar.classList.remove('hidden');
      selectedCountEl.textContent = selectedIds.size;
    } else {
      actionBar.classList.add('hidden');
    }
    // Update select all button text
    const allSelected = followers.length > 0 && followers.every(f => selectedIds.has(f.pk));
    btnSelectAll.textContent = allSelected ? 'Deselect All' : 'Select All';
  }

  // ---- Load Followers ----
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
      const response = await sendMessage('getFollowers', {
        userId: currentUser.pk,
        maxId: nextMaxId
      });

      if (response.error) {
        throw new Error(response.error);
      }

      const newFollowers = response.users || [];
      followers = followers.concat(newFollowers);
      nextMaxId = response.next_max_id || null;

      renderFollowers(searchInput.value);

      if (nextMaxId) {
        btnLoadMore.classList.remove('hidden');
        btnLoadMore.textContent = `Load more followers (${followers.length} loaded)`;
      } else {
        btnLoadMore.classList.add('hidden');
      }
    } catch (err) {
      console.error('Failed to load followers:', err);
      followersList.innerHTML = `<div class="no-results">Failed to load followers. Please try again.</div>`;
    } finally {
      followersLoading.classList.add('hidden');
      isLoadingMore = false;
    }
  }

  // ---- Remove Followers ----
  async function removeFollowers() {
    const idsToRemove = Array.from(selectedIds);
    const total = idsToRemove.length;
    let completed = 0;
    let failed = 0;

    isRemoving = true;
    stopRequested = false;

    showScreen(screenRemoving);
    progressTitle.textContent = 'Removing Followers...';
    progressSubtitle.textContent = 'Please keep this popup open.';
    progressLog.innerHTML = '';
    progressFill.style.width = '0%';
    progressText.textContent = `0 / ${total}`;
    btnStop.classList.remove('hidden');
    btnDone.classList.add('hidden');

    addLogEntry(`Starting removal of ${total} follower${total > 1 ? 's' : ''}...`, 'info');

    for (let i = 0; i < idsToRemove.length; i++) {
      if (stopRequested) {
        addLogEntry('Stopped by user.', 'info');
        break;
      }

      const pk = idsToRemove[i];
      const follower = followers.find(f => f.pk === pk);
      const name = follower ? follower.username : pk;

      try {
        const response = await sendMessage('removeFollower', { userId: pk });

        if (response.error) {
          throw new Error(response.error);
        }

        completed++;
        addLogEntry(`Removed @${name}`, 'success');
        selectedIds.delete(pk);
        followers = followers.filter(f => f.pk !== pk);
      } catch (err) {
        failed++;
        addLogEntry(`Failed to remove @${name}: ${err.message}`, 'error');
      }

      const progress = ((completed + failed) / total) * 100;
      progressFill.style.width = `${progress}%`;
      progressText.textContent = `${completed + failed} / ${total}`;

      // Add delay between removals to avoid rate limiting (2-5 seconds random)
      if (i < idsToRemove.length - 1 && !stopRequested) {
        const delay = 2000 + Math.random() * 3000;
        await new Promise(r => setTimeout(r, delay));
      }
    }

    // Done
    isRemoving = false;
    btnStop.classList.add('hidden');
    btnDone.classList.remove('hidden');

    if (stopRequested) {
      progressTitle.textContent = 'Stopped';
      progressSubtitle.textContent = `Removed ${completed} of ${total}. ${failed} failed.`;
    } else {
      progressTitle.textContent = 'Complete!';
      progressSubtitle.textContent = `Removed ${completed} follower${completed !== 1 ? 's' : ''}. ${failed > 0 ? failed + ' failed.' : ''}`;
      addLogEntry('All done!', 'success');
    }

    // Update stats
    if (currentUser && completed > 0) {
      const newCount = Math.max(0, (currentUser.follower_count || 0) - completed);
      currentUser.follower_count = newCount;
      statFollowers.textContent = formatNumber(newCount);
    }
  }

  // ---- Event Listeners ----
  searchInput.addEventListener('input', () => {
    renderFollowers(searchInput.value);
  });

  btnSelectAll.addEventListener('click', () => {
    const allSelected = followers.length > 0 && followers.every(f => selectedIds.has(f.pk));
    if (allSelected) {
      selectedIds.clear();
    } else {
      followers.forEach(f => selectedIds.add(f.pk));
    }
    renderFollowers(searchInput.value);
    updateActionBar();
  });

  btnRefresh.addEventListener('click', () => {
    loadFollowers(true);
  });

  btnLoadMore.addEventListener('click', () => {
    loadFollowers(false);
  });

  btnRemove.addEventListener('click', () => {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    if (confirm(`Are you sure you want to remove ${count} follower${count > 1 ? 's' : ''}? This action cannot be undone.`)) {
      removeFollowers();
    }
  });

  btnStop.addEventListener('click', () => {
    stopRequested = true;
    btnStop.disabled = true;
    btnStop.textContent = 'Stopping...';
  });

  btnDone.addEventListener('click', () => {
    showScreen(screenMain);
    renderFollowers(searchInput.value);
    updateActionBar();
  });

  // ---- Initialize ----
  async function init() {
    try {
      const response = await sendMessage('checkLogin');

      if (!response || !response.loggedIn) {
        showScreen(screenNotLoggedIn);
        return;
      }

      currentUser = response.user;

      // Populate user info
      userAvatar.src = currentUser.profile_pic_url || '';
      userUsername.textContent = `@${currentUser.username}`;
      userFullname.textContent = currentUser.full_name || '';
      statFollowers.textContent = formatNumber(currentUser.follower_count || 0);
      statFollowing.textContent = formatNumber(currentUser.following_count || 0);
      statPosts.textContent = formatNumber(currentUser.media_count || 0);

      showScreen(screenMain);
      loadFollowers(true);
    } catch (err) {
      console.error('Init error:', err);
      showScreen(screenNotLoggedIn);
    }
  }

  init();
})();
