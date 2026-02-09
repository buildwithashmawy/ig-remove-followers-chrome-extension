/**
 * Instagram Follower Remover - Background Service Worker
 * Handles Instagram API communication using the logged-in session cookies.
 */

// Instagram API helpers
const IG_BASE = 'https://www.instagram.com';
const IG_API = 'https://www.instagram.com/api/v1';

/**
 * Get Instagram cookies and CSRF token for the current session.
 */
async function getSessionInfo() {
  const cookies = await chrome.cookies.getAll({ domain: '.instagram.com' });
  const csrfCookie = cookies.find(c => c.name === 'csrftoken');
  const sessionCookie = cookies.find(c => c.name === 'sessionid');

  return {
    csrfToken: csrfCookie ? csrfCookie.value : null,
    sessionId: sessionCookie ? sessionCookie.value : null,
    hasCookies: !!(csrfCookie && sessionCookie)
  };
}

/**
 * Make an authenticated request to Instagram's API.
 */
async function igFetch(url, options = {}) {
  const session = await getSessionInfo();

  if (!session.hasCookies) {
    throw new Error('Not logged in to Instagram');
  }

  const headers = {
    'X-CSRFToken': session.csrfToken,
    'X-Requested-With': 'XMLHttpRequest',
    'X-IG-App-ID': '936619743392459',
    ...options.headers
  };

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'include'
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Session expired. Please log in to Instagram again.');
    }
    if (response.status === 429) {
      throw new Error('Rate limited. Please wait a few minutes.');
    }
    throw new Error(`Instagram API error (${response.status})`);
  }

  return response.json();
}

/**
 * Check if user is logged in and get their profile info.
 */
async function checkLogin() {
  try {
    const session = await getSessionInfo();
    if (!session.hasCookies) {
      return { loggedIn: false };
    }

    // Fetch current user info
    const data = await igFetch(`${IG_API}/accounts/current_user/?edit=true`);

    if (!data.user) {
      return { loggedIn: false };
    }

    // Also get follower/following counts from the user's profile
    const profileData = await igFetch(
      `${IG_API}/users/web_profile_info/?username=${data.user.username}`,
      {
        headers: {
          'Referer': `${IG_BASE}/${data.user.username}/`
        }
      }
    );

    const user = data.user;
    if (profileData.data && profileData.data.user) {
      const profileUser = profileData.data.user;
      user.follower_count = profileUser.edge_followed_by?.count || 0;
      user.following_count = profileUser.edge_follow?.count || 0;
      user.media_count = profileUser.edge_owner_to_timeline_media?.count || 0;
      user.profile_pic_url = profileUser.profile_pic_url_hd || user.profile_pic_url;
    }

    return { loggedIn: true, user };
  } catch (err) {
    console.error('checkLogin error:', err);
    return { loggedIn: false, error: err.message };
  }
}

/**
 * Get a page of followers for the given user ID.
 */
async function getFollowers(userId, maxId = null) {
  try {
    let url = `${IG_API}/friendships/${userId}/followers/?count=50`;
    if (maxId) {
      url += `&max_id=${maxId}`;
    }

    const data = await igFetch(url, {
      headers: {
        'Referer': `${IG_BASE}/`
      }
    });

    return {
      users: data.users || [],
      next_max_id: data.next_max_id || null,
      status: data.status
    };
  } catch (err) {
    console.error('getFollowers error:', err);
    return { error: err.message };
  }
}

/**
 * Remove a follower by their user ID.
 * Uses the "remove follower" endpoint (different from unfollowing).
 */
async function removeFollower(userId) {
  try {
    const data = await igFetch(
      `${IG_API}/friendships/remove_follower/${userId}/`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `${IG_BASE}/`
        }
      }
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

  switch (action) {
    case 'checkLogin':
      checkLogin().then(sendResponse);
      return true; // async

    case 'getFollowers':
      getFollowers(data.userId, data.maxId).then(sendResponse);
      return true;

    case 'removeFollower':
      removeFollower(data.userId).then(sendResponse);
      return true;

    default:
      sendResponse({ error: 'Unknown action' });
      return false;
  }
});
