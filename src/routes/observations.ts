import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { requireSession, requireSessionOrBearer } from '../auth/session.ts';
import type { Db } from '../db/index.ts';
import { toLocalDate } from '../lib/localdate.ts';
import type { ObservationInput, ValueType } from '../lib/schemas.ts';
import {
  formatZodError,
  idParamSchema,
  ingestSchema,
  listObservationsQuerySchema,
} from '../lib/schemas.ts';

export interface IngestResult {
  inserted: number;
  updated: number;
  series_desconocidas: string[];
}

/** Error de datos del cliente: aborta el lote entero con un 400. */
export class IngestValidationError extends Error {}

interface SeriesLookup {
  id: number;
  slug: string;
  value_type: ValueType;
}

interface StoredValue {
  value_num: number | null;
  value_text: string | null;
}

/**
 * El payload manda un solo 'value'; la tabla tiene value_num y value_text. Cuál
 * de las dos se llena lo decide el value_type de la serie, no el cliente.
 */
function toStoredValue(
  value: ObservationInput['value'],
  series: SeriesLookup,
  indice: number,
): StoredValue {
  const falla = (esperado: string): never => {
    throw new IngestValidationError(
      `observations[${indice}]: la serie '${series.slug}' es de tipo ` +
        `'${series.value_type}' y espera ${esperado}, y llegó ${JSON.stringify(value)}`,
    );
  };

  switch (series.value_type) {
    case 'bool':
      if (typeof value === 'boolean') return { value_num: value ? 1 : 0, value_text: null };
      if (value === 0 || value === 1) return { value_num: value, value_text: null };
      return falla('true, false, 0 o 1');

    case 'number':
      if (typeof value === 'number') return { value_num: value, value_text: null };
      return falla('un número');

    case 'duration':
      // La columna guarda segundos; una duración negativa no existe.
      if (typeof value === 'number' && value >= 0) return { value_num: value, value_text: null };
      return falla('un número de segundos no negativo');

    case 'text':
      if (typeof value === 'string') return { value_num: null, value_text: value };
      return falla('una cadena de texto');
  }
}

/**
 * Ingesta idempotente. Todo el lote en una transacción: o entra entero o no
 * entra nada. La única excepción no fatal es la serie desconocida, que se
 * reporta y deja pasar al resto.
 */
export function ingestObservations(
  db: Db,
  input: { source: string; timeZone: string; observations: ObservationInput[] },
): IngestResult {
  const series = db.prepare('SELECT id, slug, value_type FROM series').all() as SeriesLookup[];
  const porSlug = new Map(series.map((s) => [s.slug, s]));

  const yaExiste = db.prepare(
    'SELECT 1 FROM observations WHERE source = ? AND external_id = ?',
  );

  // created_at solo se escribe al insertar: una corrección no reescribe cuándo
  // se registró el dato por primera vez.
  const upsert = db.prepare(`
    INSERT INTO observations
      (series_id, occurred_at, local_date, value_num, value_text, source, external_id, created_at)
    VALUES
      (@series_id, @occurred_at, @local_date, @value_num, @value_text, @source, @external_id, @created_at)
    ON CONFLICT (source, external_id) DO UPDATE SET
      series_id   = excluded.series_id,
      occurred_at = excluded.occurred_at,
      local_date  = excluded.local_date,
      value_num   = excluded.value_num,
      value_text  = excluded.value_text
  `);

  const desconocidas = new Set<string>();
  let inserted = 0;
  let updated = 0;

  db.transaction(() => {
    const now = new Date().toISOString();

    input.observations.forEach((obs, indice) => {
      const serie = porSlug.get(obs.series);
      if (!serie) {
        desconocidas.add(obs.series);
        return;
      }

      const { value_num, value_text } = toStoredValue(obs.value, serie, indice);
      const external_id = obs.external_id ?? randomUUID();

      // Dentro de la transacción, así que un duplicado dentro del propio lote
      // también se cuenta como update.
      const existia = yaExiste.get(input.source, external_id) !== undefined;

      upsert.run({
        series_id: serie.id,
        occurred_at: obs.occurred_at,
        local_date: toLocalDate(obs.occurred_at, input.timeZone),
        value_num,
        value_text,
        source: input.source,
        external_id,
        created_at: now,
      });

      if (existia) updated += 1;
      else inserted += 1;
    });
  })();

  return {
    inserted,
    updated,
    series_desconocidas: [...desconocidas].sort(),
  };
}

