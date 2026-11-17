import { formatMap } from './cookie_format.mjs';
import { groupCookiesBySite, toSiteList } from './site_group.mjs';
import { createZip } from './zip_writer.mjs';

/** Characters that are unsafe in a download file name. */
const UNSAFE_FILENAME_CHARS = /[^a-z0-9._-]+/gi;

/**
 * Make a site key usable as a file name.
 * @param {string} site
 * @returns {string}
 */
export const toSafeFileName = (site) => {
  const safe = site.replace(UNSAFE_FILENAME_CHARS, '_').replace(/^_+|_+$/g, '');
  return safe || 'site';
};

/**
 * Ensure every file name in a batch is unique.
 * @param {string[]} names
 * @returns {string[]}
 */
const dedupeFileNames = (names) => {
  const used = new Map();
  return names.map((name) => {
    const count = (used.get(name) ?? 0) + 1;
    used.set(name, count);
    if (count === 1) return name;
    const dot = name.lastIndexOf('.');
    if (dot === -1) return `${name}_${count}`;
    return `${name.slice(0, dot)}_${count}${name.slice(dot)}`;
  });
};

/**
 * Serialize cookies of several sites into one document.
 * Netscape output gets one comment line per site so the file stays parseable
 * by wget/curl while remaining human readable.
 * @param {Array<{ site: string, cookies: chrome.cookies.Cookie[] }>} groups
 * @param {string} formatKey
 * @returns {string}
 */
export const serializeCombined = (groups, formatKey) => {
  const format = formatMap[formatKey];
  if (!format) throw new Error('Invalid format');
  if (formatKey === 'netscape') {
    const header = [
      '# Netscape HTTP Cookie File',
      '# https://curl.haxx.se/rfc/cookie_spec.html',
      '# This is a generated file! Do not edit.',
      `# Sites: ${groups.map((group) => group.site).join(', ')}`,
      '',
    ];
    const body = groups.flatMap((group) => [
      `# --- ${group.site} (${group.cookies.length} cookies) ---`,
      ...format
        .serializer(group.cookies)
        .split('\n')
        .filter((line) => !line.startsWith('#') && line !== ''),
      '',
    ]);
    return [...header, ...body].join('\n');
  }
  if (formatKey === 'header') {
    // A single Cookie header cannot express two sites; de-duplicate pairs so
    // the result stays syntactically valid.
    const pairs = new Set();
    for (const group of groups) {
      for (const cookie of group.cookies) {
        pairs.add(`${cookie.name}=${cookie.value}`);
      }
    }
    return [...pairs].join('; ') + (pairs.size ? ';' : '');
  }
  // JSON: flat array keeps compatibility with tools expecting a cookie list.
  const cookies = groups.flatMap((group) => group.cookies);
  return JSON.stringify(cookies, null, 2);
};

/**
 * Date stamp used in batch file names, e.g. 20261117.
 * @param {Date} date
 * @returns {string}
 */
const dateStamp = (date) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
};

/**
 * Build the payloads for a batch export.
 * @param {object} params
 * @param {Array<{ site: string, cookies: chrome.cookies.Cookie[] }>} params.groups
 * @param {string} params.formatKey
 * @param {'combined' | 'zip' | 'separate'} params.mode
 * @param {Date} [params.date]
 * @returns {{ files: Array<{ name: string, data: string | Uint8Array }>, totalCookies: number }}
 */
export const buildBatchExport = ({
  groups,
  formatKey,
  mode,
  date = new Date(),
}) => {
  const format = formatMap[formatKey];
  if (!format) throw new Error('Invalid format');
  if (!groups.length) throw new Error('No sites selected');

  const totalCookies = groups.reduce(
    (sum, group) => sum + group.cookies.length,
    0,
  );
  const stamp = dateStamp(date);

  if (mode === 'combined') {
    return {
      files: [
        {
          name: `cookies_all_${groups.length}sites_${stamp}${format.ext}`,
          data: serializeCombined(groups, formatKey),
        },
      ],
      totalCookies,
    };
  }

  const perSiteFiles = groups.map((group) => ({
    name: `${toSafeFileName(group.site)}_cookies_${stamp}${format.ext}`,
    data: format.serializer(group.cookies),
  }));
  const uniqueNames = dedupeFileNames(perSiteFiles.map((file) => file.name));

  if (mode === 'separate') {
    return {
      files: perSiteFiles.map((file, index) => ({
        name: uniqueNames[index],
        data: file.data,
      })),
      totalCookies,
    };
  }

  if (mode === 'zip') {
    const zipName = `cookies_${groups.length}sites_${stamp}.zip`;
    const entries = perSiteFiles.map((file, index) => ({
      name: uniqueNames[index],
      data: file.data,
    }));
    const manifest = [
      '# Multi-site cookies.txt export',
      `# Generated: ${date.toISOString()}`,
      `# Sites: ${groups.length}, cookies: ${totalCookies}`,
      '',
      ...entries.map(
        (entry, index) =>
          `${entry.name}\t${groups[index].site}\t${groups[index].cookies.length} cookies`,
      ),
      '',
    ].join('\n');
    entries.unshift({ name: '_sites.txt', data: manifest });
    return {
      files: [{ name: zipName, data: createZip(entries, { date }) }],
      totalCookies,
    };
  }

  throw new Error(`Unknown export mode: ${mode}`);
};

/**
 * Convenience wrapper: group raw cookies and build a batch export in one step.
 * @param {chrome.cookies.Cookie[]} cookies
 * @param {string[]} selectedSites
 * @param {string} formatKey
 * @param {'combined' | 'zip' | 'separate'} mode
 * @param {Date} [date]
 */
export const buildBatchExportFromCookies = (
  cookies,
  selectedSites,
  formatKey,
  mode,
  date,
) => {
  const siteList = toSiteList(groupCookiesBySite(cookies));
  const selected = new Set(selectedSites);
  const groups = siteList
    .filter((entry) => selected.has(entry.site))
    .map((entry) => ({ site: entry.site, cookies: entry.cookies }));
  return buildBatchExport({ groups, formatKey, mode, date });
};
