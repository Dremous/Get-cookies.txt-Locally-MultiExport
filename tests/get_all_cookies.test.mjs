import assert from 'node:assert/strict';
import test from 'node:test';
import getAllCookies, {
  dedupeCookies,
  getAllCookiesForBatch,
  getTabPartitionKey,
} from '../src/modules/get_all_cookies.mjs';

const baseCookie = {
  domain: '.example.com',
  path: '/',
  name: 'chip',
  storeId: '0',
  secure: true,
};

/** @param {string} value @param {boolean} hasCrossSiteAncestor */
const partitioned = (value, hasCrossSiteAncestor) => ({
  ...baseCookie,
  value,
  partitionKey: {
    topLevelSite: 'https://example.com',
    hasCrossSiteAncestor,
  },
});

test('dedupeCookies keeps partition ancestry variants distinct', () => {
  const result = dedupeCookies([
    partitioned('same-site', false),
    partitioned('cross-site', true),
  ]);

  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((cookie) => cookie.value),
    ['same-site', 'cross-site'],
  );
});

test('dedupeCookies still removes identical cookies', () => {
  const cookie = partitioned('same', false);
  const result = dedupeCookies([cookie, { ...cookie }]);

  assert.equal(result.length, 1);
});

test('dedupeCookies keeps unpartitioned and partitioned cookies apart', () => {
  const result = dedupeCookies([
    { ...baseCookie, value: 'plain' },
    partitioned('partitioned', false),
  ]);

  assert.equal(result.length, 2);
});

const withChrome = async (fake, fn) => {
  const original = globalThis.chrome;
  globalThis.chrome = fake;
  try {
    return await fn();
  } finally {
    if (original === undefined) globalThis.chrome = undefined;
    else globalThis.chrome = original;
  }
};

test('getTabPartitionKey prefers the browser frame key', async () => {
  await withChrome(
    {
      cookies: {
        getPartitionKey: async () => ({
          partitionKey: {
            topLevelSite: 'https://example.com',
            hasCrossSiteAncestor: false,
          },
        }),
      },
    },
    async () => {
      assert.deepEqual(
        await getTabPartitionKey({ id: 7, url: 'https://www.example.com/' }),
        {
          topLevelSite: 'https://example.com',
          hasCrossSiteAncestor: false,
        },
      );
    },
  );
});

test('getTabPartitionKey falls back to the schemeful site', async () => {
  await withChrome({ cookies: {} }, async () => {
    assert.deepEqual(
      await getTabPartitionKey({ id: 7, url: 'https://www.example.com/a' }),
      { topLevelSite: 'https://example.com' },
    );
    assert.equal(await getTabPartitionKey(undefined), null);
  });
});

test('getTabPartitionKey skips the unsupported Firefox fallback', async () => {
  await withChrome(
    {
      runtime: {
        getManifest: () => ({ browser_specific_settings: { gecko: {} } }),
      },
      cookies: {},
    },
    async () => {
      assert.equal(
        await getTabPartitionKey({
          id: 7,
          url: 'https://www.example.com/a',
        }),
        null,
      );
    },
  );
});

test('getAllCookiesForBatch queries partitioned cookies without a URL filter', async () => {
  const calls = [];
  const plain = { ...baseCookie, value: 'plain' };
  const partitionedCookie = {
    ...baseCookie,
    value: 'partitioned',
    partitionKey: { topLevelSite: 'https://example.com' },
  };
  const fake = {
    runtime: { getManifest: () => ({ incognito: 'spanning' }) },
    tabs: {
      query: async () => [{ id: 7, url: 'https://www.example.com/page' }],
    },
    cookies: {
      getAllCookieStores: async () => [{ id: '0', tabIds: [7] }],
      getPartitionKey: async () => ({
        partitionKey: {
          topLevelSite: 'https://example.com',
          hasCrossSiteAncestor: false,
        },
      }),
      getAll: async (details) => {
        calls.push(details);
        return details.partitionKey ? [partitionedCookie] : [plain];
      },
    },
  };

  await withChrome(fake, async () => {
    const result = await getAllCookiesForBatch();
    assert.equal(result.length, 2);
    assert.ok(calls.every((details) => details.url === undefined));
    assert.deepEqual(calls[1].partitionKey, {
      topLevelSite: 'https://example.com',
    });
  });
});

