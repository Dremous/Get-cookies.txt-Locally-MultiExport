/**
 * Firefox end-to-end test for the save pipeline:
 * popup -> chrome.runtime.sendMessage -> background -> chrome.downloads.
 *
 * It installs the built Firefox bundle as a temporary add-on, grants the
 * host permission through Firefox’s internal permission store (MV3 host
 * access is opt-in, and about: pages are not navigable from WebDriver), and
 * exercises single-site Export/Copy/Export All plus merged, ZIP and separate
 * batch exports, first-party isolation JSON export, host-permission loss and
 * restoration, and a container-store export. It checks the actual files
 * written by the background page.
 *
 * Requirements:
 *   - Firefox 140+ on PATH (or set FIREFOX_BIN); older binaries are rejected
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
const MIN_FIREFOX_VERSION = 140;
const SITE_COOKIE_VALUES = {
  '127.0.0.1': 'abc123',
  '127.0.0.2': 'def456',
};
const resolveFirefoxBinary = () => {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  try {
    return execFileSync('which', ['firefox'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

/**
 * Parse `firefox --version` and enforce the manifest's desktop minimum.
 * @param {string} binary
 */
const readFirefoxVersion = (binary) => {
  const output = execFileSync(binary, ['--version'], {
    encoding: 'utf8',
  }).trim();
  const match = output.match(/(?:Mozilla\s+)?Firefox\s+(\d+(?:\.\d+)*)/i);
  if (!match) {
    throw new Error(`Could not parse Firefox version from: ${output}`);
  }
  return {
    output,
    major: Number.parseInt(match[1].split('.')[0], 10),
  };
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
    chrome.cookies.getAll({ firstPartyDomain: null }, (cookies) =>
      done(cookies),
    );
  });

const waitForStatus = async (driver, id, needle, timeout = 15000) => {
  try {
    await driver.wait(async () => {
      const status = await driver.findElement({ id }).getText();
      return status.includes(needle);
    }, timeout);
  } catch (error) {
    console.error(
      `Status #${id} did not contain ${needle}:`,
      await driver.findElement({ id }).getText(),
    );
    throw error;
  }
};

const activateSiteTab = (driver, origin) =>
  driver
    .executeAsyncScript((prefix, done) => {
      chrome.tabs.query({}, (tabs) => {
        // Firefox exposes tab.url once the host permission is granted. Fail
        // instead of falling back to tab index 0: a silent fallback can
        // activate the wrong site and make the isolation assertions pass for
        // the wrong reason.
        const siteTab = tabs.find((tab) => tab.url?.startsWith(prefix));
        const tabInfo = tabs.map((tab) => ({
          id: tab.id,
          index: tab.index,
          windowId: tab.windowId,
          url: tab.url,
          active: tab.active,
        }));
        if (!siteTab) {
          done({
            error: `No site tab URL matching ${prefix}`,
            tabs: tabInfo,
          });
          return;
        }
        const activate = () => {
          chrome.tabs.update(siteTab.id, { active: true }, () => {
            chrome.tabs.query(
              { active: true, windowId: siteTab.windowId },
              ([activeTab]) => {
                if (!activeTab?.url?.startsWith(prefix)) {
                  done({
                    error: `Activated tab does not match ${prefix}`,
                    selected: siteTab.id,
                    active: activeTab?.url,
                    tabs: tabInfo,
                  });
                  return;
                }
                done({ ok: true, selected: siteTab.id, tabs: tabInfo });
              },
            );
          });
        };
        chrome.windows.update(siteTab.windowId, { focused: true }, activate);
      });
    }, origin)
    .then((result) => {
      if (!result?.ok)
        throw new Error(result?.error || 'Tab activation failed');
      return result;
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

const setAddonHostPermission = async (driver, addonId, grant) => {
  await driver.setContext('chrome');
  try {
    const result = await driver.executeScript(
      `
      const id = arguments[0];
      const grant = arguments[1];
      return (async () => {
        const { ExtensionPermissions } = ChromeUtils.importESModule(
          'resource://gre/modules/ExtensionPermissions.sys.mjs',
        );
        const policy = WebExtensionPolicy.getByID(id);
        await ExtensionPermissions[grant ? 'add' : 'remove'](
          id,
          { permissions: [], origins: ['<all_urls>'] },
          policy.extension,
        );
        return 'ok';
      })();
    `,
      addonId,
      grant,
    );
    if (result !== 'ok') throw new Error('Could not update host permission.');
  } finally {
    await driver.setContext('content');
  }
};

const waitForNewDownloads = async (
  downloadDir,
  before,
  matcher,
  count = 1,
  timeoutMs = 15000,
) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const files = readdirSync(downloadDir)
      .filter(
        (name) =>
          !before.has(name) && !name.endsWith('.part') && matcher.test(name),
      )
      .map((name) => path.join(downloadDir, name))
      .filter((file) => statSync(file).size > 0)
      .sort();
    if (files.length >= count) return files.slice(0, count);
    await sleep(200);
  }
  throw new Error(
    `Download did not appear in ${downloadDir}; found: ${readdirSync(
      downloadDir,
    ).join(', ')}`,
  );
};

