const fs = require('node:fs');
const path = require('node:path');
const { program } = require('commander');

const ROOT = path.join(__dirname, '..');
const PACKAGE_PATH = path.resolve(ROOT, 'package.json');
const LOCK_PATH = path.resolve(ROOT, 'package-lock.json');
const MANIFEST_PATH = path.resolve(ROOT, 'src', 'manifest.json');

const options = program
  .option('--fix', 'Fix version mismatch by updating manifest and lockfile')
  .parse(process.argv)
  .opts();

/**
 * Return the latest of two semver strings (major.minor.patch).
 * @param {string} ver1
 * @param {string} ver2
 * @returns {string}
 */
const latest = (ver1, ver2) => {
  if (!ver1) return ver2;
  if (!ver2) return ver1;

  const part1 = ver1.split('.').map(Number);
  const part2 = ver2.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const n1 = part1[i] ?? 0;
    const n2 = part2[i] ?? 0;
    if (n1 > n2) return ver1;
    if (n1 < n2) return ver2;
  }
  return ver1;
};

/**
 * Keep package.json, manifest.json, and package-lock.json in sync.
 */
const run = () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  const man = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const lockRoot = lock.packages?.['']?.version;

  const versions = {
    'package.json': pkg.version,
    'src/manifest.json': man.version,
    'package-lock.json': lock.version,
    'package-lock.json (packages[""])': lockRoot,
  };
  const values = Object.values(versions).filter(Boolean);
  const expected = values.reduce((current, value) => latest(current, value));

  if (values.every((value) => value === expected)) {
    console.log(`✅ Versions are in sync: ${expected}`);
    return;
  }

  for (const [file, value] of Object.entries(versions)) {
    if (value !== expected) {
      console.warn(`⚠️ Version mismatch: ${file}:${value ?? '(missing)'}`);
    }
  }

  if (!options.fix) {
    console.error('❌ Check failed: Versions are not in sync.');
    process.exitCode = 1;
    return;
  }

  pkg.version = expected;
  man.version = expected;
  lock.version = expected;
  if (lock.packages?.['']) lock.packages[''].version = expected;

  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2).trim()}\n`);
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(man, null, 2).trim()}\n`);
  fs.writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2).trim()}\n`);
  console.log(`✅ Fixed versions to ${expected}`);
};

try {
  run();
} catch (error) {
  console.error('An error occurred during version syncing:', error.message);
  process.exitCode = 1;
}
