/**
 * Firefox end-to-end test for the save pipeline:
 * popup -> chrome.runtime.sendMessage -> background -> chrome.downloads.
 *
 * It installs the built Firefox bundle as a temporary add-on, grants the
 * host permission through Firefox’s internal permission store (MV3 host
 * access is opt-in, and about: pages are not navigable from WebDriver),
 * exports two sites as one merged file and as a ZIP, and checks the actual
 * files written by the background page.
 *
 * Requirements:
 *   - Firefox 115+ on PATH (or set FIREFOX_BIN)
 *   - geckodriver from the npm `geckodriver` package (installed with devDependencies)
 *
 * Run with: npm run test:firefox
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Builder } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const command = require('selenium-webdriver/lib/command');
const geckodriver = require('geckodriver');

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const distDir = path.join(repoRoot, 'dist');
const resolveFirefoxBinary = () => {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  try {
    return execFileSync('which', ['firefox'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

// Firefox 160 denies the Marionette chrome context unless system access is
// enabled. The chrome context is used only to resolve the temporary add-on
// UUID and grant its host permission, avoiding restricted about: pages.
process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = '1';

const firefoxBinary = resolveFirefoxBinary();

const resolveGeckodriver = async () => {
  try {
    return await geckodriver.download(
      process.env.GECKODRIVER_VERSION || '0.37.1',
    );
  } catch {
    try {
      return execFileSync('which', ['geckodriver'], {
        encoding: 'utf8',
      }).trim();
    } catch {
      return '';
    }
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const findFirefoxBundle = () => {
  const bundles = readdirSync(distDir)
    .filter((name) => /_firefox\.zip$/.test(name))
    .map((name) => path.join(distDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!bundles.length) {
    throw new Error(
      'No Firefox bundle found; run `npm run build:firefox` first.',
    );
  }
  return bundles[0];
};

const readCookies = (driver) =>
  driver.executeAsyncScript((done) => {
    chrome.cookies.getAll({}, (cookies) => done(cookies));
  });

const prepareAddon = async (driver, addonId) => {
  await driver.setContext('chrome');
  try {
    const host = await driver.executeScript(
      'return WebExtensionPolicy.getByID(arguments[0])?.mozExtensionHostname;',
      addonId,
    );
    if (!host) throw new Error('Could not resolve the add-on UUID.');

    // Firefox MV3 host access is opt-in. about:addons is not navigable from
    // WebDriver in current Firefox versions, so grant the manifest host
    // permission through the same internal permission store the UI uses.
    const granted = await driver.executeScript(
      `
      const id = arguments[0];
      return (async () => {
        const { ExtensionPermissions } = ChromeUtils.importESModule(
          'resource://gre/modules/ExtensionPermissions.sys.mjs',
        );
        const policy = WebExtensionPolicy.getByID(id);
        await ExtensionPermissions.add(
          id,
          { permissions: [], origins: ['<all_urls>'] },
          policy.extension,
        );
        return 'ok';
      })();
    `,
      addonId,
    );
    if (granted !== 'ok')
      throw new Error('Could not grant the host permission.');
    return `moz-extension://${host}`;
  } finally {
    await driver.setContext('content');
  }
};

const waitForDownload = async (downloadDir, matcher, timeoutMs = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const names = readdirSync(downloadDir).filter(
      (name) => !name.endsWith('.part') && matcher.test(name),
    );
    if (names.length) {
      const file = path.join(downloadDir, names.sort().at(-1));
      if (statSync(file).size > 0) return file;
    }
    await sleep(200);
  }
  throw new Error(`Download did not appear in ${downloadDir}`);
};

const run = async () => {
  if (!firefoxBinary || !existsSync(firefoxBinary)) {
    throw new Error(
      'Firefox binary not found. Install Firefox or set FIREFOX_BIN.',
    );
  }

  const bundle = findFirefoxBundle();
  const tmpDir = mkdtempSync(
    path.join(os.tmpdir(), 'get-cookies-firefox-e2e-'),
  );
  const xpiPath = path.join(tmpDir, 'extension.xpi');
  const downloadDir = path.join(tmpDir, 'downloads');
  mkdirSync(downloadDir, { recursive: true });
  copyFileSync(bundle, xpiPath);

  const server = http.createServer((req, res) => {
    res.setHeader('Set-Cookie', 'sid=abc123; Path=/; SameSite=Lax');
    res.end('ok');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const port = server.address().port;

  const options = new firefox.Options();
  options.setBinary(firefoxBinary);
  options.addArguments('-headless');
  options.setPreference('xpinstall.signatures.required', false);
  options.setPreference('browser.download.folderList', 2);
  options.setPreference('browser.download.dir', downloadDir);
  options.setPreference('browser.download.useDownloadDir', true);
  options.setPreference('browser.download.manager.showWhenStarting', false);
  options.setPreference('browser.download.alwaysOpenPanel', false);
  options.setPreference('browser.download.start_downloads_in_tmp_dir', false);
  options.setPreference(
    'browser.helperApps.neverAsk.saveToDisk',
    'text/plain,application/octet-stream,application/zip',
  );

  const geckodriverPath = await resolveGeckodriver();
  if (!geckodriverPath) {
    throw new Error(
      'geckodriver not found. Install it or set GECKODRIVER_VERSION.',
    );
  }
  const service = new firefox.ServiceBuilder(geckodriverPath);
  const driver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .setFirefoxService(service)
    .build();

  try {
    // Install as temporary add-on. Selenium's installAddon helper sends the
    // binary instead of a path, which geckodriver 0.37 rejects; send `path`.
    const addonId = await driver.execute(
      new command.Command('install addon')
        .setParameter('path', xpiPath)
        .setParameter('temporary', true),
    );
    console.log(`Installed Firefox add-on: ${addonId}`);

    // Two loopback hosts give us two independent cookie sites.
    await driver.get(`http://127.0.0.1:${port}/`);
    await driver.get(`http://127.0.0.2:${port}/`);
    await sleep(200);

    const baseUrl = await prepareAddon(driver, addonId);
    await driver.get(`${baseUrl}/popup.html`);
    const after = await readCookies(driver);
    console.log(`Cookies after host permission: ${after.length}`);
    if (after.length < 2) {
      throw new Error(
        'Host permission was not granted; Firefox returned fewer than 2 cookies.',
      );
    }

    await driver.findElement({ id: 'tabMulti' }).click();
    await driver.wait(async () => {
      const items = await driver.findElements({ css: '.site-item' });
      return items.length >= 2;
    }, 10000);
    const sites = await driver.findElements({ css: '.site-name' });
    const siteNames = [];
    for (const site of sites) siteNames.push(await site.getText());
    console.log(`Sites in popup: ${siteNames.join(', ')}`);

    await driver.executeScript(() => {
      const format = document.querySelector('#batchFormat');
      format.value = 'netscape';
      format.dispatchEvent(new Event('change', { bubbles: true }));
      const mode = document.querySelector('#batchMode');
      mode.value = 'combined';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#selectAll').click();
    });
    await driver.wait(async () => {
      const summary = await driver
        .findElement({ id: 'selectionText' })
        .getText();
      return summary.includes('2 of 2 sites selected');
    }, 5000);
    await driver.findElement({ id: 'batchExport' }).click();
    await driver.wait(async () => {
      const status = await driver.findElement({ id: 'batchStatus' }).getText();
      return status.includes('Started');
    }, 15000);
    const combinedPath = await waitForDownload(
      downloadDir,
      /^cookies_all_.*\.txt$/,
    );
    const combined = readFileSync(combinedPath, 'utf8');
    if (
      !combined.includes('# --- 127.0.0.1') ||
      !combined.includes('# --- 127.0.0.2')
    ) {
      throw new Error('Merged export does not contain both sites.');
    }
    if (!combined.includes('sid\tabc123')) {
      throw new Error('Merged export does not contain the test cookie.');
    }
    console.log(
      `Merged export OK: ${path.basename(combinedPath)} (${combined.length} bytes)`,
    );

    // ZIP goes through the binary/base64 path in the Firefox background page.
    await driver.executeScript(() => {
      const mode = document.querySelector('#batchMode');
      mode.value = 'zip';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await driver.findElement({ id: 'batchExport' }).click();
    await driver.wait(async () => {
      const status = await driver.findElement({ id: 'batchStatus' }).getText();
      return status.includes('Started');
    }, 15000);
    const zipPath = await waitForDownload(downloadDir, /^cookies_.*\.zip$/);
    const zip = readFileSync(zipPath);
    if (zip.subarray(0, 4).toString('binary') !== 'PK\u0003\u0004') {
      throw new Error('ZIP export is not a valid ZIP file.');
    }
    let entries = '';
    try {
      entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
    } catch {
      // `unzip` is optional; the ZIP signature above is enough on minimal images.
    }
    if (
      entries &&
      (!entries.includes('_sites.txt') || !entries.includes('_cookies_'))
    ) {
      throw new Error('ZIP export does not contain the expected entries.');
    }
    console.log(
      `ZIP export OK: ${path.basename(zipPath)} (${zip.length} bytes)`,
    );

    console.log('Firefox save pipeline E2E passed.');
  } finally {
    await driver.quit().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    rmSync(tmpDir, { recursive: true, force: true });
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
