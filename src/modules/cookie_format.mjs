/**
 * Netscape/Header formats cannot represent CHIPS partition keys. Collapse
 * variants that share the same domain/path/name, preferring the unpartitioned
 * cookie when both forms exist. JSON keeps every variant.
 * @param {chrome.cookies.Cookie[]} cookies
 * @returns {chrome.cookies.Cookie[]}
 */
export const collapsePartitionedCookies = (cookies) => {
  /** @type {Map<string, chrome.cookies.Cookie>} */
  const byIdentity = new Map();
  for (const cookie of cookies) {
    const identity = [cookie.domain, cookie.path, cookie.name].join('\u0000');
    const existing = byIdentity.get(identity);
    if (!existing || (existing.partitionKey && !cookie.partitionKey)) {
      byIdentity.set(identity, cookie);
    }
  }
  return [...byIdentity.values()];
};

/**
 * Convert Chrome's JSON format cookies data to a string array for Netscape format
 * @param {chrome.cookies.Cookie[]} cookies
 * @param {{ markHttpOnly?: boolean }} [options]
 * @returns {string[][]}
 */
export const jsonToNetscapeMapper = (
  cookies,
  { markHttpOnly = false } = {},
) => {
  return cookies.map(
    ({ domain, expirationDate, path, secure, name, value, httpOnly }) => {
      const includeSubDomain = !!domain?.startsWith('.');
      const expiry = expirationDate?.toFixed() ?? '0';
      const outputDomain =
        markHttpOnly && httpOnly ? `#HttpOnly_${domain}` : domain;
      const arr = [
        outputDomain,
        includeSubDomain,
        path,
        secure,
        expiry,
        name,
        value,
      ];
      return arr.map((v) =>
        typeof v === 'boolean' ? v.toString().toUpperCase() : v,
      );
    },
  );
};

/** @type {Record<string, Format>} */
export const formatMap = {
  netscape: {
    ext: '.txt',
    mimeType: 'text/plain',
    serializer: (cookies) => {
      const netscapeTable = jsonToNetscapeMapper(
        collapsePartitionedCookies(cookies),
        { markHttpOnly: true },
      );
      const text = [
        '# Netscape HTTP Cookie File',
        '# https://curl.haxx.se/rfc/cookie_spec.html',
        '# This is a generated file! Do not edit.',
        '',
        ...netscapeTable.map((row) => row.join('\t')),
        '', // Add a new line at the end
      ].join('\n');
      return text;
    },
  },
  json: {
    ext: '.json',
    mimeType: 'application/json',
    serializer: JSON.stringify,
  },
  header: {
    ext: '.txt',
    mimeType: 'text/plain',
    serializer: (cookies) => {
      return collapsePartitionedCookies(cookies)
        .map(({ name, value }) => `${name}=${value};`)
        .join(' ');
    },
  },
};
