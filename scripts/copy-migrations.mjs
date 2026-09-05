// tsc only emits JS, so the .sql files have to be carried into dist/ by hand
// for them to reach the Docker image next to the migrate.js that reads them.
import { cpSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = dirname(import.meta.dirname);
const from = join(root, 'src', 'db', 'migrations');
const to = join(root, 'dist', 'db', 'migrations');

cpSync(from, to, { recursive: true });

const copied = readdirSync(to).filter((f) => f.endsWith('.sql'));
if (copied.length === 0) {
  console.error(`No migrations were copied from ${from}`);
  process.exit(1);
}

console.log(`Migrations copied into dist: ${copied.join(', ')}`);
