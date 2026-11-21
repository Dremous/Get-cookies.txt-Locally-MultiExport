# Third-party notices

This project is distributed under the MIT License; see [`LICENSE`](LICENSE).

## Public Suffix List

The registrable-domain grouping feature embeds a generated snapshot of the
[Public Suffix List](https://publicsuffix.org/list/).

- Source: <https://publicsuffix.org/list/public_suffix_list.dat>
- License: Mozilla Public License 2.0 (MPL 2.0)
- Full license text: [`LICENSES/MPL-2.0.txt`](LICENSES/MPL-2.0.txt)
- Generated data: `src/modules/public_suffix_data.mjs`
- Regenerate with: `npm run update-psl`

The generated module records the upstream `VERSION` and `COMMIT` metadata at
the top of the file. The MPL 2.0 notice and license text are included in both
the Chrome and Firefox release bundles.
