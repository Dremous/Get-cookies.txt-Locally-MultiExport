#!/usr/bin/env node

const fs = require('node:fs');
const process = require('node:process');
const path = require('node:path');
const archiver = require('archiver');
const { execSync } = require('node:child_process');
const { program } = require('commander');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const options = program
  .option('-f --firefox', 'Build for Firefox')
  .parse(process.argv)
  .opts();

/**
 * Prefer the latest git tag, but fall back to package.json so the build also
 * works in a fresh copy of the repository without tags.
 */
const getVersion = () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json')));
  const version = `v${pkg.version}`;
  try {
    // Use the tag at HEAD only when it matches package.json; a tag left on an
    // earlier commit must not override a freshly bumped version.
    const tags = execSync('git tag --points-at HEAD', {
      cwd: ROOT,
      stdio: 'pipe',
    })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    if (tags.includes(version)) return version;
  } catch {
    // git may be unavailable in a source archive
  }
  return version;
};

const build = async (version) => {
  const mode = options.firefox ? 'firefox' : 'chrome';
  const zipName = `get-cookies.txt-locally_${version}_${mode}.zip`;
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  const output = fs.createWriteStream(path.join(ROOT, 'dist', zipName));

  const archive = archiver('zip', {
    zlib: { level: 9 },
  });

  archive.pipe(output);
  archive.glob('**/*', {
    cwd: SRC,
    ignore: ['manifest*.json', '@types/**', '**/*.map'],
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json')));
  if (options.firefox) {
    const manifestFirefox = JSON.parse(
      fs.readFileSync(path.join(SRC, 'manifest-firefox.json')),
    );
    Object.assign(manifest, manifestFirefox);
  }
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  archive.file(path.join(ROOT, 'LICENSE'), { name: 'LICENSE' });

  await archive.finalize();
  console.log('BUILD', zipName);
};

build(getVersion());
