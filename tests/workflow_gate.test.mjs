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

test('Chrome E2E installs a pinned Chrome for Testing build', () => {
  const testWorkflow = read('../.github/workflows/test.yml');
  assert.match(testWorkflow, /CHROME_VERSION: "158\.0\.8127\.36"/);
  assert.match(
    testWorkflow,
    /browsers install "chrome@\$\{CHROME_VERSION\}"[\s\S]*?--format "\{\{path\}\}"/,
  );
  assert.match(
    testWorkflow,
    /echo "CHROME_BIN=\$CHROME_BIN" >> "\$GITHUB_ENV"/,
  );
  assert.match(testWorkflow, /"\$CHROME_BIN" --version/);
  assert.match(testWorkflow, /xvfb-run -a npm run test:chrome/);
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

test('AMO publish is manual-only and requires matching version confirmation', () => {
  const amoWorkflow = read('../.github/workflows/publish-amo.yml');
  assert.doesNotMatch(amoWorkflow, /tags:\s*\n\s+- "v\*\.\*\.\*"/);
  assert.match(amoWorkflow, /on:\n\s+workflow_dispatch:/);
  assert.match(amoWorkflow, /inputs:\n\s+version:/);
  assert.match(amoWorkflow, /EXPECTED_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(
    amoWorkflow,
    /if \[ "\$EXPECTED_VERSION" != "\$VERSION" \]; then/,
  );
});

test('AMO publish requires a release tag at HEAD and a protected environment', () => {
  const amoWorkflow = read('../.github/workflows/publish-amo.yml');
  assert.match(amoWorkflow, /environment: amo/);
  assert.match(amoWorkflow, /fetch-depth: 0/);
  assert.match(amoWorkflow, /git fetch --tags --force/);
  assert.match(amoWorkflow, /refs\/tags\/\$\{TAG\}\^\{commit\}/);
  assert.match(amoWorkflow, /HEAD_SHA=\$\(git rev-parse HEAD\)/);
  assert.match(
    amoWorkflow,
    /TAG_SHA=\$\(git rev-parse "\$\{TAG\}\^\{commit\}"\)/,
  );
  assert.match(
    amoWorkflow,
    /if \[ "\$HEAD_SHA" != "\$TAG_SHA" \]; then[\s\S]*?exit 1/,
  );
});
