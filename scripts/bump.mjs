import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BUMP_KEYWORDS = new Set([
  'patch',
  'minor',
  'major',
  'prepatch',
  'preminor',
  'premajor',
  'prerelease'
]);
const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

if (process.argv.length > 3) {
  console.error('Usage: node scripts/bump.mjs [patch|minor|major|prepatch|preminor|premajor|prerelease|<semver>]');
  process.exit(1);
}

const target = process.argv[2] === undefined ? 'patch' : process.argv[2];
if (!BUMP_KEYWORDS.has(target) && !SEMVER_RE.test(target)) {
  console.error(
    `Invalid version target "${target}". Expected a bump keyword (${[...BUMP_KEYWORDS].join(', ')}) or strict semver (e.g. 1.2.3).`
  );
  process.exit(1);
}

function runNpm(args) {
  if (process.env.npm_execpath) {
    execFileSync(process.execPath, [process.env.npm_execpath, ...args], { stdio: 'inherit' });
    return;
  }
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { stdio: 'inherit' });
    return;
  }
  execFileSync('npm', args, { stdio: 'inherit' });
}

function runTscCheck() {
  const tscBin = path.resolve('node_modules/typescript/bin/tsc');
  if (fs.existsSync(tscBin)) {
    execFileSync(process.execPath, [tscBin, '--noEmit'], { stdio: 'inherit' });
    return;
  }
  runNpm(['exec', '--', 'tsc', '--noEmit']);
}

runTscCheck();
runNpm(['test']);
runNpm(['version', target, '--no-git-tag-version']);

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const newVersion = pkg.version;

console.log(`\nBuilding v${newVersion}...`);
runNpm(['run', 'build']);