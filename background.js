/**
 * Instagram Follower Remover - Background Service Worker
 *
 * Owns the entire removal loop so it keeps running even when the popup
 * is closed.  Progress is persisted to chrome.storage.local and the
 * popup polls it for live updates.
 */

const IG_API = 'https://www.instagram.com/api/v1';

// ---- Helpers ----

async function findInstagramTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (tabs.length === 0) throw new Error('NO_IG_TAB');
  return tabs[0].id;
}

async function getCsrfToken() {
  const c = await chrome.cookies.get({ url: 'https://www.instagram.com', name: 'csrftoken' });
  return c ? c.value : '';
}

async function igFetch(url, method, extraHeaders) {
  const tabId = await findInstagramTab();
  const csrf = await getCsrfToken();

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (fetchUrl, fetchMethod, csrfToken, hdrs) => {
      try {
        const res = await fetch(fetchUrl, {
          method: fetchMethod,
          headers: {
            'X-CSRFToken': csrfToken,
            'X-Requested-With': 'XMLHttpRequest',
            'X-IG-App-ID': '936619743392459',
            ...hdrs
          },
          credentials: 'include'
        });
        if (!res.ok) return { __err: true, status: res.status };
        return { __err: false, data: await res.json() };
      } catch (e) {
        return { __err: true, status: 0, message: e.message };
      }
    },
    args: [url, method || 'GET', csrf, extraHeaders || {}]
  });

  const r = results[0]?.result;
  if (!r || r.__err) {
    const s = r?.status;
    if (s === 401 || s === 403) throw new Error('Session expired. Please log in to Instagram again.');
    if (s === 429) throw new Error('Rate limited by Instagram. Please wait a few minutes.');
    throw new Error(r?.message || `Instagram API error (${s})`);
  }
  return r.data;
}

// ---- Storage helpers ----

const DEFAULT_JOB = {
  running: false,
  stopRequested: false,
  total: 0,
  completed: 0,
  failed: 0,
  log: [],          // last 200 entries
  status: 'idle',   // idle | running | stopped | done
  mode: null        // 'selected' | 'all'
};

async function getJob() {
  const { job } = await chrome.storage.local.get('job');
  return job || { ...DEFAULT_JOB };
}

async function setJob(patch) {
  const job = await getJob();
  Object.assign(job, patch);
  // Keep log trimmed
  if (job.log.length > 200) job.log = job.log.slice(-200);
  await chrome.storage.local.set({ job });
  return job;
}

function logEntry(text, type) {
  return { text, type, ts: Date.now() };
}

// ---- API Methods ----

async function checkLogin() {
  try {
    const session = await chrome.cookies.get({ url: 'https://www.instagram.com', name: 'sessionid' });
    if (!session) return { loggedIn: false };

    const uid = await chrome.cookies.get({ url: 'https://www.instagram.com', name: 'ds_user_id' });
    if (!uid) return { loggedIn: false };

    try { await findInstagramTab(); } catch { return { loggedIn: false, error: 'NO_IG_TAB' }; }

    const data = await igFetch(`${IG_API}/users/${uid.value}/info/`, 'GET');
    if (!data.user) return { loggedIn: false };

    const user = data.user;
    user.pk = user.pk || uid.value;
    return { loggedIn: true, user };
  } catch (err) {
    console.error('checkLogin error:', err);
    return { loggedIn: false, error: err.message };
  }
}

async function getFollowers(userId, maxId) {
  let url = `${IG_API}/friendships/${userId}/followers/?count=50`;
  if (maxId) url += `&max_id=${encodeURIComponent(maxId)}`;
  const data = await igFetch(url, 'GET');
  return { users: data.users || [], next_max_id: data.next_max_id || null };
}

async function removeOneFollower(userId) {
  return igFetch(
    `${IG_API}/friendships/remove_follower/${userId}/`,
    'POST',
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );
}

// ---- Removal job (runs in background) ----

let jobRunning = false;   // in-memory guard

async function startRemoveSelected(followerList) {
  if (jobRunning) return { error: 'A removal job is already running.' };
  jobRunning = true;

  const job = await setJob({
    running: true,
    stopRequested: false,
    total: followerList.length,
    completed: 0,
    failed: 0,
    log: [logEntry(`Starting removal of ${followerList.length} follower${followerList.length > 1 ? 's' : ''}...`, 'info')],
    status: 'running',
    mode: 'selected'
  });

  runRemovalLoop(followerList);
  return { started: true };
}

