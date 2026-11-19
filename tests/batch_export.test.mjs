import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildBatchExport,
  buildBatchExportFromCookies,
  serializeCombined,
  toSafeFileName,
} from '../src/modules/batch_export.mjs';

const DATE = new Date('2026-11-17T10:30:00');

/** @param {string} domain @param {string} name */
const cookie = (domain, name, overrides = {}) => ({
  domain,
  path: '/',
  secure: true,
  name,
  value: `value-${name}`,
  expirationDate: 1893456000,
  ...overrides,
});

const groups = [
  {
    site: 'example.com',
    cookies: [cookie('.example.com', 'sid'), cookie('www.example.com', 'lang')],
  },
  { site: 'other.org', cookies: [cookie('.other.org', 'token')] },
];

test('toSafeFileName produces download-safe names', () => {
  assert.equal(toSafeFileName('example.com'), 'example.com');
  assert.equal(toSafeFileName('foo/bar baz'), 'foo_bar_baz');
  assert.equal(toSafeFileName(''), 'site');
  assert.equal(toSafeFileName('例子.com'), '例子.com');
  assert.equal(toSafeFileName('测试.com'), '测试.com');
  assert.ok(Buffer.byteLength(toSafeFileName('中'.repeat(100))) <= 80);
});

test('combined Netscape export lists every site and cookie row', () => {
  const text = serializeCombined(groups, 'netscape');

  assert.match(text, /^# Netscape HTTP Cookie File/);
  assert.match(text, /# Sites: example\.com, other\.org/);
  assert.match(text, /# --- example\.com \(2 cookies\) ---/);
  assert.match(text, /# --- other\.org \(1 cookies\) ---/);
  assert.match(text, /\.example\.com\tTRUE\t\/\tTRUE/);
  assert.match(text, /\.other\.org\tTRUE\t\/\tTRUE/);
  assert.equal(
    text.split('\n').filter((line) => line.includes('\t')).length,
    3,
  );
});

test('header export is limited to a single site', () => {
  assert.throws(
    () =>
      serializeCombined(
        [
          { site: 'a.com', cookies: [cookie('.a.com', 'sid')] },
          { site: 'b.com', cookies: [cookie('.b.com', 'sid')] },
        ],
        'header',
      ),
    /single site/,
  );

  const text = serializeCombined(
    [{ site: 'a.com', cookies: [cookie('.a.com', 'sid')] }],
    'header',
  );
  assert.equal(text, 'sid=value-sid;');
});

test('combined JSON export stays a flat cookie array', () => {
  const text = serializeCombined(groups, 'json');
  const parsed = JSON.parse(text);
  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].domain, '.example.com');
});

test('zip mode returns one archive with a file per site', () => {
  const { files, totalCookies } = buildBatchExport({
    groups,
    formatKey: 'netscape',
    mode: 'zip',
    date: DATE,
  });

  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'cookies_2sites_20261117.zip');
  assert.equal(totalCookies, 3);
  assert.ok(files[0].data instanceof Uint8Array);
});

test('zip archive contains readable per-site cookie files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'batch-zip-'));
  const archivePath = path.join(dir, 'cookies.zip');
  const { files } = buildBatchExport({
    groups,
    formatKey: 'netscape',
    mode: 'zip',
    date: DATE,
  });
  writeFileSync(archivePath, files[0].data);

  const listing = execFileSync('unzip', ['-l', archivePath], {
    encoding: 'utf8',
  });
  assert.match(listing, /_sites\.txt/);
  assert.match(listing, /example\.com_cookies_20261117\.txt/);
  assert.match(listing, /other\.org_cookies_20261117\.txt/);

  const content = execFileSync(
    'unzip',
    ['-p', archivePath, 'other.org_cookies_20261117.txt'],
    { encoding: 'utf8' },
  );
  assert.match(content, /\.other\.org\tTRUE\t\/\tTRUE/);

  rmSync(dir, { recursive: true, force: true });
});

test('combined mode names the file with site count and date', () => {
  const { files } = buildBatchExport({
    groups,
    formatKey: 'netscape',
    mode: 'combined',
    date: DATE,
  });
  assert.equal(files[0].name, 'cookies_all_2sites_20261117.txt');
});

test('separate mode returns one unique file per site', () => {
  const groupsWithDuplicate = [
    ...groups,
    { site: 'example.com', cookies: [cookie('.example.com', 'dup')] },
  ];
  const { files } = buildBatchExport({
    groups: groupsWithDuplicate,
    formatKey: 'netscape',
    mode: 'separate',
    date: DATE,
  });

  assert.equal(files.length, 3);
  assert.equal(new Set(files.map((file) => file.name)).size, 3);
  assert.ok(files.every((file) => file.name.endsWith('.txt')));
});

test('separate mode keeps Unicode site names readable', () => {
  const { files } = buildBatchExport({
    groups: [
      { site: '例子.com', cookies: [cookie('.例子.com', 'a')] },
      { site: '测试.com', cookies: [cookie('.测试.com', 'b')] },
    ],
    formatKey: 'netscape',
    mode: 'separate',
    date: DATE,
  });

  assert.deepEqual(
    files.map((file) => file.name),
    ['例子.com_cookies_20261117.txt', '测试.com_cookies_20261117.txt'],
  );
});

test('empty selection is rejected', () => {
  assert.throws(
    () => buildBatchExport({ groups: [], formatKey: 'netscape', mode: 'zip' }),
    /No sites selected/,
  );
});

test('unknown format is rejected', () => {
  assert.throws(
    () => buildBatchExport({ groups, formatKey: 'yaml', mode: 'zip' }),
    /Invalid format/,
  );
});

test('buildBatchExportFromCookies selects only requested sites', () => {
  const { files, totalCookies } = buildBatchExportFromCookies(
    [cookie('.example.com', 'sid'), cookie('.other.org', 'token')],
    ['other.org'],
    'netscape',
    'combined',
    DATE,
  );
  assert.equal(files[0].name, 'cookies_all_1sites_20261117.txt');
  assert.equal(totalCookies, 1);
  assert.doesNotMatch(files[0].data, /\.example\.com\t/);
});

test('text formats collapse partition variants and keep HttpOnly markers', () => {
  const plain = cookie('.example.com', 'sid', { httpOnly: true });
  const partitioned = cookie('.example.com', 'sid', {
    value: 'partitioned-sid',
    httpOnly: true,
    partitionKey: { topLevelSite: 'https://example.com' },
  });
  const text = serializeCombined(
    [{ site: 'example.com', cookies: [partitioned, plain] }],
    'netscape',
  );

  assert.match(text, /#HttpOnly_\.example\.com\tTRUE/);
  assert.match(text, /value-sid/);
  assert.doesNotMatch(text, /partitioned-sid/);
  assert.equal(
    text.split('\n').filter((line) => line.includes('\t')).length,
    1,
  );
});

test('JSON keeps both partition variants', () => {
  const plain = cookie('.example.com', 'sid');
  const partitioned = cookie('.example.com', 'sid', {
    value: 'partitioned-sid',
    partitionKey: { topLevelSite: 'https://example.com' },
  });
  const parsed = JSON.parse(
    serializeCombined(
      [{ site: 'example.com', cookies: [plain, partitioned] }],
      'json',
    ),
  );

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].partitionKey, undefined);
  assert.deepEqual(parsed[1].partitionKey, {
    topLevelSite: 'https://example.com',
  });
});