test('getAllCookies queries partition cookies without the ancestor flag', async () => {
  const calls = [];
  const plain = { ...baseCookie, value: 'plain' };
  const partitionedCookie = partitioned('partitioned', true);
  const fake = {
    runtime: { getManifest: () => ({ incognito: 'spanning' }) },
    tabs: {
      query: async () => [{ id: 7, url: 'https://www.example.com/page' }],
    },
    cookies: {
      getAllCookieStores: async () => [{ id: '0', tabIds: [7] }],
      getAll: async (details) => {
        calls.push(details);
        return details.partitionKey ? [partitionedCookie] : [plain];
      },
    },
  };

  await withChrome(fake, async () => {
    const result = await getAllCookies({
      partitionKey: {
        topLevelSite: 'https://example.com',
        hasCrossSiteAncestor: false,
      },
    });

    assert.equal(result.length, 2);
    assert.deepEqual(calls[0].partitionKey, {
      topLevelSite: 'https://example.com',
    });
    assert.equal(calls[0].url, undefined);
  });
});

test('getAllCookies deduplicates overlapping plain and partitioned results', async () => {
  const cookie = partitioned('same', false);
  const fake = {
    runtime: { getManifest: () => ({ incognito: 'spanning' }) },
    tabs: { query: async () => [] },
    cookies: {
      getAllCookieStores: async () => [],
      getAll: async () => [cookie],
    },
  };

  await withChrome(fake, async () => {
    const result = await getAllCookies({
      partitionKey: {
        topLevelSite: 'https://example.com',
        hasCrossSiteAncestor: false,
      },
    });
    assert.equal(result.length, 1);
  });
});

test('getAllCookies tolerates a missing active tab', async () => {
  const calls = [];
  const fake = {
    runtime: { getManifest: () => ({ incognito: 'spanning' }) },
    tabs: { query: async () => [] },
    cookies: {
      getAllCookieStores: async () => [],
      getAll: async (details) => {
        calls.push(details);
        return [];
      },
    },
  };

  await withChrome(fake, async () => {
    assert.deepEqual(await getAllCookies({}), []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].storeId, undefined);
  });
});

test('getAllCookies reports a partition query failure through the callback', async () => {
  const errors = [];
  const plain = { ...baseCookie, value: 'plain' };
  const fake = {
    runtime: { getManifest: () => ({ incognito: 'spanning' }) },
    tabs: { query: async () => [] },
    cookies: {
      getAllCookieStores: async () => [],
      getAll: async (details) => {
        if (details.partitionKey) throw new Error('partition query failed');
        return [plain];
      },
    },
  };

  await withChrome(fake, async () => {
    const result = await getAllCookies(
      {
        partitionKey: {
          topLevelSite: 'https://example.com',
          hasCrossSiteAncestor: false,
        },
      },
      { onPartitionError: (error) => errors.push(error) },
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].value, 'plain');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /partition query failed/);
  });
});

test('getAllCookiesForBatch forwards partition failures to the caller', async () => {
  const errors = [];
  const plain = { ...baseCookie, value: 'plain' };
  const fake = {
    runtime: { getManifest: () => ({ incognito: 'spanning' }) },
    tabs: { query: async () => [{ id: 7, url: 'https://www.example.com/' }] },
    cookies: {
      getAllCookieStores: async () => [{ id: '0', tabIds: [7] }],
      getPartitionKey: async () => ({
        partitionKey: { topLevelSite: 'https://example.com' },
      }),
      getAll: async (details) => {
        if (details.partitionKey) throw new Error('partition query failed');
        return [plain];
      },
    },
  };

  await withChrome(fake, async () => {
    const result = await getAllCookiesForBatch(undefined, {
      onPartitionError: (error) => errors.push(error),
    });

    assert.equal(result.length, 1);
    assert.equal(errors.length, 1);
  });
});
