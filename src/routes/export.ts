import { randomUUID } from 'node:crypto';
import { createReadStream, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/session.ts';
import { toLocalDate } from '../lib/localdate.ts';

const TEMP_PREFIX = 'export-';
/** A temp file older than this is debris from a process that died mid-export. */
const TEMP_MAX_AGE_MS = 60 * 60 * 1_000;

/**
 * A consistent copy via VACUUM INTO, never by reading the live file.
 *
 * `cp` on a SQLite database in use can catch it half-written, and with WAL it
 * also misses everything not yet checkpointed: the result is a backup that
 * looks fine until the day it is needed. VACUUM INTO writes a fresh, compacted
 * database from a single snapshot.
 */
function removeStaleTempFiles(dataDir: string, now: number): void {
  for (const name of readdirSync(dataDir)) {
    if (!name.startsWith(TEMP_PREFIX)) continue;

    const path = join(dataDir, name);
    try {
      if (now - statSync(path).mtimeMs > TEMP_MAX_AGE_MS) {
        rmSync(path, { force: true });
      }
    } catch {
      // Another process may have removed it already, or hold it open on Windows.
    }
  }
}

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/export', { preHandler: requireSession }, async (request, reply) => {
    const dataDir = resolve(app.config.SONDA_DATA_DIR);
    removeStaleTempFiles(dataDir, Date.now());

    // A random name because VACUUM INTO refuses an existing destination, and
    // inside SONDA_DATA_DIR because that is the one directory known writable.
    const tempFile = join(dataDir, `${TEMP_PREFIX}${randomUUID()}.db`);

    app.db.prepare('VACUUM INTO ?').run(tempFile);

    const remove = (): void => {
      try {
        rmSync(tempFile, { force: true });
      } catch (error) {
        request.log.warn({ err: error, tempFile }, 'could not remove the temporary export');
      }
    };

    try {
      const bytes = statSync(tempFile).size;
      const date = toLocalDate(new Date().toISOString(), app.config.SONDA_TZ);

      const stream = createReadStream(tempFile);
      // 'close' fires both on success and when the client aborts mid-download.
      stream.on('close', remove);
      stream.on('error', remove);

      return await reply
        .header('Content-Type', 'application/vnd.sqlite3')
        .header('Content-Disposition', `attachment; filename="sonda-${date}.db"`)
        .header('Content-Length', String(bytes))
        .send(stream);
    } catch (error) {
      // The stream never opened, so nothing else is going to delete the file.
      remove();
      throw error;
    }
  });
}