export async function observationsRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;

  app.post('/api/observations', { preHandler: requireSessionOrBearer }, async (request, reply) => {
    // requireSessionOrBearer ya ha dejado aquí el source: del token si vino
    // bearer, 'manual' si vino cookie. Nunca del payload.
    const auth = request.auth;
    if (!auth) {
      // Inalcanzable con el preHandler puesto. Si algún día se cae de la ruta,
      // que falle cerrado en vez de insertar con source undefined.
      return reply.code(401).send({ error: 'No autenticado' });
    }

    const parsed = ingestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: formatZodError(parsed.error) });
    }

    try {
      return ingestObservations(app.db, {
        source: auth.source,
        timeZone: app.config.SONDA_TZ,
        observations: parsed.data.observations,
      });
    } catch (error) {
      if (error instanceof IngestValidationError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get('/api/observations', { preHandler: requireSession }, async (request, reply) => {
    const parsed = listObservationsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: formatZodError(parsed.error) });
    }
    const { series, from, to, limit, cursor } = parsed.data;

    const filtros: string[] = [];
    const params: Record<string, unknown> = { limit: limit + 1 };

    if (series !== undefined) {
      const serie = db.prepare('SELECT id FROM series WHERE slug = ?').get(series) as
        | { id: number }
        | undefined;
      if (!serie) {
        return reply.code(404).send({ error: `No existe la serie '${series}'` });
      }
      filtros.push('o.series_id = @series_id');
      params['series_id'] = serie.id;
    }

    // from y to filtran por local_date, igual que /api/stats: preguntar por
    // 'del 1 al 5 de septiembre' es una pregunta de días locales.
    if (from !== undefined) {
      filtros.push('o.local_date >= @from');
      params['from'] = from;
    }
    if (to !== undefined) {
      filtros.push('o.local_date <= @to');
      params['to'] = to;
    }

    if (cursor !== undefined) {
      const punto = decodeCursor(cursor);
      if (!punto) {
        return reply.code(400).send({ error: 'El cursor no es válido' });
      }
      // Comparación por tupla: el orden es (occurred_at, id) descendente.
      filtros.push('(o.occurred_at, o.id) < (@cursor_at, @cursor_id)');
      params['cursor_at'] = punto.occurred_at;
      params['cursor_id'] = punto.id;
    }

    const where = filtros.length > 0 ? `WHERE ${filtros.join(' AND ')}` : '';

    const filas = db
      .prepare(
        `SELECT o.id, s.slug AS series, o.occurred_at, o.local_date,
                CASE WHEN o.value_num IS NOT NULL THEN o.value_num ELSE o.value_text END AS value,
                o.source, o.external_id, o.created_at
         FROM observations o
         JOIN series s ON s.id = o.series_id
         ${where}
         ORDER BY o.occurred_at DESC, o.id DESC
         LIMIT @limit`,
      )
      .all(params) as ObservationRow[];

    // Se pide una fila de más solo para saber si hay página siguiente.
    const hayMas = filas.length > limit;
    const observations = hayMas ? filas.slice(0, limit) : filas;
    const ultima = observations.at(-1);

    return {
      observations,
      next_cursor: hayMas && ultima ? encodeCursor(ultima) : null,
    };
  });

  app.delete('/api/observations/:id', { preHandler: requireSession }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'El id debe ser un entero positivo' });
    }

    const borrada = db.prepare('DELETE FROM observations WHERE id = ?').run(params.data.id);
    if (borrada.changes === 0) {
      return reply.code(404).send({ error: `No existe la observación ${params.data.id}` });
    }

    return { deleted: params.data.id };
  });
}

export interface ObservationRow {
  id: number;
  series: string;
  occurred_at: string;
  local_date: string;
  value: number | string | null;
  source: string;
  external_id: string;
  created_at: string;
}

/**
 * Paginación por cursor y no por OFFSET: con OFFSET, insertar mientras se
 * pagina desplaza las páginas y se repiten o se saltan filas. El cursor es la
 * última posición leída del orden (occurred_at, id), que es total y estable.
 */
function encodeCursor(row: ObservationRow): string {
  return Buffer.from(`${row.occurred_at}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { occurred_at: string; id: number } | null {
  const texto = Buffer.from(cursor, 'base64url').toString('utf8');
  const corte = texto.lastIndexOf('|');
  if (corte === -1) return null;

  const occurred_at = texto.slice(0, corte);
  const id = Number(texto.slice(corte + 1));
  if (occurred_at === '' || !Number.isInteger(id)) return null;

  return { occurred_at, id };
}
