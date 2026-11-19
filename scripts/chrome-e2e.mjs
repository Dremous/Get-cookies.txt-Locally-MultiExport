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
  throw new Error(`Download did not appear: ${matcher}`);
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
    const workerTarget = await browser.waitForTarget(
      (target) =>
        target.type() === 'service_worker' &&
        target.url().startsWith('chrome-extension://'),
      { timeout: 15000 },
    );
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

    const popup = await browser.newPage();
    await popup.goto(popupUrl);
    await popup.waitForFunction(
      () => document.querySelectorAll('.site-item').length >= 2,
      { timeout: 15000 },
    );
    await popup.click('#tabMulti');
    await popup.click('#selectAll');
    await popup.select('#batchFormat', 'netscape');
    await popup.select('#batchMode', 'combined');

    await popup.click('#batchExport');
    const merged = await waitForDownload(downloadDir, /\.txt$/);
    const text = readFileSync(merged, 'utf8');
    if (!/sid\t127\.0\.0\.1/.test(text) || !/sid\t127\.0\.0\.2/.test(text)) {
      throw new Error('Merged export does not contain both site cookies.');
    }
    if (!text.includes('#HttpOnly_')) {
      throw new Error('Netscape export lost the HttpOnly marker.');
    }
    console.log(`Chrome merged export OK: ${path.basename(merged)}`);

    await popup.select('#batchMode', 'zip');
    await popup.click('#batchExport');
    const zipFile = await waitForDownload(downloadDir, /\.zip$/);
    const listing = execFileSync('unzip', ['-l', zipFile], {
      encoding: 'utf8',
    });
    if (!listing.includes('_sites.txt') || !/cookies_/.test(listing)) {
      throw new Error('ZIP export is missing expected entries.');
    }
    console.log(`Chrome ZIP export OK: ${path.basename(zipFile)}`);
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
