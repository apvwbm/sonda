import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
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
  /**
   * Spanish on purpose: this field name is part of the agreed API contract and
   * renaming it would break every ingest script already written against it.
   */
  series_desconocidas: string[];
}

/** Bad client data: aborts the whole batch with a 400. */
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
 * The payload carries a single 'value' while the table has value_num and
 * value_text. Which column gets filled is decided by the series' value_type,
 * never by the client.
 */
function toStoredValue(
  value: ObservationInput['value'],
  series: SeriesLookup,
  index: number,
): StoredValue {
  const reject = (expected: string): never => {
    throw new IngestValidationError(
      `observations[${index}]: series '${series.slug}' is of type ` +
        `'${series.value_type}' and expects ${expected}, got ${JSON.stringify(value)}`,
    );
  };

  switch (series.value_type) {
    case 'bool':
      if (typeof value === 'boolean') return { value_num: value ? 1 : 0, value_text: null };
      if (value === 0 || value === 1) return { value_num: value, value_text: null };
      return reject('true, false, 0 or 1');

    case 'number':
      if (typeof value === 'number') return { value_num: value, value_text: null };
      return reject('a number');

    case 'duration':
      // The column stores seconds, and a negative duration does not exist.
      if (typeof value === 'number' && value >= 0) return { value_num: value, value_text: null };
      return reject('a non-negative number of seconds');

    case 'text':
      if (typeof value === 'string') return { value_num: null, value_text: value };
      return reject('a string');
  }
}

/**
 * Idempotent ingest.
 *
 * The whole batch runs in one transaction: it either lands complete or not at
 * all. The single non-fatal exception is an unknown series, which is reported
 * back and lets the rest through.
 */
export function ingestObservations(
  db: Db,
  input: { source: string; timeZone: string; observations: ObservationInput[] },
): IngestResult {
  const series = db.prepare('SELECT id, slug, value_type FROM series').all() as SeriesLookup[];
  const bySlug = new Map(series.map((s) => [s.slug, s]));

  const exists = db.prepare('SELECT 1 FROM observations WHERE source = ? AND external_id = ?');

  // created_at is written on insert only: correcting a value must not rewrite
  // when the data point was first recorded.
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

  const unknown = new Set<string>();
  let inserted = 0;
  let updated = 0;

  db.transaction(() => {
    const now = new Date().toISOString();

    input.observations.forEach((observation, index) => {
      const target = bySlug.get(observation.series);
      if (!target) {
        unknown.add(observation.series);
        return;
      }

      const { value_num, value_text } = toStoredValue(observation.value, target, index);
      const externalId = observation.external_id ?? randomUUID();

      // Inside the transaction, so a duplicate within the batch itself also
      // counts as an update rather than a second row.
      const existed = exists.get(input.source, externalId) !== undefined;

      upsert.run({
        series_id: target.id,
        occurred_at: observation.occurred_at,
        local_date: toLocalDate(observation.occurred_at, input.timeZone),
        value_num,
        value_text,
        source: input.source,
        external_id: externalId,
        created_at: now,
      });

      if (existed) updated += 1;
      else inserted += 1;
    });
  })();

  return { inserted, updated, series_desconocidas: [...unknown].sort() };
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
 * Cursor pagination rather than OFFSET: with OFFSET, a row inserted while
 * paginating shifts every later page and rows get repeated or skipped. The
 * cursor is the last position read in the (occurred_at, id) order, which is
 * total and stable.
 */
function encodeCursor(row: ObservationRow): string {
  return Buffer.from(`${row.occurred_at}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { occurred_at: string; id: number } | null {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = text.lastIndexOf('|');
  if (separator === -1) return null;

  const occurred_at = text.slice(0, separator);
  const id = Number(text.slice(separator + 1));
  if (occurred_at === '' || !Number.isInteger(id)) return null;

  return { occurred_at, id };
}

export async function observationsRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;

  app.post('/api/observations', { preHandler: requireSessionOrBearer }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) {
      // Unreachable while the preHandler is in place. If it ever falls off the
      // route, fail closed instead of inserting with an undefined source.
      return reply.code(401).send({ error: 'Authentication required' });
    }

    const parsed = ingestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: formatZodError(parsed.error) });
    }

    try {
      return ingestObservations(db, {
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

    const filters: string[] = [];
    // One extra row is requested purely to find out whether a next page exists.
    const params: Record<string, unknown> = { limit: limit + 1 };

    if (series !== undefined) {
      const target = db.prepare('SELECT id FROM series WHERE slug = ?').get(series) as
        | { id: number }
        | undefined;
      if (!target) {
        return reply.code(404).send({ error: `Series '${series}' does not exist` });
      }
      filters.push('o.series_id = @series_id');
      params['series_id'] = target.id;
    }

    // from and to filter on local_date, exactly like /api/stats: asking for
    // 'the 1st to the 5th of September' is a question about local days.
    if (from !== undefined) {
      filters.push('o.local_date >= @from');
      params['from'] = from;
    }
    if (to !== undefined) {
      filters.push('o.local_date <= @to');
      params['to'] = to;
    }

    if (cursor !== undefined) {
      const position = decodeCursor(cursor);
      if (!position) {
        return reply.code(400).send({ error: 'Invalid cursor' });
      }
      // Row-value comparison, matching the descending (occurred_at, id) order.
      filters.push('(o.occurred_at, o.id) < (@cursor_at, @cursor_id)');
      params['cursor_at'] = position.occurred_at;
      params['cursor_id'] = position.id;
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const rows = db
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

    const hasMore = rows.length > limit;
    const observations = hasMore ? rows.slice(0, limit) : rows;
    const last = observations.at(-1);

    return {
      observations,
      next_cursor: hasMore && last ? encodeCursor(last) : null,
    };
  });

  app.delete('/api/observations/:id', { preHandler: requireSession }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'id must be a positive integer' });
    }

    const deleted = db.prepare('DELETE FROM observations WHERE id = ?').run(params.data.id);
    if (deleted.changes === 0) {
      return reply.code(404).send({ error: `Observation ${params.data.id} does not exist` });
    }

    return { deleted: params.data.id };
  });
}
