/**
 * Instagram Follower Remover - Background Service Worker
 *
 * Uses chrome.scripting.executeScript with world: 'MAIN' to run fetch()
 * inside the Instagram tab's page context. This guarantees cookies are
 * included automatically — no manual Cookie header hacks needed.
 */

const IG_API = 'https://www.instagram.com/api/v1';

/**
 * Find an open Instagram tab to execute API calls in.
 */
async function findInstagramTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (tabs.length === 0) {
    throw new Error('NO_IG_TAB');
  }
  return tabs[0].id;
}

/**
 * Get the CSRF token from cookies.
 */
async function getCsrfToken() {
  const cookie = await chrome.cookies.get({
    url: 'https://www.instagram.com',
    name: 'csrftoken'
  });
  return cookie ? cookie.value : '';
}

/**
 * Execute a fetch call inside the Instagram tab's MAIN world.
 * The injected function runs in the page's JS context so all session
 * cookies are sent automatically with credentials: 'include'.
 */
async function igFetch(url, method, extraHeaders) {
  const tabId = await findInstagramTab();
  const csrfToken = await getCsrfToken();

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (fetchUrl, fetchMethod, csrf, hdrs) => {
      try {
        const res = await fetch(fetchUrl, {
          method: fetchMethod,
          headers: {
            'X-CSRFToken': csrf,
            'X-Requested-With': 'XMLHttpRequest',
            'X-IG-App-ID': '936619743392459',
            ...hdrs
          },
          credentials: 'include'
        });

        if (!res.ok) {
          return { __igError: true, status: res.status };
        }

        const data = await res.json();
        return { __igError: false, data };
      } catch (e) {
        return { __igError: true, status: 0, message: e.message };
      }
    },
    args: [url, method || 'GET', csrfToken, extraHeaders || {}]
  });

  const result = results[0]?.result;

  if (!result || result.__igError) {
    const status = result?.status;
    if (status === 401 || status === 403) {
      throw new Error('Session expired. Please log in to Instagram again.');
    }
    if (status === 429) {
      throw new Error('Rate limited by Instagram. Please wait a few minutes.');
    }
    throw new Error(result?.message || `Instagram API error (${status})`);
  }

  return result.data;
}

// ---- API Methods ----

async function checkLogin() {
  try {
    // Quick cookie check first
    const sessionCookie = await chrome.cookies.get({
      url: 'https://www.instagram.com',
      name: 'sessionid'
    });
    if (!sessionCookie) {
      return { loggedIn: false };
    }

    // Make sure there's an Instagram tab open
    let tabId;
    try {
      tabId = await findInstagramTab();
    } catch {
      return { loggedIn: false, error: 'NO_IG_TAB' };
    }

    // Fetch current user info via the tab
    const data = await igFetch(`${IG_API}/accounts/current_user/?edit=true`, 'GET');

    if (!data.user) {
      return { loggedIn: false };
    }

    const user = data.user;

    // Try to enrich with follower/following counts (non-fatal)
    try {
      const profileData = await igFetch(
        `${IG_API}/users/web_profile_info/?username=${encodeURIComponent(user.username)}`,
        'GET',
        { 'Referer': `https://www.instagram.com/${user.username}/` }
      );

      if (profileData.data && profileData.data.user) {
        const p = profileData.data.user;
        user.follower_count = p.edge_followed_by?.count || 0;
        user.following_count = p.edge_follow?.count || 0;
        user.media_count = p.edge_owner_to_timeline_media?.count || 0;
        user.profile_pic_url = p.profile_pic_url_hd || user.profile_pic_url;
      }
    } catch (e) {
      console.warn('Could not fetch profile counts:', e.message);
    }

    return { loggedIn: true, user };
  } catch (err) {
    console.error('checkLogin error:', err);
    return { loggedIn: false, error: err.message };
  }
}

async function getFollowers(userId, maxId) {
  try {
    let url = `${IG_API}/friendships/${userId}/followers/?count=50`;
    if (maxId) {
      url += `&max_id=${encodeURIComponent(maxId)}`;
    }

    const data = await igFetch(url, 'GET');

    return {
      users: data.users || [],
      next_max_id: data.next_max_id || null
    };
  } catch (err) {
    console.error('getFollowers error:', err);
    return { error: err.message };
  }
}

async function removeFollower(userId) {
  try {
    const data = await igFetch(
      `${IG_API}/friendships/remove_follower/${userId}/`,
      'POST',
      { 'Content-Type': 'application/x-www-form-urlencoded' }
    );

    return { success: true, status: data.status };
  } catch (err) {
    console.error('removeFollower error:', err);
    return { error: err.message };
  }
}

// ---- Message Handler ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, ...data } = message;

  const handler = {
    checkLogin: () => checkLogin(),
    getFollowers: () => getFollowers(data.userId, data.maxId),
    removeFollower: () => removeFollower(data.userId)
  }[action];

  if (handler) {
    handler().then(sendResponse);
    return true; // keep message channel open for async response
  }

  sendResponse({ error: 'Unknown action' });
  return false;
});