async function startRemoveAll(userId) {
  if (jobRunning) return { error: 'A removal job is already running.' };
  jobRunning = true;

  await setJob({
    running: true,
    stopRequested: false,
    total: 0,
    completed: 0,
    failed: 0,
    log: [logEntry('Fetching all followers...', 'info')],
    status: 'running',
    mode: 'all'
  });

  // Fetch ALL followers first
  let allFollowers = [];
  let nextMaxId = null;
  try {
    do {
      const job = await getJob();
      if (job.stopRequested) break;

      const page = await getFollowers(userId, nextMaxId);
      allFollowers = allFollowers.concat(page.users);
      nextMaxId = page.next_max_id;

      await setJob({
        log: [...(await getJob()).log, logEntry(`Fetched ${allFollowers.length} followers so far...`, 'info')],
        total: allFollowers.length
      });

      // Small delay between pagination to be nice
      if (nextMaxId) await sleep(1000);
    } while (nextMaxId);
  } catch (err) {
    await setJob({
      running: false,
      status: 'done',
      log: [...(await getJob()).log, logEntry(`Error fetching followers: ${err.message}`, 'error')]
    });
    jobRunning = false;
    return { error: err.message };
  }

  const job = await getJob();
  if (job.stopRequested || allFollowers.length === 0) {
    const msg = allFollowers.length === 0 ? 'No followers found.' : 'Stopped by user.';
    await setJob({
      running: false,
      status: job.stopRequested ? 'stopped' : 'done',
      total: allFollowers.length,
      log: [...job.log, logEntry(msg, 'info')]
    });
    jobRunning = false;
    return { started: true };
  }

  await setJob({
    total: allFollowers.length,
    log: [...(await getJob()).log, logEntry(`Found ${allFollowers.length} followers. Starting removal...`, 'info')]
  });

  runRemovalLoop(allFollowers);
  return { started: true };
}

async function runRemovalLoop(followers) {
  for (let i = 0; i < followers.length; i++) {
    let job = await getJob();
    if (job.stopRequested) {
      await setJob({
        running: false,
        status: 'stopped',
        log: [...job.log, logEntry('Stopped by user.', 'info')]
      });
      jobRunning = false;
      return;
    }

    const f = followers[i];
    const name = f.username || f.pk;

    try {
      await removeOneFollower(f.pk);
      job = await getJob();
      await setJob({
        completed: job.completed + 1,
        log: [...job.log, logEntry(`Removed @${name}`, 'success')]
      });
    } catch (err) {
      job = await getJob();
      await setJob({
        failed: job.failed + 1,
        log: [...job.log, logEntry(`Failed @${name}: ${err.message}`, 'error')]
      });
    }

    // Rate-limit delay (2-5s)
    if (i < followers.length - 1) {
      const check = await getJob();
      if (!check.stopRequested) {
        await sleep(2000 + Math.random() * 3000);
      }
    }
  }

  const finalJob = await getJob();
  await setJob({
    running: false,
    status: 'done',
    log: [...finalJob.log, logEntry(
      `Done! Removed ${finalJob.completed}, failed ${finalJob.failed}.`, 'success'
    )]
  });
  jobRunning = false;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function requestStop() {
  await setJob({ stopRequested: true });
  return { ok: true };
}

async function clearJob() {
  await chrome.storage.local.remove('job');
  jobRunning = false;
  return { ok: true };
}

// ---- Message Handler ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, ...data } = message;

  const handlers = {
    checkLogin:          () => checkLogin(),
    getFollowers:        () => getFollowers(data.userId, data.maxId)
                                .catch(err => ({ error: err.message })),
    getJob:              () => getJob(),
    startRemoveSelected: () => startRemoveSelected(data.followers),
    startRemoveAll:      () => startRemoveAll(data.userId),
    requestStop:         () => requestStop(),
    clearJob:            () => clearJob()
  };

  const handler = handlers[action];
  if (handler) {
    handler().then(sendResponse);
    return true;
  }

  sendResponse({ error: 'Unknown action' });
  return false;
});
