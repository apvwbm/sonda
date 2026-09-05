import { randomUUID } from 'node:crypto';
import { createReadStream, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/session.ts';
import { toLocalDate } from '../lib/localdate.ts';

const PREFIJO_TEMPORAL = 'export-';
/** Un temporal más viejo que esto es basura de un proceso que murió a medias. */
const CADUCIDAD_TEMPORAL_MS = 60 * 60 * 1_000;

/**
 * Copia consistente con VACUUM INTO, nunca copiando el fichero vivo.
 *
 * Un `cp` de un SQLite en uso puede pillar la base a medio escribir, y con WAL
 * además deja fuera todo lo que aún no ha hecho checkpoint: el resultado es un
 * backup que parece bueno hasta el día que hace falta. VACUUM INTO escribe una
 * base nueva, compactada y coherente, desde una única instantánea.
 */
function limpiaTemporalesViejos(dataDir: string, ahora: number): void {
  for (const nombre of readdirSync(dataDir)) {
    if (!nombre.startsWith(PREFIJO_TEMPORAL)) continue;

    const ruta = join(dataDir, nombre);
    try {
      if (ahora - statSync(ruta).mtimeMs > CADUCIDAD_TEMPORAL_MS) {
        rmSync(ruta, { force: true });
      }
    } catch {
      // Otro proceso puede haberlo borrado ya, o tenerlo abierto en Windows.
    }
  }
}

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/export', { preHandler: requireSession }, async (request, reply) => {
    const dataDir = resolve(app.config.SONDA_DATA_DIR);
    limpiaTemporalesViejos(dataDir, Date.now());

    // Nombre aleatorio porque VACUUM INTO se niega si el destino ya existe, y
    // dentro de SONDA_DATA_DIR porque es el único sitio que sabemos escribible.
    const temporal = join(dataDir, `${PREFIJO_TEMPORAL}${randomUUID()}.db`);

    app.db.prepare('VACUUM INTO ?').run(temporal);

    const borra = (): void => {
      try {
        rmSync(temporal, { force: true });
      } catch (error) {
        request.log.warn({ err: error, temporal }, 'no se pudo borrar el export temporal');
      }
    };

    try {
      const bytes = statSync(temporal).size;
      const fecha = toLocalDate(new Date().toISOString(), app.config.SONDA_TZ);

      const stream = createReadStream(temporal);
      // 'close' salta tanto al terminar bien como si el cliente corta a mitad.
      stream.on('close', borra);
      stream.on('error', borra);

      return await reply
        .header('Content-Type', 'application/vnd.sqlite3')
        .header('Content-Disposition', `attachment; filename="sonda-${fecha}.db"`)
        .header('Content-Length', String(bytes))
        .send(stream);
    } catch (error) {
      // Si no se llegó a abrir el stream, nadie va a borrarlo.
      borra();
      throw error;
    }
  });
}
