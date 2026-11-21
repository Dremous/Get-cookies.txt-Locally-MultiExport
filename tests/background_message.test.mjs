import assert from 'node:assert/strict';
import test from 'node:test';
import { createSaveMessageListener } from '../src/modules/background_message.mjs';

const saveMessage = {
  type: 'save',
  target: 'background',
  data: {
    text: 'cookie=value',
    name: 'cookies',
    format: { ext: '.txt', mimeType: 'text/plain' },
    saveAs: false,
  },
};

const createListener = (options = {}) =>
  createSaveMessageListener({
    isTrustedSender: () => true,
    ...options,
  });

test('background save listener acknowledges a successful save asynchronously', async () => {
  let received;
  const listener = createListener({
    saveFile: async (...args) => {
      received = args;
    },
  });

  const response = new Promise((resolve) => {
    const handled = listener(saveMessage, {}, resolve);
    assert.equal(handled, true);
  });

  assert.deepEqual(await response, { ok: true });
  assert.equal(received[0], 'cookie=value');
  assert.equal(received[1], 'cookies');
  assert.equal(received[3], false);
});

test('background save listener reports a timeout instead of hanging', async () => {
  let timeoutCallback;
  const listener = createListener({
    saveFile: () => new Promise(() => {}),
    timeoutMs: 100,
    setTimeoutFn: (callback) => {
      timeoutCallback = callback;
      return 'save-timer';
    },
    clearTimeoutFn: () => {},
  });

  const response = new Promise((resolve) => {
    assert.equal(listener(saveMessage, {}, resolve), true);
  });

  timeoutCallback();

  assert.deepEqual(await response, { ok: false, error: 'Save timed out' });
});

test('background save listener defaults to a one-minute timeout', () => {
  let timeoutDelay;
  const listener = createListener({
    saveFile: () => new Promise(() => {}),
    setTimeoutFn: (_callback, delay) => {
      timeoutDelay = delay;
      return 'default-timer';
    },
    clearTimeoutFn: () => {},
  });

  assert.equal(
    listener(saveMessage, {}, () => {}),
    true,
  );
  assert.equal(timeoutDelay, 60_000);
});

test('background save listener gives saveAs a longer timeout', async () => {
  let timeoutDelay;
  let timeoutCallback;
  const listener = createListener({
    saveFile: () => new Promise(() => {}),
    timeoutMs: 100,
    saveAsTimeoutMs: 500,
    setTimeoutFn: (callback, delay) => {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return 'save-as-timer';
    },
    clearTimeoutFn: () => {},
  });

  const response = new Promise((resolve) => {
    assert.equal(
      listener(
        {
          ...saveMessage,
          data: { ...saveMessage.data, saveAs: true },
        },
        {},
        resolve,
      ),
      true,
    );
  });

  assert.equal(timeoutDelay, 500);
  timeoutCallback();

  assert.deepEqual(await response, {
    ok: false,
    error: 'Save timed out; the download may still complete in the background.',
  });
});

test('background save listener reports save failures instead of throwing', async () => {
  const listener = createListener({
    saveFile: async () => {
      throw new Error('disk full');
    },
  });

  const response = new Promise((resolve) => {
    assert.equal(listener(saveMessage, {}, resolve), true);
  });

  assert.deepEqual(await response, { ok: false, error: 'disk full' });
});

test('background save listener decodes base64 payloads', async () => {
  let received;
  const listener = createListener({
    saveFile: async (data) => {
      received = data;
    },
  });

  const response = new Promise((resolve) => {
    assert.equal(
      listener(
        {
          ...saveMessage,
          data: {
            ...saveMessage.data,
            text: undefined,
            base64: Buffer.from('cookies').toString('base64'),
          },
        },
        {},
        resolve,
      ),
      true,
    );
  });

  assert.deepEqual(await response, { ok: true });
  assert.ok(received instanceof Uint8Array);
  assert.equal(Buffer.from(received).toString(), 'cookies');
});

test('background save listener rejects missing payloads synchronously', () => {
  const listener = createListener({ saveFile: async () => {} });
  let response;

  assert.equal(
    listener({ type: 'save', target: 'background', data: {} }, {}, (value) => {
      response = value;
    }),
    false,
  );
  assert.deepEqual(response, { ok: false, error: 'Missing save payload' });
});

test('background save listener ignores unrelated messages', () => {
  const listener = createListener({ saveFile: async () => {} });
  let called = false;

  assert.equal(
    listener({ type: 'other', target: 'background' }, {}, () => {
      called = true;
    }),
    false,
  );
  assert.equal(called, false);
});

test('background save listener rejects untrusted senders', () => {
  const listener = createSaveMessageListener({
    saveFile: async () => {},
    isTrustedSender: () => false,
  });
  let called = false;

  assert.equal(
    listener(
      saveMessage,
      { id: 'other-extension', url: 'https://example.com' },
      () => {
        called = true;
      },
    ),
    false,
  );
  assert.equal(called, false);
});

test('background save listener default sender check uses the extension URL prefix', async () => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      id: 'extension-id',
      getURL: () => 'chrome-extension://extension-id/',
    },
  };
  try {
    const listener = createSaveMessageListener({ saveFile: async () => {} });
    const response = new Promise((resolve) => {
      assert.equal(
        listener(
          saveMessage,
          {
            id: 'extension-id',
            url: 'chrome-extension://extension-id/popup.html',
          },
          resolve,
        ),
        true,
      );
    });
    assert.deepEqual(await response, { ok: true });

    let called = false;
    assert.equal(
      listener(
        saveMessage,
        { id: 'extension-id', url: 'https://example.com/content-script' },
        () => {
          called = true;
        },
      ),
      false,
    );
    assert.equal(called, false);
  } finally {
    globalThis.chrome = previousChrome;
  }
});
