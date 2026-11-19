/**
 * Public suffixes that are commonly used by cookie-bearing sites.
 *
 * The list covers two-label country-code suffixes (e.g. "co.uk", "com.cn")
 * and common private suffixes (e.g. "github.io", "vercel.app",
 * "s3.amazonaws.com"). Without these private entries every tenant of a
 * shared host such as "alice.github.io" and "bob.github.io" would collapse
 * into one "github.io" bucket.
 *
 * The list is intentionally compact: it covers the most common cases without
 * shipping the full Public Suffix List (which is hundreds of kilobytes)
 * inside the extension.
 */
const PUBLIC_SUFFIXES = new Set([
  'ac.cn',
  'ac.jp',
  'ac.uk',
  'co.id',
  'co.il',
  'co.in',
  'co.jp',
  'co.kr',
  'co.nz',
  'co.th',
  'co.uk',
  'co.za',
  'com.ar',
  'com.au',
  'com.br',
  'com.cn',
  'com.co',
  'com.eg',
  'com.es',
  'com.hk',
  'com.mx',
  'com.my',
  'com.ph',
  'com.pl',
  'com.ru',
  'com.sa',
  'com.sg',
  'com.tr',
  'com.tw',
  'com.ua',
  'com.vn',
  'edu.au',
  'edu.cn',
  'edu.hk',
  'edu.sg',
  'gov.au',
  'gov.cn',
  'gov.hk',
  'gov.uk',
  'in.th',
  'net.au',
  'net.cn',
  'net.hk',
  'net.nz',
  'net.sg',
  'org.au',
  'org.cn',
  'org.hk',
  'org.nz',
  'org.sg',
  'org.uk',
  // Common private suffixes from the Public Suffix List.
  'appspot.com',
  'azurewebsites.net',
  'blogspot.com',
  'cloudfront.net',
  'firebaseapp.com',
  'fly.dev',
  'github.io',
  'githubusercontent.com',
  'gitlab.io',
  'herokuapp.com',
  'netlify.app',
  'notion.site',
  'onrender.com',
  'pages.dev',
  'r2.dev',
  'readthedocs.io',
  's3.amazonaws.com',
  'vercel.app',
  'web.app',
  'workers.dev',
]);

/**
 * Normalize a cookie domain ("`.Example.COM.`" -> "example.com").
 * @param {string | undefined} domain
 * @returns {string}
 */
export const normalizeDomain = (domain) =>
  (domain ?? '').trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');

/**
 * Whether the host is an IPv4 or IPv6 address.
 * @param {string} host
 * @returns {boolean}
 */
const isIpAddress = (host) => {
  if (host.includes(':')) return true;
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
};

/**
 * Get the registrable domain ("site key") a cookie belongs to.
 * ".www.example.co.uk" -> "example.co.uk", "localhost" -> "localhost".
 *
 * The longest matching suffix wins, which is required for three-label
 * private suffixes such as "s3.amazonaws.com". When a host is itself a
 * public suffix (e.g. "github.io"), it has no registrable parent and is
 * returned unchanged.
 * @param {string | undefined} domain
 * @returns {string}
 */
export const getSiteKey = (domain) => {
  const host = normalizeDomain(domain);
  if (!host) return '';
  if (host === 'localhost' || isIpAddress(host)) return host;

  if (PUBLIC_SUFFIXES.has(host)) return host;

  const labels = host.split('.');
  if (labels.length <= 1) return host;

  for (
    let suffixLength = Math.min(labels.length - 1, 3);
    suffixLength >= 1;
    suffixLength--
  ) {
    const suffix = labels.slice(-suffixLength).join('.');
    if (PUBLIC_SUFFIXES.has(suffix)) {
      return labels.slice(-(suffixLength + 1)).join('.');
    }
  }
  return labels.slice(-2).join('.');
};

/**
 * Group cookies by their registrable domain.
 * @param {chrome.cookies.Cookie[]} cookies
 * @returns {Map<string, { site: string, cookies: chrome.cookies.Cookie[], domains: Set<string> }>}
 */
export const groupCookiesBySite = (cookies) => {
  /** @type {Map<string, { site: string, cookies: chrome.cookies.Cookie[], domains: Set<string> }>} */
  const groups = new Map();
  for (const cookie of cookies) {
    const site = getSiteKey(cookie.domain) || '(unknown)';
    let group = groups.get(site);
    if (!group) {
      group = { site, cookies: [], domains: new Set() };
      groups.set(site, group);
    }
    group.cookies.push(cookie);
    group.domains.add(normalizeDomain(cookie.domain));
  }
  return groups;
};

/**
 * Turn the groups into an alphabetically sorted list for the popup.
 * @param {Map<string, { site: string, cookies: chrome.cookies.Cookie[], domains: Set<string> }>} groups
 * @returns {Array<{ site: string, cookies: chrome.cookies.Cookie[], cookieCount: number, domainCount: number }>}
 */
export const toSiteList = (groups) =>
  [...groups.values()]
    .map(({ site, cookies, domains }) => ({
      site,
      cookies,
      cookieCount: cookies.length,
      domainCount: domains.size,
    }))
    .sort((a, b) => a.site.localeCompare(b.site));

/**
 * Case-insensitive site filter used by the popup search box.
 * @param {{ site: string }} site
 * @param {string} query
 * @returns {boolean}
 */
export const matchesSiteQuery = (site, query) =>
  site.site.toLowerCase().includes(query.trim().toLowerCase());
