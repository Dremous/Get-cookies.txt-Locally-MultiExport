import { runBackgroundTask } from './modules/background_errors.mjs';
import { createSaveMessageListener } from './modules/background_message.mjs';
import { createBadgeCounter } from './modules/badge_counter.mjs';
import getAllCookies, {
  getTabPartitionKey,
} from './modules/get_all_cookies.mjs';
import saveToFile from './modules/save_to_file.mjs';

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

// Update notification
chrome.runtime.onInstalled.addListener(({ previousVersion, reason }) => {
  if (reason === 'update') {
    const currentVersion = chrome.runtime.getManifest().version;
    runBackgroundTask('notifications.create', () =>
      chrome.notifications.create('updated', {
        type: 'basic',
        title: 'Get cookies.txt LOCALLY',
        message: `Updated from ${previousVersion} to ${currentVersion}`,
        iconUrl: '/images/icon128.png',
        buttons: [{ title: 'Github Releases' }, { title: 'Uninstall' }],
      }),
    );
  }
});

// Update notification's button handler
chrome.notifications.onButtonClicked.addListener(
  (notificationId, buttonIndex) => {
    console.log(notificationId, buttonIndex);
    if (notificationId === 'updated') {
      switch (buttonIndex) {
        case 0:
          runBackgroundTask('tabs.create', () =>
            chrome.tabs.create({
              url: 'https://github.com/Dremous/Get-cookies.txt-Locally-MultiExport/releases',
            }),
          );
          break;
        case 1:
          runBackgroundTask('management.uninstallSelf', () =>
            chrome.management.uninstallSelf({ showConfirmDialog: true }),
          );
          break;
      }
    }
  },
);

// Save file message listener for firefox.
chrome.runtime.onMessage.addListener(
  createSaveMessageListener({ saveFile: saveToFile }),
);
