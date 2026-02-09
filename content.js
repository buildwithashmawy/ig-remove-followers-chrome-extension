/**
 * Instagram Follower Remover - Content Script
 * Injected into Instagram pages. Currently used to verify the user is on Instagram
 * and to relay page-level info if needed. The main API work happens in the
 * background service worker.
 */

(function () {
  'use strict';

  // Notify the extension that we're on an Instagram page
  chrome.runtime.sendMessage({ action: 'pageLoaded', url: window.location.href });
})();
