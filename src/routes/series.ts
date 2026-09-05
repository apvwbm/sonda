import type { FastifyInstance } from 'fastify';
import { requireSession, requireSessionOrBearer } from '../auth/session.ts';
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

const COLUMNS =
  'id, slug, name, value_type, unit, aggregation, created_at, archived_at';

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

  // Auth según la tabla 4.2: el listado también con bearer, porque un script de
  // ingesta necesita saber qué slugs existen antes de mandar nada.
  app.get(
    '/api/series',
    { preHandler: requireSessionOrBearer },
    async () => ({ series: selectAll.all() as SeriesRow[] }),
  );

  app.post('/api/series', { preHandler: requireSession }, async (request, reply) => {
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
        return reply.code(409).send({ error: `Ya existe una serie con slug '${slug}'` });
      }
      throw error;
    }
  });

  app.patch('/api/series/:id', { preHandler: requireSession }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'El id debe ser un entero positivo' });
    }

    const parsed = patchSeriesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: formatZodError(parsed.error) });
    }

    if (Object.keys(parsed.data).length === 0) {
      return reply
        .code(400)
        .send({ error: 'No hay nada que cambiar: se espera name, archived_at o ambos' });
    }

    // Solo las columnas que vinieron: mandar {name} no debe borrar archived_at.
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

    if (!row) {
      // El UPDATE no tocó nada: o no existe el id, o no había nada que cambiar.
      const existe = selectById.get(params.data.id) as SeriesRow | undefined;
      if (!existe) {
        return reply.code(404).send({ error: `No existe la serie ${params.data.id}` });
      }
      return existe;
    }

    return row;
  });
}
