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
