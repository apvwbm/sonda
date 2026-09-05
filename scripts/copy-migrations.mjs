// tsc solo emite JS: los .sql hay que llevarlos a dist a mano para que acaben
// en la imagen de Docker junto al migrate.js que los lee.
import { cpSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = dirname(import.meta.dirname);
const from = join(root, 'src', 'db', 'migrations');
const to = join(root, 'dist', 'db', 'migrations');

cpSync(from, to, { recursive: true });

const copied = readdirSync(to).filter((f) => f.endsWith('.sql'));
if (copied.length === 0) {
  console.error(`No se copió ninguna migración desde ${from}`);
  process.exit(1);
}

console.log(`Migraciones copiadas a dist: ${copied.join(', ')}`);
