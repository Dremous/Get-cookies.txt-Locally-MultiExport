import { runBackgroundTask } from './modules/background_errors.mjs';
import { createSaveMessageListener } from './modules/background_message.mjs';
import { createBadgeCounter } from './modules/badge_counter.mjs';
import getAllCookies, {
  getTabPartitionKey,
} from './modules/get_all_cookies.mjs';
import saveToFile from './modules/save_to_file.mjs';
import {
  UPDATE_NOTIFICATION_ID,
  UPDATE_RELEASES_URL,
  buildUpdateNotificationOptions,
  registerUpdateNotificationHandlers,
} from './modules/update_notification.mjs';

/**
 * Set the badge text, ignoring the expected race where the tab has closed
 * between the active-tab query and the badge update.
 * @param {number} tabId
 * @param {string} text
 */
const setBadgeTextSafely = (tabId, text) =>
  new Promise((resolve) => {
    chrome.action.setBadgeText({ tabId, text }, () => {
      const error = chrome.runtime.lastError;
      if (error && !/No tab with id/i.test(error.message)) {
        console.warn('[badge] setBadgeText failed', error.message);
      }
      resolve();
    });
  });

const badgeCounter = createBadgeCounter({
  getActiveTab: async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tab;
  },
  getPartitionKey: getTabPartitionKey,
  getAllCookies,
  setBadgeText: setBadgeTextSafely,
});

const scheduleBadgeCounter = () => badgeCounter.schedule();

chrome.cookies.onChanged.addListener(scheduleBadgeCounter);
chrome.tabs.onUpdated.addListener(scheduleBadgeCounter);
chrome.tabs.onActivated.addListener(scheduleBadgeCounter);
chrome.windows.onFocusChanged.addListener(scheduleBadgeCounter);

const isFirefox = () =>
  chrome.runtime.getManifest().browser_specific_settings !== undefined;

const openReleases = () =>
  runBackgroundTask('tabs.create', () =>
    chrome.tabs.create({ url: UPDATE_RELEASES_URL }),
  );

const uninstallFromNotification = () => {
  if (typeof chrome.management?.uninstallSelf !== 'function') {
    console.warn('[notification] uninstallSelf is unavailable');
    return;
  }
  runBackgroundTask('management.uninstallSelf', () =>
    chrome.management.uninstallSelf({ showConfirmDialog: true }),
  );
};

// Update notification
chrome.runtime.onInstalled.addListener(({ previousVersion, reason }) => {
  if (reason !== 'update') return;

  const currentVersion = chrome.runtime.getManifest().version;
  runBackgroundTask('notifications.create', () =>
    chrome.notifications.create(
      UPDATE_NOTIFICATION_ID,
      buildUpdateNotificationOptions({
        previousVersion,
        currentVersion,
        iconUrl: chrome.runtime.getURL('images/icon128.png'),
        isFirefox: isFirefox(),
      }),
    ),
  );
});

registerUpdateNotificationHandlers({
  notifications: chrome.notifications,
  openReleases,
  uninstall: uninstallFromNotification,
});

// Save file message listener for firefox.
chrome.runtime.onMessage.addListener(
  createSaveMessageListener({ saveFile: saveToFile }),
);
