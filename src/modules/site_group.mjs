/**
 * Public suffixes that consist of two labels (e.g. "co.uk", "com.cn").
 * A cookie domain such as "shop.example.co.uk" is grouped under
 * "example.co.uk" instead of "co.uk".
 *
 * The list is intentionally compact: it covers the most common cases without
 * shipping the full Public Suffix List inside the extension.
 */
const TWO_LABEL_PUBLIC_SUFFIXES = new Set([
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
 * @param {string | undefined} domain
 * @returns {string}
 */
export const getSiteKey = (domain) => {
  const host = normalizeDomain(domain);
  if (!host) return '';
  if (host === 'localhost' || isIpAddress(host)) return host;

  const labels = host.split('.');
  if (labels.length <= 2) return host;

  const lastTwo = labels.slice(-2).join('.');
  const suffixLength = TWO_LABEL_PUBLIC_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-suffixLength).join('.');
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
