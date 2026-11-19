import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getSiteKey,
  groupCookiesBySite,
  matchesSiteQuery,
  normalizeDomain,
  toSiteList,
} from '../src/modules/site_group.mjs';

/** @param {Partial<chrome.cookies.Cookie>} overrides */
const cookie = (overrides = {}) => ({
  domain: '.example.com',
  path: '/',
  secure: true,
  name: 'sid',
  value: 'abc',
  expirationDate: 1893456000,
  ...overrides,
});

test('normalizeDomain strips leading dots and lowercases', () => {
  assert.equal(normalizeDomain('.Example.COM'), 'example.com');
  assert.equal(normalizeDomain('example.com.'), 'example.com');
  assert.equal(normalizeDomain(undefined), '');
});

test('getSiteKey folds subdomains into the registrable domain', () => {
  assert.equal(getSiteKey('.example.com'), 'example.com');
  assert.equal(getSiteKey('www.example.com'), 'example.com');
  assert.equal(getSiteKey('a.b.example.com'), 'example.com');
  assert.equal(getSiteKey('example.co.uk'), 'example.co.uk');
  assert.equal(getSiteKey('shop.example.co.uk'), 'example.co.uk');
  assert.equal(getSiteKey('foo.example.com.cn'), 'example.com.cn');
});

test('getSiteKey separates tenants of private public suffixes', () => {
  assert.equal(getSiteKey('alice.github.io'), 'alice.github.io');
  assert.equal(getSiteKey('bob.github.io'), 'bob.github.io');
  assert.equal(getSiteKey('foo.vercel.app'), 'foo.vercel.app');
  assert.equal(getSiteKey('bar.vercel.app'), 'bar.vercel.app');
  assert.equal(
    getSiteKey('bucket.s3.amazonaws.com'),
    'bucket.s3.amazonaws.com',
  );
  assert.equal(getSiteKey('other.s3.amazonaws.com'), 'other.s3.amazonaws.com');
  assert.equal(getSiteKey('github.io'), 'github.io');
  assert.equal(getSiteKey('vercel.app'), 'vercel.app');
  assert.equal(getSiteKey('s3.amazonaws.com'), 's3.amazonaws.com');
});

test('getSiteKey keeps normal subdomains grouped', () => {
  assert.equal(getSiteKey('www.example.com'), 'example.com');
  assert.equal(getSiteKey('api.example.com'), 'example.com');
  assert.equal(getSiteKey('shop.example.co.uk'), 'example.co.uk');
});

test('groupCookiesBySite keeps shared-suffix tenants in separate buckets', () => {
  const groups = groupCookiesBySite([
    cookie({ domain: '.alice.github.io' }),
    cookie({ domain: '.bob.github.io' }),
    cookie({ domain: '.foo.vercel.app' }),
    cookie({ domain: '.bar.vercel.app' }),
  ]);

  assert.deepEqual([...groups.keys()].sort(), [
    'alice.github.io',
    'bar.vercel.app',
    'bob.github.io',
    'foo.vercel.app',
  ]);
});

test('getSiteKey keeps localhost and IP addresses intact', () => {
  assert.equal(getSiteKey('localhost'), 'localhost');
  assert.equal(getSiteKey('127.0.0.1'), '127.0.0.1');
  assert.equal(getSiteKey('::1'), '::1');
  assert.equal(getSiteKey(''), '');
});

test('groupCookiesBySite groups cookies coming from different subdomains', () => {
  const cookies = [
    cookie({ domain: '.example.com', name: 'a' }),
    cookie({ domain: 'www.example.com', name: 'b' }),
    cookie({ domain: 'api.example.com', name: 'c' }),
    cookie({ domain: '.other.org', name: 'd' }),
  ];
  const groups = groupCookiesBySite(cookies);

  assert.equal(groups.size, 2);
  assert.equal(groups.get('example.com')?.cookies.length, 3);
  assert.equal(groups.get('example.com')?.domains.size, 3);
  assert.equal(groups.get('other.org')?.cookies.length, 1);
});

test('toSiteList sorts sites alphabetically and exposes counts', () => {
  const groups = groupCookiesBySite([
    cookie({ domain: '.zeta.dev' }),
    cookie({ domain: '.alpha.dev', name: 'x' }),
    cookie({ domain: '.alpha.dev', name: 'y' }),
  ]);
  const list = toSiteList(groups);

  assert.deepEqual(
    list.map((entry) => entry.site),
    ['alpha.dev', 'zeta.dev'],
  );
  assert.equal(list[0].cookieCount, 2);
  assert.equal(list[1].cookieCount, 1);
});

test('matchesSiteQuery is case-insensitive and trims input', () => {
  assert.equal(matchesSiteQuery({ site: 'github.com' }, '  GIT '), true);
  assert.equal(matchesSiteQuery({ site: 'github.com' }, 'gitlab'), false);
  assert.equal(matchesSiteQuery({ site: 'github.com' }, ''), true);
});
