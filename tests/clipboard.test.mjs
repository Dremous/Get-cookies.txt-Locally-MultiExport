import assert from 'node:assert/strict';
import test from 'node:test';
import { writeClipboard } from '../src/modules/clipboard.mjs';

test('writeClipboard writes through the async Clipboard API', async () => {
  let value;
  await writeClipboard('cookie=value', {
    writeText: async (text) => {
      value = text;
    },
  });
  assert.equal(value, 'cookie=value');
});

test('writeClipboard surfaces a denied clipboard write', async () => {
  await assert.rejects(
    () =>
      writeClipboard('cookie=value', {
        writeText: async () => {
          throw new Error('Clipboard access denied');
        },
      }),
    /Clipboard access denied/,
  );
});

test('writeClipboard rejects when the API is unavailable', async () => {
  await assert.rejects(
    () => writeClipboard('cookie=value', undefined),
    /Clipboard API unavailable/,
  );
});
