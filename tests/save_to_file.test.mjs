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

test('saveToFile keeps the object URL alive when search is temporarily empty', async () => {
  const listeners = new Set();
  let listener;
  const fake = {
    download: async () => 42,
    search: async () => [],
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
    assert.equal(revoked.length, 0);

    listener({ id: 42, state: { current: 'complete' } });
    assert.equal(listeners.size, 0);
    assert.equal(revoked.length, 1);
  });
});

const withDocument = async (documentFake, fn) => {
  const originalDocument = globalThis.document;
  globalThis.document = documentFake;
  try {
    await fn();
  } finally {
    if (originalDocument === undefined) globalThis.document = undefined;
    else globalThis.document = originalDocument;
  }
};

test('saveToFile uses an anchor for Chrome blob filenames', async () => {
  let createdListener;
  let changedListener;
  let clicked = false;
  const anchor = {
    href: '',
    download: '',
    rel: '',
    style: {},
    click: () => {
      clicked = true;
    },
    remove: () => {},
  };
  const fake = {
    download: async () => {
      throw new Error('downloads.download should not run for normal exports');
    },
    onCreated: {
      addListener: (listener) => {
        createdListener = listener;
      },
      removeListener: (listener) => {
        if (createdListener === listener) createdListener = undefined;
      },
    },
    onChanged: {
      addListener: (listener) => {
        changedListener = listener;
      },
      removeListener: () => {},
    },
  };
  const body = {
    appendChild: () => {},
  };
  const documentFake = {
    createElement: () => anchor,
    body,
  };

  await withDownloads(fake, async ({ revoked }) => {
    await withDocument(documentFake, async () => {
      await saveToFile('cookie=value', 'cookies', {
        ext: '.txt',
        mimeType: 'text/plain',
      });
      assert.equal(anchor.download, 'cookies.txt');
      assert.equal(anchor.href.startsWith('blob:'), true);
      assert.equal(clicked, true);

      createdListener({ id: 7, url: anchor.href });
      changedListener({ id: 7, state: { current: 'complete' } });
      assert.equal(revoked.length, 1);
    });
  });
});
test('saveToFile uses the downloads API for save-as', async () => {
  let downloadDetails;
  const listeners = new Set();
  const fake = {
    download: async (details) => {
      downloadDetails = details;
      return 42;
    },
    search: async () => [{ id: 42, state: 'in_progress' }],
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    },
  };

  await withDownloads(fake, async ({ revoked }) => {
    await saveToFile(
      'cookie=value',
      'cookies',
      { ext: '.txt', mimeType: 'text/plain' },
      true,
    );
    assert.equal(downloadDetails.filename, 'cookies.txt');
    assert.equal(downloadDetails.saveAs, true);
    assert.equal(revoked.length, 0);

    for (const listener of listeners)
      listener({ id: 42, state: { current: 'complete' } });
    assert.equal(listeners.size, 0);
    assert.equal(revoked.length, 1);
  });
});

test('saveToFile suggests the requested filename when Chrome ignores it', async () => {
  let determineFilename;
  let downloadDetails;
  const suggestions = [];
  const listeners = new Set();
  const fake = {
    download: async (details) => {
      downloadDetails = details;
      return 42;
    },
    search: async () => [{ id: 42, state: 'in_progress' }],
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    },
    onDeterminingFilename: {
      addListener: (listener) => {
        determineFilename = listener;
      },
    },
  };

  await withDownloads(fake, async ({ revoked }) => {
    await saveToFile('cookie=value', 'cookies', {
      ext: '.txt',
      mimeType: 'text/plain',
    });
    assert.equal(typeof determineFilename, 'function');
    assert.equal(listeners.size, 1);
    assert.equal(revoked.length, 0);

    determineFilename({ url: downloadDetails.url, id: 42 }, (value) => {
      suggestions.push(value);
    });
    assert.deepEqual(suggestions[0], {
      filename: 'cookies.txt',
      conflictAction: 'uniquify',
    });

    for (const listener of listeners)
      listener({ id: 42, state: { current: 'complete' } });
    assert.equal(listeners.size, 0);
    assert.equal(revoked.length, 1);
  });
});
