import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './index.ts';

// Resolved against the module, never the cwd: inside the container the process
// may start from anywhere, and the .sql files ship next to the compiled JS.
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
      throw new Error(`Bad migration filename: '${filename}'. Expected NNN_name.sql`);
    }

    migrations.push({ version: Number(match[1]), filename });
  }

  migrations.sort((a, b) => a.version - b.version);

  // No gaps and no duplicates. Two branches both numbering theirs 002 is the
  // classic failure, and if it does not blow up here it blows up with the
  // database already half written.
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Misnumbered migrations: expected version ${index + 1} but ` +
          `'${migration.filename}' is ${migration.version}`,
      );
    }
  });

  return migrations;
}

/**
 * Applies whatever is missing according to PRAGMA user_version.
 *
 * Each migration runs in its own transaction together with its user_version
 * bump, so it either lands whole or not at all: there is no "half-migrated"
 * state to recover from.
 */
export function runMigrations(db: Db, dir: string = MIGRATIONS_DIR): MigrationResult {
  const migrations = readMigrations(dir);
  const current = db.pragma('user_version', { simple: true }) as number;
  const latest = migrations.at(-1)?.version ?? 0;

  if (current > latest) {
    throw new Error(
      `The database is at version ${current} but this build only knows up to ` +
        `${latest}. This database was written by a newer version of Sonda`,
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
