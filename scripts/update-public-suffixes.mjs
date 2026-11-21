import { writeFile } from 'node:fs/promises';

const SOURCE = 'https://publicsuffix.org/list/public_suffix_list.dat';

const response = await fetch(SOURCE);
if (!response.ok) {
  throw new Error(
    `Could not download the Public Suffix List: ${response.status}`,
  );
}

const text = await response.text();
const exact = [];
const wildcards = [];
const exceptions = [];
let version = 'unknown';
let commit = 'unknown';

for (const line of text.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  if (trimmed.startsWith('//')) {
    const metadata = trimmed.match(/^\/\/\s+(VERSION|COMMIT):\s+(.+)$/);
    if (metadata?.[1] === 'VERSION') version = metadata[2].trim();
    if (metadata?.[1] === 'COMMIT') commit = metadata[2].trim();
    continue;
  }
  if (trimmed.startsWith('!')) exceptions.push(trimmed.slice(1));
  else if (trimmed.startsWith('*.')) wildcards.push(trimmed.slice(2));
  else exact.push(trimmed);
}

if (exact.length === 0) {
  throw new Error('The Public Suffix List download contained no rules');
}

const escapeRule = (rule) =>
  rule.replaceAll('`', '\\`').replaceAll('${', '\\${');
const setLiteral = (name, rules) =>
  [
    `export const ${name} = new Set(`,
    '  `',
    rules.map(escapeRule).join('\n'),
    '`',
    '    .trim()',
    "    .split('\\n'),",
    ');',
  ].join('\n');

const output = `/* Public Suffix List data (MPL 2.0), generated from
 * ${SOURCE}
 * VERSION: ${version}
 * COMMIT: ${commit}
 * Do not hand-edit; regenerate with scripts/update-public-suffixes.mjs.
 */
${setLiteral('PUBLIC_SUFFIX_RULES', exact)}

${setLiteral('PUBLIC_SUFFIX_WILDCARDS', wildcards)}

${setLiteral('PUBLIC_SUFFIX_EXCEPTIONS', exceptions)}
`;

await writeFile(
  new URL('../src/modules/public_suffix_data.mjs', import.meta.url),
  output,
);
console.log(
  `Wrote ${exact.length} exact, ${wildcards.length} wildcard, ${exceptions.length} exception rules (${version}).`,
);
