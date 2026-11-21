import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Test workflow can be reused and still runs on branch pushes', () => {
  const testWorkflow = read('../.github/workflows/test.yml');
  assert.match(testWorkflow, /workflow_call:/);
  assert.match(testWorkflow, /branches: \["\*\*"\]/);
});

test('Firefox E2E installs a pinned browser instead of using the runner image', () => {
  const testWorkflow = read('../.github/workflows/test.yml');
  assert.match(testWorkflow, /FIREFOX_VERSION: "160\.0"/);
  assert.match(
    testWorkflow,
    /browsers install "firefox@stable_\$\{FIREFOX_VERSION\}"[\s\S]*?--format "\{\{path\}\}"/,
  );
  assert.match(
    testWorkflow,
    /echo "FIREFOX_BIN=\$FIREFOX_BIN" >> "\$GITHUB_ENV"/,
  );
  assert.match(testWorkflow, /"\$FIREFOX_BIN" --version/);
  assert.match(testWorkflow, /xvfb-run -a npm run test:firefox/);
});

test('Release waits for the full test suite before building', () => {
  const releaseWorkflow = read('../.github/workflows/release.yml');
  assert.match(
    releaseWorkflow,
    /test:\n\s+name: Full test suite\n\s+uses: \.\/\.github\/workflows\/test\.yml/,
  );
  assert.match(
    releaseWorkflow,
    /build:\n\s+name: Build bundles\n\s+needs: test/,
  );
});

test('AMO publish waits for the full test suite and uses the locked web-ext', () => {
  const amoWorkflow = read('../.github/workflows/publish-amo.yml');
  assert.match(
    amoWorkflow,
    /test:\n\s+name: Full test suite\n\s+uses: \.\/\.github\/workflows\/test\.yml/,
  );
  assert.match(
    amoWorkflow,
    /publish:\n\s+name: Submit listed version to AMO\n\s+needs: test/,
  );
  assert.match(amoWorkflow, /\.\/node_modules\/\.bin\/web-ext sign/);
  assert.doesNotMatch(amoWorkflow, /npx --yes web-ext/);
});
