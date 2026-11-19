import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createZip } from '../src/modules/zip_writer.mjs';

test('createZip writes an archive that unzip can verify and read', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zip-writer-'));
  const archivePath = path.join(dir, 'cookies.zip');

  const zip = createZip([
    {
      name: 'example.com_cookies.txt',
      data: '# Netscape HTTP Cookie File\n.example.com\ttrue\t/\tTRUE\t0\tsid\tabc\n',
    },
    { name: '中文站点_cookies.txt', data: 'hello\n' },
  ]);
  writeFileSync(archivePath, zip);

  const listing = execFileSync('unzip', ['-l', archivePath], {
    encoding: 'utf8',
  });
  assert.match(listing, /example\.com_cookies\.txt/);
  assert.match(listing, /中文站点_cookies\.txt/);

  const content = execFileSync(
    'unzip',
    ['-p', archivePath, 'example.com_cookies.txt'],
    { encoding: 'utf8' },
  );
  assert.equal(
    content,
    '# Netscape HTTP Cookie File\n.example.com\ttrue\t/\tTRUE\t0\tsid\tabc\n',
  );

  const extracted = path.join(dir, 'extracted');
  mkdirSync(extracted);
  execFileSync('unzip', ['-q', archivePath, '-d', extracted]);
  const mode = statSync(path.join(extracted, 'example.com_cookies.txt')).mode;
  assert.equal(mode & 0o777, 0o644);

  execFileSync('unzip', ['-t', archivePath]);
  rmSync(dir, { recursive: true, force: true });
});

test('createZip handles an empty file list', () => {
  const zip = createZip([]);
  assert.ok(zip.length > 0);
  // End of central directory signature must be present.
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
});
