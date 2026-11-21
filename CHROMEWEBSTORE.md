# Chrome Web Store submission notes

This document is the listing and review checklist for the Chrome build of
**Get cookies.txt LOCALLY — Multi-Site**. It mirrors the Firefox/AMO metadata
but uses Chrome Web Store terminology.

## Listing

- **Name:** Get cookies.txt LOCALLY — Multi-Site
- **Short description:** Export cookies.txt locally, including batch export for multiple sites at once.
- **Category:** Productivity
- **Language:** English
- **Homepage:** <https://github.com/Dremous/Get-cookies.txt-Locally-MultiExport>
- **Privacy policy:** <https://github.com/Dremous/Get-cookies.txt-Locally-MultiExport/blob/main/privacy-policy.md>

### Full description

Export the current site, or every site in the current cookie store, to Netscape
cookies.txt, JSON, or a request Header String. Cookies are read with the
`chrome.cookies` API and packaged locally; the extension contains no network
code and never uploads cookie data.

Features:

- Export the current site with `activeTab` or a site-specific host grant.
- List every site in the current cookie store, grouped by registrable domain.
- Select multiple sites and export as one merged file, a ZIP, or separate downloads.
- Copy the current site or selected sites to the clipboard.
- Preserve partitioned-cookie metadata in JSON where the browser exposes it.

The batch view needs access to all sites because it enumerates the entire
cookie store. The current-site view can work with the temporary `activeTab`
grant. Users can revoke access from `chrome://extensions`.

## Single purpose

Provide a local-only cookie export and multi-site batch export utility. The
extension does not provide browsing, ad blocking, search, or unrelated
services.

## Permission justification

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Read the current tab's URL and cookies after the user opens the popup, without requiring a permanent host grant for the current-site view. |
| `cookies` | Read cookies through `chrome.cookies.getAll`; cookies are serialized locally and never transmitted. |
| `downloads` | Save the exported cookies.txt/JSON/ZIP file and support the "Export As" save dialog. |
| `clipboardWrite` | Copy the serialized cookie text when the user presses Copy or Copy merged. |
| `notifications` | Show the existing update notification; no marketing or remote push. |
| `host_permissions: <all_urls>` | Enumerate cookies across all sites for the optional "Export All Cookies" and multi-site batch export. No page content is read and no network request is made. |

The `<all_urls>` warning is expected for the batch feature. The popup explains
which permission is missing when a batch read fails.

## Privacy and data-use disclosure

- **Data collected:** None. The extension has no analytics, telemetry, remote
  logging, account system, or network code.
- **Data handled locally:** Cookie names, values, domains, paths, expiry,
  flags, partition keys, and the active tab URL. They are written only to a
  user-requested download or the clipboard.
- **Data sold/shared:** No.
- **Remote code:** No. All scripts are packaged in the extension.
- **Retention:** The extension does not retain cookie data. It stores only UI
  preferences (format, batch mode, and selection) in `localStorage`.
- **User control:** Users can revoke host access in `chrome://extensions`, clear
  extension storage, or uninstall the extension.

The authoritative policy is [`privacy-policy.md`](privacy-policy.md).

## Store assets

| Asset | Status |
| --- | --- |
| 128×128 icon | `src/images/icon128.png` |
| 16/32/48 icons | `src/images/icon16.png`, `icon32.png`, `icon48.png` |
| Screenshots | `docs/screenshot-multi.png`, `docs/screenshot-single.png` are 500×640 README images; prepare 1280×800 or 640×400 store screenshots before submitting. |
| Promotional tile | Not provided; optional. |

## Reviewer test instructions

1. Build the Chrome bundle with `npm run build:chrome` and unzip
   `dist/get-cookies.txt-locally_v*_chrome.zip`.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Visit two sites that set cookies (for example `https://example.com` and
   `https://example.org`), then open the extension popup.
4. In **Current Site**, press **Export** and confirm a `.txt` download; press
   **Copy** and confirm the "Copied!" feedback.
5. In **Multiple Sites**, select two entries and export with Netscape, JSON, and ZIP.
6. To test the missing-permission path, open the extension's **Site access**
   settings and remove the all-sites grant, then reopen the popup; the batch
   view should explain the missing permission while the current-site view
   remains usable where `activeTab` allows it.

No login, purchase, or external service is required for review.

## Submission checklist

- [ ] Bump `package.json`, `package-lock.json`, and `src/manifest.json` to the
      same version.
- [ ] Run `npm run check`, `npm test`, `npm run build`, and `web-ext lint` on the
      Firefox bundle.
- [ ] Run the Chrome E2E suite against the built bundle.
- [ ] Confirm the ZIP contains `manifest.json`, `LICENSE`,
      `THIRD_PARTY_NOTICES.md`, and `LICENSES/MPL-2.0.txt`.
- [ ] Upload 1280×800 (or 640×400) screenshots and the 128×128 icon.
- [ ] Complete the Privacy practices form with "no collection" and the
      permission explanations above.
- [ ] Confirm the listing does not claim affiliation with Google or the
      upstream project beyond the fork attribution.
- [ ] Keep the published version immutable; publish a new version for every
      code change.

## Known limitations to mention in review notes

- Batch export requires the all-sites host grant; without it, the batch panel
  is unavailable by design.
- Header String output is single-site only because one request header cannot
  represent cookies from unrelated domains.
- Netscape and Header String cannot represent CHIPS partition keys; JSON is
  the lossless format for partitioned cookies.
- Firefox uses a separate AMO submission process; see `README.md`.
