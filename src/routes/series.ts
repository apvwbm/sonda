import type { FastifyInstance } from 'fastify';
import {
  allowPublicRead,
  allowPublicWrite,
  requireSession,
  requireSessionOrBearer,
} from '../auth/session.ts';
import type { Aggregation, ValueType } from '../lib/schemas.ts';
import {
  createSeriesSchema,
  formatZodError,
  idParamSchema,
  patchSeriesSchema,
} from '../lib/schemas.ts';

export interface SeriesRow {
  id: number;
  slug: string;
  name: string;
  value_type: ValueType;
  unit: string | null;
  aggregation: Aggregation;
  created_at: string;
  archived_at: string | null;
}

const COLUMNS = 'id, slug, name, value_type, unit, aggregation, created_at, archived_at';

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT_UNIQUE')
  );
}

export async function seriesRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;

  const selectAll = db.prepare(`SELECT ${COLUMNS} FROM series ORDER BY slug`);
  const selectById = db.prepare(`SELECT ${COLUMNS} FROM series WHERE id = ?`);
  const insert = db.prepare(
    `INSERT INTO series (slug, name, value_type, unit, aggregation, created_at)
     VALUES (@slug, @name, @value_type, @unit, @aggregation, @created_at)
     RETURNING ${COLUMNS}`,
  );

  // Listing also accepts a bearer token: an ingest script needs to know which
  // slugs exist before it sends anything.
  app.get('/api/series', { preHandler: allowPublicRead(requireSessionOrBearer) }, async () => ({
    series: selectAll.all() as SeriesRow[],
  }));

  app.post(
    '/api/series',
    { preHandler: allowPublicWrite(requireSession) },
    async (request, reply) => {
      const parsed = createSeriesSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: formatZodError(parsed.error) });
      }

      const { slug, name, value_type, aggregation } = parsed.data;

      try {
        const row = insert.get({
          slug,
          name,
          value_type,
          unit: parsed.data.unit ?? null,
          aggregation,
          created_at: new Date().toISOString(),
        }) as SeriesRow;

        return reply.code(201).send(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.code(409).send({ error: `A series with slug '${slug}' already exists` });
        }
        throw error;
      }
    },
  );

  app.patch('/api/series/:id', { preHandler: requireSession }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'id must be a positive integer' });
    }

    const parsed = patchSeriesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: formatZodError(parsed.error) });
    }

    if (Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: 'Nothing to change: expected name, archived_at or both' });
    }

    // Only the columns that actually arrived: sending {name} must not wipe
    // archived_at.
    const sets: string[] = [];
    const values: Record<string, unknown> = { id: params.data.id };

    if (parsed.data.name !== undefined) {
      sets.push('name = @name');
      values['name'] = parsed.data.name;
    }
    if ('archived_at' in parsed.data) {
      sets.push('archived_at = @archived_at');
      values['archived_at'] = parsed.data.archived_at ?? null;
    }

    const row = db
      .prepare(`UPDATE series SET ${sets.join(', ')} WHERE id = @id RETURNING ${COLUMNS}`)
      .get(values) as SeriesRow | undefined;

    if (row) return row;

    // RETURNING gave nothing back, which here can only mean the id is unknown.
    const existing = selectById.get(params.data.id) as SeriesRow | undefined;
    if (!existing) {
      return reply.code(404).send({ error: `Series ${params.data.id} does not exist` });
    }
    return existing;
  });
}
