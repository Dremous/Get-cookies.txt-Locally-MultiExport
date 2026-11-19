import assert from 'node:assert/strict';
import test from 'node:test';
import { createExportGuard } from '../src/modules/export_guard.mjs';

test('export guard rejects a second export while one is running', () => {
  const guard = createExportGuard();
  assert.equal(guard.busy, false);
  assert.equal(guard.begin(), true);
  assert.equal(guard.busy, true);
  assert.equal(guard.begin(), false);
  guard.end();
  assert.equal(guard.busy, false);
  assert.equal(guard.begin(), true);
});
