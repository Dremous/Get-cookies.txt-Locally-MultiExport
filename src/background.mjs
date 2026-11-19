import { createSaveMessageListener } from './modules/background_message.mjs';
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

/**
 * Update icon badge counter on active page
 */
const updateBadgeCounter = async () => {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab || typeof tab.id !== 'number') {
      return;
    }
    const { id: tabId, url: urlString } = tab;
    if (!urlString) {
      await setBadgeTextSafely(tabId, '');
      return;
    }
    const url = new URL(urlString);
    const partitionKey = await getTabPartitionKey(tab);
    const details = { url: url.href };
    if (partitionKey) details.partitionKey = partitionKey;
    const cookies = await getAllCookies(details);
    await setBadgeTextSafely(tabId, cookies.length.toFixed());
  } catch (error) {
    if (!/No tab with id/i.test(error?.message ?? '')) {
      console.warn('[badge] update failed', error);
    }
  }
};

chrome.cookies.onChanged.addListener(updateBadgeCounter);
chrome.tabs.onUpdated.addListener(updateBadgeCounter);
chrome.tabs.onActivated.addListener(updateBadgeCounter);
chrome.windows.onFocusChanged.addListener(updateBadgeCounter);

// Update notification
chrome.runtime.onInstalled.addListener(({ previousVersion, reason }) => {
  if (reason === 'update') {
    const currentVersion = chrome.runtime.getManifest().version;
    chrome.notifications.create('updated', {
      type: 'basic',
      title: 'Get cookies.txt LOCALLY',
      message: `Updated from ${previousVersion} to ${currentVersion}`,
      iconUrl: '/images/icon128.png',
      buttons: [{ title: 'Github Releases' }, { title: 'Uninstall' }],
    });
  }
});

// Update notification's button handler
chrome.notifications.onButtonClicked.addListener(
  (notificationId, buttonIndex) => {
    console.log(notificationId, buttonIndex);
    if (notificationId === 'updated') {
      switch (buttonIndex) {
        case 0:
          chrome.tabs.create({
            url: 'https://github.com/Dremous/Get-cookies.txt-Locally-MultiExport/releases',
          });
          break;
        case 1:
          chrome.management.uninstallSelf({ showConfirmDialog: true });
          break;
      }
    }
  },
);

// Save file message listener for firefox.
chrome.runtime.onMessage.addListener(
  createSaveMessageListener({ saveFile: saveToFile }),
);
