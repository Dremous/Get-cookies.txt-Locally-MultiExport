export const UPDATE_NOTIFICATION_ID = 'updated';
export const UPDATE_RELEASES_URL =
  'https://github.com/Dremous/Get-cookies.txt-Locally-MultiExport/releases';

/**
 * Firefox notifications only support type/title/message/iconUrl. Keep the
 * update notice usable there by omitting the Chrome-only buttons.
 * @param {{
 *   previousVersion?: string,
 *   currentVersion: string,
 *   iconUrl: string,
 *   isFirefox: boolean,
 * }} options
 */
export const buildUpdateNotificationOptions = ({
  previousVersion,
  currentVersion,
  iconUrl,
  isFirefox,
}) => {
  const options = {
    type: 'basic',
    title: 'Get cookies.txt LOCALLY',
    message: `Updated from ${previousVersion ?? 'unknown'} to ${currentVersion}`,
    iconUrl,
  };

  if (!isFirefox) {
    options.buttons = [{ title: 'Github Releases' }, { title: 'Uninstall' }];
  }

  return options;
};

/**
 * Register only the notification events the current platform exposes.
 * Firefox has onClicked but not onButtonClicked; Chrome has both.
 * @param {{
 *   notifications: {
 *     onClicked?: { addListener?: (listener: (id: string) => void) => void },
 *     onButtonClicked?: {
 *       addListener?: (listener: (id: string, index: number) => void) => void,
 *     },
 *   },
 *   openReleases: () => void,
 *   uninstall: () => void,
 *   logger?: Pick<Console, 'warn'>,
 * }} options
 */
export const registerUpdateNotificationHandlers = ({
  notifications,
  openReleases,
  uninstall,
  logger = console,
}) => {
  const onClicked = (notificationId) => {
    if (notificationId === UPDATE_NOTIFICATION_ID) openReleases();
  };

  const onButtonClicked = (notificationId, buttonIndex) => {
    if (notificationId !== UPDATE_NOTIFICATION_ID) return;

    if (buttonIndex === 0) {
      openReleases();
      return;
    }
    if (buttonIndex === 1) {
      if (typeof uninstall === 'function') uninstall();
      else logger.warn('[notification] uninstall is unavailable');
    }
  };

  if (typeof notifications?.onClicked?.addListener === 'function') {
    notifications.onClicked.addListener(onClicked);
  }
  if (typeof notifications?.onButtonClicked?.addListener === 'function') {
    notifications.onButtonClicked.addListener(onButtonClicked);
  }
};
