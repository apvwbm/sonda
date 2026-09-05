import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './index.ts';

// Relativo al módulo, nunca al cwd: en la imagen de Docker el proceso arranca
// desde donde sea, y los .sql viven junto al JS compilado.
export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

const FILENAME = /^(\d+)_[\w-]+\.sql$/;

export interface Migration {
  version: number;
  filename: string;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
}

export function readMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations: Migration[] = [];

  for (const filename of readdirSync(dir).sort()) {
    if (!filename.endsWith('.sql')) continue;

    const match = FILENAME.exec(filename);
    if (!match?.[1]) {
      throw new Error(
        `Migración con nombre inválido: '${filename}'. Se espera NNN_nombre.sql`,
      );
    }

    migrations.push({ version: Number(match[1]), filename });
  }

  migrations.sort((a, b) => a.version - b.version);

  // Sin huecos ni repetidos: dos ramas que numeren 002 a la vez es el fallo
  // clásico, y si no salta aquí salta con la base ya escrita.
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migraciones mal numeradas: se esperaba la versión ${index + 1} y ` +
          `'${migration.filename}' es la ${migration.version}`,
      );
    }
  });

  return migrations;
}

/**
 * Aplica las migraciones que falten según PRAGMA user_version. Cada una va en su
 * transacción junto con el bump de user_version, así que o entra entera o no
 * entra: no existe el estado "migración a medias".
 */
export function runMigrations(db: Db, dir: string = MIGRATIONS_DIR): MigrationResult {
  const migrations = readMigrations(dir);
  const current = db.pragma('user_version', { simple: true }) as number;
  const latest = migrations.at(-1)?.version ?? 0;

  if (current > latest) {
    throw new Error(
      `La base está en la versión ${current} y este binario solo conoce hasta ` +
        `la ${latest}. Es una base de una versión más nueva de Sonda`,
    );
  }

  const applied: string[] = [];

  for (const migration of migrations) {
    if (migration.version <= current) continue;

    const sql = readFileSync(join(dir, migration.filename), 'utf8');

    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${migration.version}`);
    })();

    applied.push(migration.filename);
  }

  return { from: current, to: latest, applied };
}
