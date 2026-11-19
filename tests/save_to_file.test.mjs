import assert from 'node:assert/strict';
import test from 'node:test';
import saveToFile from '../src/modules/save_to_file.mjs';

const withDownloads = async (fake, fn) => {
  const originalChrome = globalThis.chrome;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const revoked = [];
  let createCount = 0;

  URL.createObjectURL = (blob) => {
    createCount += 1;
    return originalCreateObjectURL(blob);
  };
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
    originalRevokeObjectURL(url);
  };
  globalThis.chrome = { downloads: fake };

  try {
    await fn({ revoked, createCount: () => createCount });
  } finally {
    if (originalChrome === undefined) globalThis.chrome = undefined;
    else globalThis.chrome = originalChrome;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
};

test('saveToFile revokes the object URL when the download already finished', async () => {
  const listeners = new Set();
  const fake = {
    download: async () => 42,
    search: async () => [{ id: 42, state: 'complete' }],
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    },
  };

  await withDownloads(fake, async ({ revoked }) => {
    await saveToFile('cookie=value', 'cookies', {
      ext: '.txt',
      mimeType: 'text/plain',
    });
    assert.equal(listeners.size, 0);
    assert.equal(revoked.length, 1);
  });
});

test('saveToFile revokes the object URL after a normal completion event', async () => {
  const listeners = new Set();
  let listener;
  const fake = {
    download: async () => 42,
    search: async () => [{ id: 42, state: 'in_progress' }],
    onChanged: {
      addListener: (value) => {
        listener = value;
        listeners.add(value);
      },
      removeListener: (value) => listeners.delete(value),
    },
  };

  await withDownloads(fake, async ({ revoked }) => {
    await saveToFile('cookie=value', 'cookies', {
      ext: '.txt',
      mimeType: 'text/plain',
    });
    assert.equal(listeners.size, 1);
    listener({ id: 42, state: { current: 'complete' } });
    assert.equal(listeners.size, 0);
    assert.equal(revoked.length, 1);
  });
});

test('saveToFile revokes the object URL when download() rejects', async () => {
  const fake = {
    download: async () => {
      throw new Error('download denied');
    },
    search: async () => [],
    onChanged: {
      addListener: () => {},
      removeListener: () => {},
    },
  };

  await withDownloads(fake, async ({ revoked }) => {
    await assert.rejects(
      () =>
        saveToFile('cookie=value', 'cookies', {
          ext: '.txt',
          mimeType: 'text/plain',
        }),
      /download denied/,
    );
    assert.equal(revoked.length, 1);
  });
});
