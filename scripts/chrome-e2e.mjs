/**
 * Chrome/Chromium end-to-end test for the download path:
 * popup -> chrome.cookies -> chrome.downloads -> local file.
 *
 * It loads the built Chrome bundle, visits two loopback origins, exports both
 * sites as one merged Netscape file, then exports the same selection as a ZIP.
 *
 * Requirements:
 *   - Chrome or Chromium (set CHROME_BIN if it is not on PATH)
 *   - A display; CI wraps this with `xvfb-run`
 *   - unzip for inspecting the ZIP and extracting the browser bundle
 *
 * Run with: npm run test:chrome
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const distDir = path.join(repoRoot, 'dist');

const resolveChromeBinary = () => {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    try {
      return execFileSync('which', [name], { encoding: 'utf8' }).trim();
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('Chrome/Chromium not found; set CHROME_BIN.');
};

const findChromeBundle = () => {
  const bundles = readdirSync(distDir)
    .filter((name) => /_chrome\.zip$/.test(name))
    .map((name) => path.join(distDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!bundles.length) {
    throw new Error(
      'No Chrome bundle found; run `npm run build:chrome` first.',
    );
  }
  return bundles[0];
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dateStamp = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const waitForDownload = async (downloadDir, matcher, timeoutMs = 20000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const names = readdirSync(downloadDir).filter(
      (name) => !name.endsWith('.crdownload') && matcher.test(name),
    );
    if (names.length) {
      const file = path.join(downloadDir, names.sort().at(-1));
      if (statSync(file).size > 0) return file;
    }
    await sleep(200);
  }
  throw new Error(
    `Download did not appear: ${matcher}; files: ${readdirSync(
      downloadDir,
    ).join(', ')}`,
  );
};

const startServer = async () => {
  const server = http.createServer((req, res) => {
    const host = req.headers.host?.split(':')[0] ?? 'unknown';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Set-Cookie',
      `sid=${encodeURIComponent(host)}; Path=/; SameSite=Lax; HttpOnly`,
    );
    res.end(`<!doctype html><title>${host}</title><p>${host}</p>`);
  });
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const { port } = server.address();
  return { server, port };
};

const extractBundle = (zipPath) => {
  const extensionDir = mkdtempSync(path.join(os.tmpdir(), 'cookies-chrome-'));
  execFileSync('unzip', ['-q', zipPath, '-d', extensionDir]);
  if (!existsSync(path.join(extensionDir, 'LICENSE'))) {
    throw new Error('Built bundle does not contain LICENSE.');
  }
  return extensionDir;
};

const main = async () => {
  const serverInfo = await startServer();
  const extensionDir = extractBundle(findChromeBundle());
  const downloadDir = mkdtempSync(path.join(os.tmpdir(), 'cookies-download-'));
  let browser;

  try {
    browser = await puppeteer.launch({
      executablePath: resolveChromeBinary(),
      headless: false,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
      ],
    });

    // Opening chrome://extensions starts the unpacked MV3 service worker, so
    // the extension id can be read from its target URL.
    const extensionsPage = await browser.newPage();
    await extensionsPage.goto('chrome://extensions', {
      waitUntil: 'domcontentloaded',
    });
    const workerTarget = await (async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const target = browser
          .targets()
          .find(
            (candidate) =>
              candidate.type() === 'service_worker' &&
              candidate.url().startsWith('chrome-extension://'),
          );
        if (target) return target;
        await sleep(150);
      }
      throw new Error('Extension service worker did not start.');
    })();
    const extensionId = new URL(workerTarget.url()).host;
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;

    const session = await browser.target().createCDPSession();
    await session.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
      eventsEnabled: true,
    });

    const sitePage = await browser.newPage();
    await sitePage.goto(`http://127.0.0.1:${serverInfo.port}/`);
    await sitePage.goto(`http://127.0.0.2:${serverInfo.port}/`);
    await sitePage.goto(`http://127.0.0.1:${serverInfo.port}/`);
    await sitePage.bringToFront();

    const popup = await browser.newPage();
    await popup.goto(popupUrl);
    await sitePage.bringToFront();
    // In headless Chrome the extension page can remain the active tab even
    // after bringToFront. Activate the site tab through the tabs API so the
    // popup observes the same active-tab state a real toolbar popup would.
    await popup.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const siteTab = tabs.find((tab) =>
        tab.url?.startsWith('http://127.0.0.1'),
      );
      if (!siteTab) throw new Error('Could not find the test site tab');
      await chrome.tabs.update(siteTab.id, { active: true });
    });

    try {
      await popup.waitForFunction(
        () =>
          document.querySelectorAll('.site-item').length >= 2 &&
          !document.querySelector('#export').disabled &&
          !document.querySelector('#exportAll').disabled,
        { timeout: 15000, polling: 100 },
      );
    } catch (error) {
      console.error(
        'Popup state before failure:',
        await popup.evaluate(() => ({
          siteItems: document.querySelectorAll('.site-item').length,
          batchStatus: document.querySelector('#batchStatus')?.textContent,
          singleStatus: document.querySelector('#singleStatus')?.textContent,
          exportDisabled: document.querySelector('#export')?.disabled,
          exportAllDisabled: document.querySelector('#exportAll')?.disabled,
        })),
      );
      throw error;
    }

    // Verify the background badge path against a real active tab and cookie
    // store, rather than only the badge counter unit tests.
    const badgeText = await popup.evaluate(async () => {
      const started = Date.now();
      while (Date.now() - started < 10000) {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.id) return null;
        const text = await chrome.action.getBadgeText({ tabId: tab.id });
        if (/^\d+$/.test(text) && Number(text) > 0) return text;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return null;
    });
    if (!badgeText) {
      throw new Error('Chrome badge did not reflect the active site cookies.');
    }
    console.log(`Chrome badge OK: ${badgeText}`);

    const partitionCookie = await popup.evaluate(
      async ({ port }) => {
        const cookie = await chrome.cookies.set({
          url: `https://127.0.0.2:${port}/`,
          name: 'chip',
          value: 'partitioned',
          path: '/',
          secure: true,
          partitionKey: { topLevelSite: 'http://127.0.0.1' },
        });
        return cookie
          ? { name: cookie.name, partitionKey: cookie.partitionKey }
          : null;
      },
      { port: serverInfo.port },
    );
    if (!partitionCookie?.partitionKey) {
      throw new Error('Could not create a partitioned test cookie.');
    }

    await sitePage.bringToFront();
    const batchCookies = await popup.evaluate(async () => {
      const { getAllCookiesForBatch } = await import(
        './modules/get_all_cookies.mjs'
      );
      return getAllCookiesForBatch();
    });
    const chip = batchCookies.find((cookie) => cookie.name === 'chip');
    if (!chip) {
      throw new Error('Batch query did not include the partitioned cookie.');
    }
    console.log(
      `CHIPS partition query OK: ${JSON.stringify(chip.partitionKey)}`,
    );

    await popup.evaluate(() => {
      document.querySelector('#tabMulti').click();
      document.querySelector('#selectAll').click();
      const format = document.querySelector('#batchFormat');
      format.value = 'netscape';
      format.dispatchEvent(new Event('change', { bubbles: true }));
      const mode = document.querySelector('#batchMode');
      mode.value = 'combined';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sitePage.bringToFront();
    await popup.evaluate(() => document.querySelector('#batchExport').click());
    const stamp = dateStamp();
    const mergedName = `cookies_all_2sites_${stamp}.txt`;
    const merged = await waitForDownload(
      downloadDir,
      new RegExp(`^${escapeRegex(mergedName)}$`),
    );
    if (path.basename(merged) !== mergedName) {
      throw new Error(`Unexpected merged download name: ${merged}`);
    }
    const text = readFileSync(merged, 'utf8');
    if (!/sid\t127\.0\.0\.1/.test(text) || !/sid\t127\.0\.0\.2/.test(text)) {
      throw new Error('Merged export does not contain both site cookies.');
    }
    if (!text.includes('#HttpOnly_')) {
      throw new Error('Netscape export lost the HttpOnly marker.');
    }
    console.log(`Chrome merged export OK: ${path.basename(merged)}`);

    await popup.evaluate(() => {
      const mode = document.querySelector('#batchMode');
      mode.value = 'zip';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sitePage.bringToFront();
    await popup.evaluate(() => document.querySelector('#batchExport').click());
    const zipName = `cookies_2sites_${stamp}.zip`;
    const zipFile = await waitForDownload(
      downloadDir,
      new RegExp(`^${escapeRegex(zipName)}$`),
    );
    if (path.basename(zipFile) !== zipName) {
      throw new Error(`Unexpected ZIP download name: ${zipFile}`);
    }
    const listing = execFileSync('unzip', ['-l', zipFile], {
      encoding: 'utf8',
    });
    if (!listing.includes('_sites.txt') || !/cookies_/.test(listing)) {
      throw new Error('ZIP export is missing expected entries.');
    }
    console.log(`Chrome ZIP export OK: ${path.basename(zipFile)}`);

    // Single-site Export uses the active tab and the sanitized hostname base.
    await sitePage.bringToFront();
    await popup.evaluate(() => document.querySelector('#tabSingle').click());
    await popup.evaluate(() => document.querySelector('#export').click());
    const singleName = '127.0.0.1_cookies.txt';
    const single = await waitForDownload(
      downloadDir,
      new RegExp(`^${escapeRegex(singleName)}$`),
    );
    const singleText = readFileSync(single, 'utf8');
    if (!/sid\t127\.0\.0\.1/.test(singleText)) {
      throw new Error(
        'Single-site Export does not contain the active site cookie.',
      );
    }
    console.log(`Chrome single-site Export OK: ${path.basename(single)}`);

    // Export As uses the downloads API with saveAs=true. Stub only the
    // downloader so the browser-level popup path can be checked without a
    // native save dialog blocking the test.
    const exportAsProbe = await popup.evaluate(async () => {
      const originalDownload = chrome.downloads.download;
      const calls = [];
      chrome.downloads.download = async (details) => {
        calls.push(details);
        return 4242;
      };
      try {
        document.querySelector('#exportAs').click();
        const started = Date.now();
        while (Date.now() - started < 3000) {
          if (
            document
              .querySelector('#singleStatus')
              .textContent.includes('Started export for')
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return {
          calls,
          status: document.querySelector('#singleStatus').textContent,
          busy: document.querySelector('#export').disabled,
        };
      } finally {
        chrome.downloads.download = originalDownload;
      }
    });
    if (
      exportAsProbe.calls.length !== 1 ||
      exportAsProbe.calls[0].saveAs !== true
    ) {
      throw new Error(
        `Export As did not request saveAs=true: ${JSON.stringify(exportAsProbe)}`,
      );
    }
    console.log('Chrome Export As saveAs path OK');
    await popup.waitForFunction(
      () => !document.querySelector('#export').disabled,
      { timeout: 3000, polling: 50 },
    );

    // A second Export As while one is still pending must be rejected by the
    // shared action guard. The downloader is held for 300 ms so the second
    // click arrives while the first handler is still inside the guard.
    const doubleGuard = await popup.evaluate(async () => {
      const originalDownload = chrome.downloads.download;
      const calls = [];
      chrome.downloads.download = (details) =>
        new Promise((resolve) => {
          calls.push(details);
          setTimeout(() => resolve(5151), 300);
        });
      try {
        const button = document.querySelector('#exportAs');
        button.click();
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 400));
        return {
          calls,
          status: document.querySelector('#singleStatus').textContent,
          disabled: button.disabled,
        };
      } finally {
        chrome.downloads.download = originalDownload;
      }
    });
    if (doubleGuard.calls.length !== 1) {
      throw new Error(
        `Rapid double-click reached the downloader ${doubleGuard.calls.length} times: ${JSON.stringify(doubleGuard)}`,
      );
    }
    console.log('Chrome single-site re-entrancy OK');
    await popup.waitForFunction(
      () => !document.querySelector('#export').disabled,
      { timeout: 3000, polling: 50 },
    );

    // Export All Cookies has a fixed base name and includes every site.
    await popup.evaluate(() => document.querySelector('#exportAll').click());
    const allName = 'cookies.txt';
    const all = await waitForDownload(
      downloadDir,
      new RegExp(`^${escapeRegex(allName)}$`),
    );
    const allText = readFileSync(all, 'utf8');
    if (
      !/sid\t127\.0\.0\.1/.test(allText) ||
      !/sid\t127\.0\.0\.2/.test(allText)
    ) {
      throw new Error('Export All Cookies did not include both sites.');
    }
    console.log(`Chrome Export All Cookies OK: ${path.basename(all)}`);

    // Separate downloads exercise the per-site filenames and the delay loop.
    await sitePage.bringToFront();
    await popup.evaluate(() => {
      document.querySelector('#tabMulti').click();
      document.querySelector('#selectAll').click();
      const mode = document.querySelector('#batchMode');
      mode.value = 'separate';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#batchExport').click();
    });
    const separateNames = [
      `127.0.0.1_cookies_${stamp}.txt`,
      `127.0.0.2_cookies_${stamp}.txt`,
    ];
    for (const name of separateNames) {
      await waitForDownload(downloadDir, new RegExp(`^${escapeRegex(name)}$`));
    }
    console.log(`Chrome separate downloads OK: ${separateNames.join(', ')}`);

    const sticky = await popup.evaluate(async () => {
      document.querySelector('#tabSingle').click();
      const table = document.querySelector('#netscapeTable');
      const body = table.querySelector('tbody');
      const template = body.querySelector('tr');
      if (template) {
        for (let index = 0; index < 80; index += 1) {
          body.append(template.cloneNode(true));
        }
      }
      const container = table.closest('.table-container');
      const header = table.querySelector('thead');
      container.scrollTop = 0;
      const before = header.getBoundingClientRect().top;
      container.scrollTop = 180;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const after = header.getBoundingClientRect().top;
      return {
        position: getComputedStyle(header).position,
        delta: Math.abs(after - before),
        scrollTop: container.scrollTop,
      };
    });
    if (
      sticky.position !== 'sticky' ||
      sticky.scrollTop === 0 ||
      sticky.delta > 2
    ) {
      throw new Error(
        `Sticky table header check failed: ${JSON.stringify(sticky)}`,
      );
    }
    console.log('Chrome sticky table header OK');
  } finally {
    if (browser) await browser.close();
    serverInfo.server.close();
    rmSync(extensionDir, { recursive: true, force: true });
    rmSync(downloadDir, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
