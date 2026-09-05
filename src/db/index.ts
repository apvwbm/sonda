import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { Config } from '../config.ts';

export type Db = Database.Database;

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
  }
}

export const DB_FILENAME = 'sonda.db';

/**
 * Opens the database, creating SONDA_DATA_DIR if needed.
 *
 * The PRAGMAs live here rather than in a migration because they are per
 * connection, not per schema: they have to be reapplied on every start.
 */
export function openDatabase(config: Config): Db {
  const dataDir = resolve(config.SONDA_DATA_DIR);
  mkdirSync(dataDir, { recursive: true });

  const db = new Database(join(dataDir, DB_FILENAME));

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  return db;
}
