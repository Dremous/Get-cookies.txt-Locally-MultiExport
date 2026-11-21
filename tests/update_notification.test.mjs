import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UPDATE_NOTIFICATION_ID,
  UPDATE_RELEASES_URL,
  buildUpdateNotificationOptions,
  registerUpdateNotificationHandlers,
} from '../src/modules/update_notification.mjs';

test('update notification omits Chrome-only buttons on Firefox', () => {
  const options = buildUpdateNotificationOptions({
    previousVersion: '0.8.8',
    currentVersion: '0.8.9',
    iconUrl: 'moz-extension://test/images/icon128.png',
    isFirefox: true,
  });

  assert.equal(options.type, 'basic');
  assert.equal(options.message, 'Updated from 0.8.8 to 0.8.9');
  assert.equal(options.iconUrl, 'moz-extension://test/images/icon128.png');
  assert.equal('buttons' in options, false);
});

test('update notification keeps both buttons on Chrome', () => {
  const options = buildUpdateNotificationOptions({
    previousVersion: '0.8.8',
    currentVersion: '0.8.9',
    iconUrl: 'chrome-extension://test/images/icon128.png',
    isFirefox: false,
  });

  assert.deepEqual(options.buttons, [
    { title: 'Github Releases' },
    { title: 'Uninstall' },
  ]);
});

test('notification click opens releases and button actions stay scoped', () => {
  let clicked;
  let buttonClicked;
  let opens = 0;
  let uninstalls = 0;
  const notifications = {
    onClicked: {
      addListener: (listener) => {
        clicked = listener;
      },
    },
    onButtonClicked: {
      addListener: (listener) => {
        buttonClicked = listener;
      },
    },
  };

  registerUpdateNotificationHandlers({
    notifications,
    openReleases: () => {
      opens += 1;
    },
    uninstall: () => {
      uninstalls += 1;
    },
  });

  clicked(UPDATE_NOTIFICATION_ID);
  clicked('other');
  assert.equal(opens, 1);

  buttonClicked(UPDATE_NOTIFICATION_ID, 0);
  buttonClicked(UPDATE_NOTIFICATION_ID, 1);
  buttonClicked('other', 0);
  assert.equal(opens, 2);
  assert.equal(uninstalls, 1);
  assert.equal(UPDATE_RELEASES_URL.includes('/releases'), true);
});

test('registering notification handlers tolerates missing Chrome-only events', () => {
  let clicked;
  const warnings = [];
  const notifications = {
    onClicked: {
      addListener: (listener) => {
        clicked = listener;
      },
    },
  };

  assert.doesNotThrow(() =>
    registerUpdateNotificationHandlers({
      notifications,
      openReleases: () => {},
      uninstall: () => {},
      logger: {
        warn: (...args) => warnings.push(args),
      },
    }),
  );

  clicked(UPDATE_NOTIFICATION_ID);
  assert.equal(warnings.length, 0);
});
