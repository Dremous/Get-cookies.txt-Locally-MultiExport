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

test('background save listener acknowledges a successful save asynchronously', async () => {
  let received;
  const listener = createSaveMessageListener({
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

test('background save listener reports save failures instead of throwing', async () => {
  const listener = createSaveMessageListener({
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
  const listener = createSaveMessageListener({
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
  const listener = createSaveMessageListener({ saveFile: async () => {} });
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
  const listener = createSaveMessageListener({ saveFile: async () => {} });
  let called = false;

  assert.equal(
    listener({ type: 'other', target: 'background' }, {}, () => {
      called = true;
    }),
    false,
  );
  assert.equal(called, false);
});
