import assert from 'node:assert/strict';
import test from 'node:test';
import { dedupeCookies } from '../src/modules/get_all_cookies.mjs';

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
