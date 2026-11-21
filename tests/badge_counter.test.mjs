import assert from 'node:assert/strict';
import test from 'node:test';
import { createBadgeCounter } from '../src/modules/badge_counter.mjs';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
};

const cookies = (count) =>
  Array.from({ length: count }, (_, index) => ({
    name: `cookie-${index}`,
    value: 'value',
  }));

const baseOptions = (overrides = {}) => ({
  getActiveTab: async () => ({ id: 7, url: 'https://example.com/' }),
  getPartitionKey: async () => null,
  getAllCookies: async () => cookies(2),
  setBadgeText: async () => {},
  logger: { warn: () => {} },
  ...overrides,
});

test('badge counter ignores a slower stale query', async () => {
  const tabRequests = [];
  const updates = [];
  const counter = createBadgeCounter(
    baseOptions({
      getActiveTab: () => {
        const request = deferred();
        tabRequests.push(request);
        return request.promise;
      },
      getAllCookies: async ({ url }) => cookies(url.includes('two') ? 1 : 3),
      setBadgeText: async (tabId, text) => updates.push([tabId, text]),
    }),
  );

  const first = counter.update();
  const second = counter.update();

  tabRequests[1].resolve({ id: 2, url: 'https://two.example/' });
  await second;

  tabRequests[0].resolve({ id: 1, url: 'https://one.example/' });
  await first;

  assert.deepEqual(updates, [[2, '1']]);
});

test('badge counter passes the captured tab to the cookie query', async () => {
  let receivedOptions;
  const tab = { id: 7, url: 'https://example.com/' };
  const counter = createBadgeCounter(
    baseOptions({
      getActiveTab: async () => tab,
      getAllCookies: async (_details, options) => {
        receivedOptions = options;
        return cookies(2);
      },
    }),
  );

  await counter.update();

  assert.equal(receivedOptions.activeTab, tab);
});

test('badge counter debounces repeated events to one trailing update', async () => {
  const timers = [];
  const updates = [];
  const counter = createBadgeCounter(
    baseOptions({
      debounceMs: 25,
      setTimeoutFn: (callback) => {
        const timer = { callback, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeoutFn: (timer) => {
        timer.cleared = true;
      },
      setBadgeText: async (tabId, text) => updates.push([tabId, text]),
    }),
  );

  counter.schedule();
  counter.schedule();

  assert.equal(timers.length, 2);
  assert.equal(timers[0].cleared, true);
  assert.equal(timers[1].cleared, false);

  timers[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(updates, [[7, '2']]);
});

test('badge counter clears the badge when the query fails', async () => {
  const updates = [];
  const counter = createBadgeCounter(
    baseOptions({
      getAllCookies: async () => {
        throw new Error('partition query failed');
      },
      setBadgeText: async (tabId, text) => updates.push([tabId, text]),
    }),
  );

  await counter.update();

  assert.deepEqual(updates, [[7, '']]);
});

test('badge counter does not clear a newer badge after a stale failure', async () => {
  const tabRequests = [];
  const updates = [];
  let rejectFirst;
  const counter = createBadgeCounter(
    baseOptions({
      getActiveTab: () => {
        const request = deferred();
        if (!tabRequests.length) rejectFirst = request.reject;
        tabRequests.push(request);
        return request.promise;
      },
      setBadgeText: async (tabId, text) => updates.push([tabId, text]),
    }),
  );

  const first = counter.update();
  const second = counter.update();

  tabRequests[1].resolve({ id: 2, url: 'https://example.com/' });
  await second;

  rejectFirst(new Error('tab closed'));
  await first;

  assert.deepEqual(updates, [[2, '2']]);
});
