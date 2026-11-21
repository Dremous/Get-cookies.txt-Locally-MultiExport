import {
  PUBLIC_SUFFIX_EXCEPTIONS,
  PUBLIC_SUFFIX_RULES,
  PUBLIC_SUFFIX_WILDCARDS,
} from './public_suffix_data.mjs';

/**
 * Maximum rule depth to inspect. The official Public Suffix List currently
 * tops out well below this; the limit only prevents a pathological hostname
 * from turning one lookup into an unbounded number of joins.
 */
const MAX_RULE_LABELS = 16;

/**
 * Get the number of labels in the public suffix for a hostname.
 *
 * This follows the Public Suffix List matching order: an exception rule wins
 * over an exact or wildcard rule, then the most specific exact/wildcard rule
 * wins. A host that is itself a public suffix has no registrable parent.
 * @param {string} host
 * @returns {number}
 */
const getPublicSuffixLength = (host) => {
  const labels = host.split('.');

  // Exception rules ("!www.ck") are public suffixes with the leftmost label
  // removed. Match the longest exception suffix so subdomains of an exception
  // stay grouped with the exception host.
  for (
    let suffixLength = Math.min(labels.length, MAX_RULE_LABELS);
    suffixLength >= 1;
    suffixLength--
  ) {
    const suffix = labels.slice(-suffixLength).join('.');
    if (PUBLIC_SUFFIX_EXCEPTIONS.has(suffix)) {
      return Math.max(0, suffixLength - 1);
    }
  }

  let publicSuffixLength = 0;
  for (
    let suffixLength = Math.min(labels.length, MAX_RULE_LABELS);
    suffixLength >= 1;
    suffixLength--
  ) {
    const suffix = labels.slice(-suffixLength).join('.');
    if (PUBLIC_SUFFIX_RULES.has(suffix)) {
      publicSuffixLength = suffixLength;
      break;
    }
  }

  for (
    let baseLength = Math.min(labels.length - 1, MAX_RULE_LABELS);
    baseLength >= 1;
    baseLength--
  ) {
    const base = labels.slice(-baseLength).join('.');
    if (PUBLIC_SUFFIX_WILDCARDS.has(base)) {
      publicSuffixLength = Math.max(publicSuffixLength, baseLength + 1);
      break;
    }
  }

  return publicSuffixLength || 1;
};

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

  const labels = host.split('.');
  if (labels.length <= 1) return host;

  const publicSuffixLength = getPublicSuffixLength(host);
  if (publicSuffixLength >= labels.length) return host;
  return labels.slice(-(publicSuffixLength + 1)).join('.');
};

/**
 * Get the schemeful site used by CHIPS partition keys.
 *
 * CHIPS keys cookies by the top-level site (scheme + registrable domain),
 * not by the full origin, so ports and subdomains must be stripped.
 * @param {string | URL | undefined} value
 * @returns {string | null}
 */
export const getTopLevelSite = (value) => {
  let url;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const site = getSiteKey(url.hostname);
  return site ? `${url.protocol}//${site}` : null;
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
