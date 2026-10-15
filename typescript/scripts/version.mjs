// Keeps the version of @valkv/edgekv, its platform packages and the native
// crate in step: they are published together and must match exactly.
//
//   node scripts/version.mjs set 0.2.0     write it everywhere
//   node scripts/version.mjs check 0.2.0   fail unless every file says it
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const [command, version] = process.argv.slice(2);
if (!['set', 'check'].includes(command) || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/version.mjs set|check X.Y.Z');
  process.exit(2);
}

const main = join(here, 'package.json');
const platforms = readdirSync(join(here, 'npm')).map((dir) => join(here, 'npm', dir, 'package.json'));
const cargo = join(here, '..', 'native', 'Cargo.toml');

const wrong = [];
const show = (file) => relative(join(here, '..'), file).replaceAll('\\', '/');
const json = (file, edit) => {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  if (command === 'set') {
    edit(pkg);
    writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  } else {
    if (pkg.version !== version) wrong.push(`${show(file)}: version ${pkg.version}`);
    for (const [name, wanted] of Object.entries(pkg.optionalDependencies ?? {})) {
      if (wanted !== version) wrong.push(`${show(file)}: ${name} ${wanted}`);
    }
  }
};

json(main, (pkg) => {
  pkg.version = version;
  for (const name of Object.keys(pkg.optionalDependencies ?? {})) pkg.optionalDependencies[name] = version;
});
for (const file of platforms) json(file, (pkg) => (pkg.version = version));

// The platform packages and the optional dependencies must name the same set.
const names = platforms.map((file) => JSON.parse(readFileSync(file, 'utf8')).name).sort();
const listed = Object.keys(JSON.parse(readFileSync(main, 'utf8')).optionalDependencies ?? {}).sort();
if (names.join() !== listed.join()) wrong.push(`npm/ holds ${names.join(', ')} but optionalDependencies lists ${listed.join(', ')}`);

const toml = readFileSync(cargo, 'utf8');
const found = /^version = "(.*)"$/m.exec(toml)?.[1];
if (command === 'set') writeFileSync(cargo, toml.replace(/^version = ".*"$/m, `version = "${version}"`));
else if (found !== version) wrong.push(`${show(cargo)}: version ${found}`);

if (wrong.length > 0) {
  console.error(`expected ${version} everywhere:\n  ${wrong.join('\n  ')}`);
  process.exit(1);
}
console.log(command === 'set' ? `set ${version}` : `${version} everywhere`);
