import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '../../../dist/packages/nx-fhir');

const pkg = JSON.parse(readFileSync(join(distDir, 'package.json'), 'utf8'));
const migrationsPath = join(distDir, 'migrations.json');
const migrations = JSON.parse(readFileSync(migrationsPath, 'utf8'));

migrations.generators['check-project-updates'].version = pkg.version;

writeFileSync(migrationsPath, JSON.stringify(migrations, null, 2) + '\n');
console.log(`Synced check-project-updates migration version to ${pkg.version}`);
