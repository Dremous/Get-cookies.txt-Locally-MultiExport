import assert from 'node:assert/strict';
import test from 'node:test';
import { base64ToBytes, bytesToBase64 } from '../src/modules/base64.mjs';
import { createZip } from '../src/modules/zip_writer.mjs';

test('base64 helpers round-trip UTF-8 bytes', () => {
  const bytes = new TextEncoder().encode('中文 cookie\nvalue');
  const encoded = bytesToBase64(bytes);

  assert.equal(encoded, Buffer.from(bytes).toString('base64'));
  assert.deepEqual(base64ToBytes(encoded), bytes);
});

test('base64 helpers handle empty data', () => {
  assert.equal(bytesToBase64(new Uint8Array()), '');
  assert.deepEqual(base64ToBytes(''), new Uint8Array());
});

test('ZIP bytes survive the base64 transport used for Firefox', () => {
  const zip = createZip([{ name: '中文站点_cookies.txt', data: 'hello\n' }]);
  const transported = base64ToBytes(bytesToBase64(zip));

  assert.deepEqual(transported, zip);
});
