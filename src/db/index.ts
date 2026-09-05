import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { Config } from '../config.ts';

export type Db = Database.Database;

// Las rutas llegan a la base por app.db, decorada una sola vez en index.ts.
declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
  }
}

export const DB_FILENAME = 'sonda.db';

/**
 * Abre la base, creando SONDA_DATA_DIR si hace falta. Los PRAGMAs van aquí y no
 * en una migración: son de conexión, hay que repetirlos en cada arranque.
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
