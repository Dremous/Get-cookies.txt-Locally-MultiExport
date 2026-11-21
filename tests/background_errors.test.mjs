import assert from 'node:assert/strict';
import test from 'node:test';
import { runBackgroundTask } from '../src/modules/background_errors.mjs';

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('runBackgroundTask catches rejected promises', async () => {
  let warning;
  runBackgroundTask(
    'notifications.create',
    () => Promise.reject(new Error('notification failed')),
    {
      warn: (...args) => {
        warning = args;
      },
    },
  );

  await nextTurn();

  assert.equal(warning[0], '[background] notifications.create failed');
  assert.match(warning[1].message, /notification failed/);
});

test('runBackgroundTask catches synchronous API failures', () => {
  let warning;
  runBackgroundTask(
    'management.uninstallSelf',
    () => {
      throw new Error('management unavailable');
    },
    {
      warn: (...args) => {
        warning = args;
      },
    },
  );

  assert.equal(warning[0], '[background] management.uninstallSelf failed');
  assert.match(warning[1].message, /management unavailable/);
});

test('runBackgroundTask ignores successful calls', async () => {
  let warning;
  runBackgroundTask('tabs.create', () => Promise.resolve(), {
    warn: (...args) => {
      warning = args;
    },
  });

  await nextTurn();

  assert.equal(warning, undefined);
});
