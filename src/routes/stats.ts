import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/session.ts';
import type { Db } from '../db/index.ts';
import type { Aggregation, Bucket } from '../lib/schemas.ts';
import { formatZodError, statsQuerySchema } from '../lib/schemas.ts';

export interface StatsBucket {
  date: string;
  value: number | string | null;
  count: number;
}

export interface StatsResult {
  series: string;
  aggregation: Aggregation;
  unit: string | null;
  buckets: StatsBucket[];
}

export class SeriesDesconocida extends Error {}

interface SeriesRow {
  id: number;
  aggregation: Aggregation;
  unit: string | null;
}

/**
 * Agrupa por local_date, no por occurred_at.
 *
 * Es la diferencia entre "¿he leído hoy?" y "¿he leído en el intervalo UTC de
 * hoy?": quien se acuesta a las dos de la mañana vería sus datos en el día
 * equivocado si esto agrupara por el instante. local_date ya viene calculado en
 * la zona del servidor desde la ingesta, así que aquí basta con agrupar por
 * texto y no hay conversiones de huso en la consulta.
 */
const BUCKET_SQL: Record<Bucket, string> = {
  day: 'local_date',
  // La semana empieza en lunes: retroceder seis días y saltar al lunes
  // siguiente aterriza siempre en el lunes de la propia semana, también cuando
  // local_date ya es lunes o es domingo.
  week: "date(local_date, '-6 days', 'weekday 1')",
  month: "date(local_date, 'start of month')",
};

export interface StatsQuery {
  series: string;
  bucket: Bucket;
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * Toda la agregación ocurre en SQLite; JavaScript solo arma la consulta y
 * envuelve la respuesta. Un bucket sin observaciones simplemente no sale del
 * GROUP BY, así que no hay huecos que rellenar ni ceros inventados.
 */
export function computeStats(db: Db, query: StatsQuery): StatsResult {
  const serie = db
    .prepare('SELECT id, aggregation, unit FROM series WHERE slug = ?')
    .get(query.series) as SeriesRow | undefined;

  if (!serie) {
    throw new SeriesDesconocida(`No existe la serie '${query.series}'`);
  }

  const bucketExpr = BUCKET_SQL[query.bucket];
  const filtros = ['series_id = @series_id'];
  const params: Record<string, unknown> = { series_id: serie.id };

  if (query.from !== undefined) {
    filtros.push('local_date >= @from');
    params['from'] = query.from;
  }
  if (query.to !== undefined) {
    filtros.push('local_date <= @to');
    params['to'] = query.to;
  }
  const where = filtros.join(' AND ');

  // 'last' no es una función de agregación: es la observación más reciente de
  // cada bucket. Se resuelve con una ventana y se sigue quedando en SQL.
  const sql =
    serie.aggregation === 'last'
      ? `
        SELECT bucket AS date, valor AS value, n AS count
        FROM (
          SELECT
            ${bucketExpr} AS bucket,
            CASE WHEN value_num IS NOT NULL THEN value_num ELSE value_text END AS valor,
            COUNT(*)     OVER (PARTITION BY ${bucketExpr}) AS n,
            ROW_NUMBER() OVER (PARTITION BY ${bucketExpr}
                               ORDER BY occurred_at DESC, id DESC) AS rn
          FROM observations
          WHERE ${where}
        )
        WHERE rn = 1
        ORDER BY date
      `
      : `
        SELECT
          ${bucketExpr} AS date,
          ${AGREGADO[serie.aggregation]} AS value,
          COUNT(*) AS count
        FROM observations
        WHERE ${where}
        GROUP BY date
        ORDER BY date
      `;

  const buckets = db.prepare(sql).all(params) as StatsBucket[];

  return {
    series: query.series,
    aggregation: serie.aggregation,
    unit: serie.unit,
    buckets,
  };
}

// ROUND a seis decimales solo para quitar el ruido de la representación en
// coma flotante (AVG devolvía 76.35999999999999 por 76.36). Seis decimales
// están muy por encima de cualquier medida real que entre aquí.
const AGREGADO: Record<Exclude<Aggregation, 'last'>, string> = {
  sum: 'ROUND(SUM(value_num), 6)',
  avg: 'ROUND(AVG(value_num), 6)',
  count: 'COUNT(*)',
};

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stats', { preHandler: requireSession }, async (request, reply) => {
    const parsed = statsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: formatZodError(parsed.error) });
    }

    try {
      return computeStats(app.db, parsed.data);
    } catch (error) {
      if (error instanceof SeriesDesconocida) {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }
  });
}