const run = async () => {
  if (!firefoxBinary || !existsSync(firefoxBinary)) {
    throw new Error(
      'Firefox binary not found. Install Firefox or set FIREFOX_BIN.',
    );
  }
  const firefoxVersion = readFirefoxVersion(firefoxBinary);
  if (firefoxVersion.major < MIN_FIREFOX_VERSION) {
    throw new Error(
      `Firefox ${MIN_FIREFOX_VERSION}+ is required; found ${firefoxVersion.output}. Set FIREFOX_BIN to a newer binary.`,
    );
  }
  console.log(`Using ${firefoxVersion.output}`);

  const bundle = findFirefoxBundle();
  const tmpDir = mkdtempSync(
    path.join(os.tmpdir(), 'get-cookies-firefox-e2e-'),
  );
  const xpiPath = path.join(tmpDir, 'extension.xpi');
  const downloadDir = path.join(tmpDir, 'downloads');
  mkdirSync(downloadDir, { recursive: true });
  copyFileSync(bundle, xpiPath);

  const server = http.createServer((req, res) => {
    const hostname = req.headers.host?.split(':')[0] ?? '';
    const value = SITE_COOKIE_VALUES[hostname] ?? 'unknown-host';
    res.setHeader('Set-Cookie', `sid=${value}; Path=/; SameSite=Lax`);
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
  options.setPreference('privacy.firstparty.isolate', true);
  options.setPreference('privacy.userContext.enabled', true);
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

    // Two loopback hosts give us two independent cookie sites. Keep them in
    // separate tabs; reusing one tab would close the first site page.
    await driver.get(`http://127.0.0.1:${port}/`);
    await driver.switchTo().newWindow('tab');
    await driver.get(`http://127.0.0.2:${port}/`);
    await sleep(200);

    const baseUrl = await prepareAddon(driver, addonId);
    await driver.switchTo().newWindow('tab');
    await driver.get(`${baseUrl}/popup.html`);
    const after = await readCookies(driver);
    console.log(`Cookies after host permission: ${after.length}`);
    if (after.length < 2) {
      throw new Error(
        'Host permission was not granted; Firefox returned fewer than 2 cookies.',
      );
    }
    const afterValues = new Set(after.map((cookie) => cookie.value));
    for (const value of Object.values(SITE_COOKIE_VALUES)) {
      if (!afterValues.has(value)) {
        throw new Error(
          `Test server cookie ${value} was not stored; got ${[...afterValues].join(', ')}.`,
        );
      }
    }

    // Verify the Firefox background badge against a real site tab. The E2E
    // popup is itself a tab, so activate a site tab first and then restore the
    // popup handle for the UI assertions below.
    const popupHandle = await driver.getWindowHandle();
    const badgeText = await driver.executeAsyncScript((done) => {
      chrome.tabs.query({}, (tabs) => {
        const siteTab = tabs.find((tab) =>
          /^http:\/\/127\.0\.0\.[12]:/.test(tab.url || ''),
        );
        if (!siteTab?.id) {
          done(null);
          return;
        }
        chrome.tabs.update(siteTab.id, { active: true }, () => {
          const started = Date.now();
          const poll = () => {
            chrome.action.getBadgeText({ tabId: siteTab.id }, (text) => {
              if (/^\d+$/.test(text || '') && Number(text) > 0) {
                done(text);
              } else if (Date.now() - started < 10000) {
                setTimeout(poll, 100);
              } else {
                done(null);
              }
            });
          };
          poll();
        });
      });
    });
    await driver.switchTo().window(popupHandle);
    if (!badgeText) {
      throw new Error('Firefox badge did not reflect the site cookies.');
    }
    console.log(`Firefox badge OK: ${badgeText}`);

    await driver.findElement({ id: 'tabMulti' }).click();
    await driver.wait(async () => {
      const items = await driver.findElements({ css: '.site-item' });
      return items.length >= 2;
    }, 10000);
    const sites = await driver.findElements({ css: '.site-name' });
    const siteNames = [];
    for (const site of sites) siteNames.push(await site.getText());
    console.log(`Sites in popup: ${siteNames.join(', ')}`);

    // Single-site export exercises the popup -> background message -> download
    // path and the active-tab refresh triggered by tabs.onActivated.
    await driver.findElement({ id: 'tabSingle' }).click();
    await activateSiteTab(driver, `http://127.0.0.1:${port}`);
    await driver.wait(
      async () =>
        (await driver.findElement({ id: 'location' }).getText()).includes(
          `http://127.0.0.1:${port}`,
        ),
      10000,
    );
    await driver.wait(
      () => driver.findElement({ id: 'export' }).isEnabled(),
      10000,
    );

    // A sticky table header needs border-collapse: separate; collapse makes
    // Firefox paint the header border outside the sticky box while scrolling.
    await driver.wait(
      () =>
        driver.executeScript(() =>
          Boolean(document.querySelector('.netscape-table thead th')),
        ),
      10000,
    );
    const stickyHeader = await driver.executeScript(() => {
      const table = document.querySelector('.netscape-table');
      const header = table?.tHead;
      if (!table || !header) return null;
      const tableStyle = getComputedStyle(table);
      const headerStyle = getComputedStyle(header);
      return {
        collapse: tableStyle.borderCollapse,
        spacing: tableStyle.borderSpacing,
        position: headerStyle.position,
      };
    });
    if (
      !stickyHeader ||
      stickyHeader.collapse !== 'separate' ||
      stickyHeader.position !== 'sticky'
    ) {
      throw new Error(
        `Firefox sticky table header is not separated: ${JSON.stringify(stickyHeader)}`,
      );
    }
    console.log('Firefox sticky table header OK');

    const stickyScroll = await driver.executeScript(() => {
      const table = document.querySelector('.netscape-table');
      const body = table?.tBodies?.[0];
      const template = body?.querySelector('tr');
      if (!table || !body || !template) return null;
      const clones = [];
      for (let index = 0; index < 40; index += 1) {
        const clone = template.cloneNode(true);
        clone.dataset.e2eSticky = 'true';
        body.append(clone);
        clones.push(clone);
      }
      const container = table.closest('.table-container');
      const before = table.tHead.getBoundingClientRect().top;
      container.scrollTop = container.scrollHeight;
      const after = table.tHead.getBoundingClientRect().top;
      const scrollTop = container.scrollTop;
      for (const clone of clones) clone.remove();
      container.scrollTop = 0;
      return { delta: Math.abs(after - before), scrollTop };
    });
    if (
      !stickyScroll ||
      stickyScroll.scrollTop === 0 ||
      stickyScroll.delta > 2
    ) {
      throw new Error(
        `Firefox sticky header moved while scrolling: ${JSON.stringify(stickyScroll)}`,
      );
    }
    console.log('Firefox sticky scroll OK');

    await driver.executeScript(() => {
      const format = document.querySelector('#format');
      format.value = 'netscape';
      format.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const beforeSingle = new Set(readdirSync(downloadDir));
    await driver.findElement({ id: 'export' }).click();
    await waitForStatus(driver, 'singleStatus', 'Started');
    const [singlePath] = await waitForNewDownloads(
      downloadDir,
      beforeSingle,
      /\.txt$/,
    );
    const singleText = readFileSync(singlePath, 'utf8');
    const singleCookie = `sid\t${SITE_COOKIE_VALUES['127.0.0.1']}`;
    const otherCookie = `sid\t${SITE_COOKIE_VALUES['127.0.0.2']}`;
    if (!singleText.includes(singleCookie)) {
      throw new Error(`Single-site export does not contain ${singleCookie}.`);
    }
    if (singleText.includes(otherCookie)) {
      throw new Error(
        `Single-site export leaked the other site cookie ${otherCookie}.`,
      );
    }
    console.log(`Single-site export OK: ${path.basename(singlePath)}`);

    // Firefox Export As crosses the popup -> background message boundary. Stub
    // the message channel so the assertion covers the popup handler payload
    // without opening a native save dialog in headless mode.
    const exportAsProbe = await driver.executeAsyncScript((done) => {
      const originalSendMessage = chrome.runtime.sendMessage;
      const calls = [];
      const finish = (result) => {
        chrome.runtime.sendMessage = originalSendMessage;
        done(result);
      };
      chrome.runtime.sendMessage = (message) => {
        calls.push(message);
        return Promise.resolve({ ok: true });
      };
      try {
        document.querySelector('#exportAs').click();
      } catch (error) {
        finish({ error: String(error) });
        return;
      }
      const started = Date.now();
      const timer = setInterval(() => {
        const status = document.querySelector('#singleStatus').textContent;
        if (status.includes('Started export')) {
          clearInterval(timer);
          finish({ calls, status });
        } else if (Date.now() - started > 5000) {
          clearInterval(timer);
          finish({ calls, status, timeout: true });
        }
      }, 50);
    });
    if (
      exportAsProbe.error ||
      exportAsProbe.calls.length !== 1 ||
      exportAsProbe.calls[0]?.data?.saveAs !== true
    ) {
      throw new Error(
        `Firefox Export As did not use saveAs: ${JSON.stringify(exportAsProbe)}`,
      );
    }
    console.log('Firefox Export As saveAs path OK');
    await driver.wait(
      () => driver.findElement({ id: 'export' }).isEnabled(),
      3000,
    );

    // First-party isolation is enabled for this profile. JSON keeps the
    // Firefox-only firstPartyDomain field that text formats cannot represent.
    await driver.executeScript(() => {
      const format = document.querySelector('#format');
      format.value = 'json';
      format.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const beforeIsolation = new Set(readdirSync(downloadDir));
    await driver.findElement({ id: 'export' }).click();
    await waitForStatus(driver, 'singleStatus', 'Started');
    const [isolationPath] = await waitForNewDownloads(
      downloadDir,
      beforeIsolation,
      /\.json$/,
    );
    const isolationCookies = JSON.parse(readFileSync(isolationPath, 'utf8'));
    const isolationCookie = isolationCookies.find(
      (cookie) => cookie.name === 'sid',
    );
    if (!isolationCookie?.firstPartyDomain) {
      throw new Error('JSON export lost the firstPartyDomain field.');
    }
    if (isolationCookie.value !== SITE_COOKIE_VALUES['127.0.0.1']) {
      throw new Error(
        `JSON single-site export leaked value ${isolationCookie.value}.`,
      );
    }
    console.log(
      `Firefox first-party isolation OK: ${isolationCookie.firstPartyDomain}`,
    );
    await driver.executeScript(() => {
      const format = document.querySelector('#format');
      format.value = 'netscape';
      format.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await driver.findElement({ id: 'copy' }).click();
    await waitForStatus(driver, 'singleStatus', 'Copied', 5000);
    console.log('Single-site copy OK');

    const beforeExportAll = new Set(readdirSync(downloadDir));
    await driver.findElement({ id: 'exportAll' }).click();
    await waitForStatus(driver, 'singleStatus', 'Started');
    const [exportAllPath] = await waitForNewDownloads(
      downloadDir,
      beforeExportAll,
      /\.txt$/,
    );
    const exportAllText = readFileSync(exportAllPath, 'utf8');
    for (const value of Object.values(SITE_COOKIE_VALUES)) {
      if (!exportAllText.includes(`sid\t${value}`)) {
        throw new Error(`Export All does not contain cookie ${value}.`);
      }
    }
    console.log(`Export All OK: ${path.basename(exportAllPath)}`);

    await driver.findElement({ id: 'tabMulti' }).click();
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
    const beforeCombined = new Set(readdirSync(downloadDir));
    await driver.findElement({ id: 'batchExport' }).click();
    await waitForStatus(driver, 'batchStatus', 'Started');
    const [combinedPath] = await waitForNewDownloads(
      downloadDir,
      beforeCombined,
      /\.txt$/,
    );
    const combined = readFileSync(combinedPath, 'utf8');
    if (
      !combined.includes('# --- 127.0.0.1') ||
      !combined.includes('# --- 127.0.0.2')
    ) {
      throw new Error('Merged export does not contain both sites.');
    }
    for (const value of Object.values(SITE_COOKIE_VALUES)) {
      if (!combined.includes(`sid\t${value}`)) {
        throw new Error(`Merged export does not contain cookie ${value}.`);
      }
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
    const beforeZip = new Set(readdirSync(downloadDir));
    await driver.findElement({ id: 'batchExport' }).click();
    await waitForStatus(driver, 'batchStatus', 'Started');
    const [zipPath] = await waitForNewDownloads(
      downloadDir,
      beforeZip,
      /\.zip$/,
    );
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

    await driver.executeScript(() => {
      const mode = document.querySelector('#batchMode');
      mode.value = 'separate';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#selectAll').click();
    });
    const beforeSeparate = new Set(readdirSync(downloadDir));
    await driver.findElement({ id: 'batchExport' }).click();
    await waitForStatus(driver, 'batchStatus', 'Started');
    const [separateOne, separateTwo] = await waitForNewDownloads(
      downloadDir,
      beforeSeparate,
      /\.txt$/,
      2,
    );
    const separateFiles = [separateOne, separateTwo];
    const separateTexts = separateFiles.map((file) =>
      readFileSync(file, 'utf8'),
    );
    for (const value of Object.values(SITE_COOKIE_VALUES)) {
      const matches = separateTexts.filter((text) =>
        text.includes(`sid\t${value}`),
      );
      if (matches.length !== 1) {
        throw new Error(
          `Separate downloads must contain ${value} in exactly one file.`,
        );
      }
    }
    const separateNames = separateFiles.map((file) => path.basename(file));
    for (const host of Object.keys(SITE_COOKIE_VALUES)) {
      if (!separateNames.some((name) => name.startsWith(`${host}_cookies_`))) {
        throw new Error(`Separate downloads lack a file for ${host}.`);
      }
    }
    console.log(
      `Separate downloads OK: ${path.basename(separateOne)}, ${path.basename(separateTwo)}`,
    );

    // Firefox host access is opt-in; losing it must disable exports and
    // restoring it must bring the popup back without a stale cookie table.
    await setAddonHostPermission(driver, addonId, false);
    await driver.get(`${baseUrl}/popup.html`);
    await waitForStatus(
      driver,
      'singleStatus',
      'Firefox host permission is required',
    );
    if (await driver.findElement({ id: 'export' }).isEnabled()) {
      throw new Error(
        'Current-site Export stayed enabled without host permission.',
      );
    }
    const exportAllWithoutPermission = await driver.findElement({
      id: 'exportAll',
    });
    if (
      (await exportAllWithoutPermission.getAttribute('aria-disabled')) !==
      'true'
    ) {
      throw new Error('Export All stayed enabled without host permission.');
    }
    await setAddonHostPermission(driver, addonId, true);
    await driver.get(`${baseUrl}/popup.html`);
    await driver.wait(
      () => driver.findElement({ id: 'export' }).isEnabled(),
      10000,
    );
    await driver.wait(
      async () =>
        (await driver
          .findElement({ id: 'exportAll' })
          .getAttribute('aria-disabled')) === 'false',
      10000,
    );
    console.log('Firefox host permission missing/restore OK');

    // A container tab must drive getCookieStoreId() into its own cookie store.
    const container = await driver.executeAsyncScript((sitePort, done) => {
      chrome.tabs.create(
        {
          url: `http://127.0.0.1:${sitePort}/`,
          cookieStoreId: 'firefox-container-1',
        },
        (tab) => {
          const error = chrome.runtime.lastError;
          if (error || !tab) {
            done({ error: error?.message || 'tabs.create failed' });
            return;
          }
          chrome.windows.update(tab.windowId, { focused: true }, () => {
            chrome.tabs.update(tab.id, { active: true }, () =>
              done({ ok: true }),
            );
          });
        },
      );
    }, port);
    if (!container?.ok) {
      throw new Error(container?.error || 'Could not open a container tab.');
    }
    await sleep(500);
    await driver.wait(
      async () =>
        (await driver.findElement({ id: 'location' }).getText()) ===
        `http://127.0.0.1:${port}/`,
      10000,
    );
    await driver.wait(
      () => driver.findElement({ id: 'export' }).isEnabled(),
      10000,
    );
    const beforeContainer = new Set(readdirSync(downloadDir));
    await driver.findElement({ id: 'export' }).click();
    await waitForStatus(driver, 'singleStatus', 'Started');
    const [containerPath] = await waitForNewDownloads(
      downloadDir,
      beforeContainer,
      /\.txt$/,
    );
    const containerText = readFileSync(containerPath, 'utf8');
    if (!containerText.includes(`sid\t${SITE_COOKIE_VALUES['127.0.0.1']}`)) {
      throw new Error('Container-store export does not contain the cookie.');
    }
    if (containerText.includes(`sid\t${SITE_COOKIE_VALUES['127.0.0.2']}`)) {
      throw new Error('Container-store export leaked the other site cookie.');
    }
    console.log(`Firefox container store OK: ${path.basename(containerPath)}`);

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
