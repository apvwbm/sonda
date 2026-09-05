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

export class UnknownSeriesError extends Error {}

interface SeriesRow {
  id: number;
  aggregation: Aggregation;
  unit: string | null;
}

export interface StatsQuery {
  series: string;
  bucket: Bucket;
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * Grouping happens on local_date, not on occurred_at.
 *
 * That is the difference between "did I read today?" and "did I read during
 * today's UTC interval?": someone who goes to bed at 2am would see their data
 * on the wrong day if this grouped by the instant. local_date was already
 * computed in the server's zone at ingest time, so grouping here is plain text
 * comparison with no time zone conversion in the query.
 */
const BUCKET_SQL: Record<Bucket, string> = {
  day: 'local_date',
  // Weeks start on Monday. Going back six days and then jumping to the next
  // Monday always lands on that week's own Monday, including when local_date is
  // itself a Monday or a Sunday.
  week: "date(local_date, '-6 days', 'weekday 1')",
  month: "date(local_date, 'start of month')",
};

// ROUND to six decimals only removes floating-point representation noise
// (AVG was returning 76.35999999999999 instead of 76.36). Six decimals sit far
// beyond any real measurement that lands in here.
const AGGREGATE_SQL: Record<Exclude<Aggregation, 'last'>, string> = {
  sum: 'ROUND(SUM(value_num), 6)',
  avg: 'ROUND(AVG(value_num), 6)',
  count: 'COUNT(*)',
};

/**
 * All aggregation happens inside SQLite; JavaScript only assembles the query
 * and wraps the answer. A bucket with no observations simply never comes out of
 * the GROUP BY, so there are no gaps to fill and no invented zeroes.
 */
export function computeStats(db: Db, query: StatsQuery): StatsResult {
  const series = db
    .prepare('SELECT id, aggregation, unit FROM series WHERE slug = ?')
    .get(query.series) as SeriesRow | undefined;

  if (!series) {
    throw new UnknownSeriesError(`Series '${query.series}' does not exist`);
  }

  const bucketExpr = BUCKET_SQL[query.bucket];
  const filters = ['series_id = @series_id'];
  const params: Record<string, unknown> = { series_id: series.id };

  if (query.from !== undefined) {
    filters.push('local_date >= @from');
    params['from'] = query.from;
  }
  if (query.to !== undefined) {
    filters.push('local_date <= @to');
    params['to'] = query.to;
  }
  const where = filters.join(' AND ');

  // 'last' is not an aggregate function: it is the most recent observation of
  // each bucket. A window function resolves it and keeps the work in SQL.
  const sql =
    series.aggregation === 'last'
      ? `
        SELECT bucket AS date, picked AS value, n AS count
        FROM (
          SELECT
            ${bucketExpr} AS bucket,
            CASE WHEN value_num IS NOT NULL THEN value_num ELSE value_text END AS picked,
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
          ${AGGREGATE_SQL[series.aggregation]} AS value,
          COUNT(*) AS count
        FROM observations
        WHERE ${where}
        GROUP BY date
        ORDER BY date
      `;

  return {
    series: query.series,
    aggregation: series.aggregation,
    unit: series.unit,
    buckets: db.prepare(sql).all(params) as StatsBucket[],
  };
}

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stats', { preHandler: requireSession }, async (request, reply) => {
    const parsed = statsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: formatZodError(parsed.error) });
    }

    try {
      return computeStats(app.db, parsed.data);
    } catch (error) {
      if (error instanceof UnknownSeriesError) {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }
  });
}
