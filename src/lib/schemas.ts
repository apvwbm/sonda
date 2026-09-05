import { z } from 'zod';
import { isIsoInstant, isLocalDate } from './localdate.ts';

// Mirrors the CHECK constraints in 001_init.sql. When the two drift apart the
// failure surfaces as a SQLite 500 instead of a readable 400.
export const VALUE_TYPES = ['bool', 'number', 'duration', 'text'] as const;
export const AGGREGATIONS = ['sum', 'avg', 'last', 'count'] as const;

export type ValueType = (typeof VALUE_TYPES)[number];
export type Aggregation = (typeof AGGREGATIONS)[number];

export const MAX_BATCH = 1000;
export const MAX_PAGE = 1000;
export const DEFAULT_PAGE = 200;

export const BUCKETS = ['day', 'week', 'month'] as const;
export type Bucket = (typeof BUCKETS)[number];

const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "must be lowercase letters, digits and inner hyphens (e.g. 'weight' or 'sleep-hours')",
  );

const instant = z
  .string()
  .refine(isIsoInstant, { message: "must be an ISO 8601 instant, e.g. '2026-09-05T08:12:00Z'" });

/** 'YYYY-MM-DD', the same shape as the local_date column. */
const localDate = z
  .string()
  .refine(isLocalDate, { message: "must be a local date 'YYYY-MM-DD', e.g. '2026-09-05'" });

export const sourceSchema = slug;

/**
 * Which aggregations make sense for each value type.
 *
 * The CHECK constraints validate each column on its own and cannot express
 * this, so the combination is validated here: 'sum' over a text series would
 * return null in every bucket of /api/stats, and a series like that is only
 * discovered to be broken when someone queries it.
 */
export const AGGREGATIONS_BY_VALUE_TYPE: Record<ValueType, readonly Aggregation[]> = {
  bool: ['sum', 'count', 'last'],
  number: ['sum', 'avg', 'last', 'count'],
  duration: ['sum', 'avg', 'last', 'count'],
  text: ['count', 'last'],
};

export const createSeriesSchema = z
  .object({
    slug,
    name: z.string().trim().min(1).max(200),
    value_type: z.enum(VALUE_TYPES),
    unit: z.string().trim().min(1).max(32).nullish(),
    aggregation: z.enum(AGGREGATIONS),
  })
  .strict()
  .superRefine((series, ctx) => {
    const allowed = AGGREGATIONS_BY_VALUE_TYPE[series.value_type];
    if (!allowed.includes(series.aggregation)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aggregation'],
        message:
          `'${series.aggregation}' is not valid for a '${series.value_type}' series; ` +
          `use ${allowed.map((a) => `'${a}'`).join(', ')}`,
      });
    }
  });

/**
 * PATCH only touches name and archived_at.
 *
 * slug, value_type and unit are left out on purpose: changing any of them
 * reinterprets observations that were already stored under the old meaning.
 * strict() turns an attempt into a 400 instead of a silent no-op.
 */
export const patchSeriesSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    archived_at: instant.nullable().optional(),
  })
  .strict(
    'only name and archived_at can be changed; slug, value_type and unit are ' +
      'immutable because they would reinterpret observations already stored',
  );

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * One observation in an ingest batch.
 *
 * Deliberately not strict(): a 'local_date' or 'source' arriving in the payload
 * is dropped without complaint. local_date is computed by the server from
 * SONDA_TZ, and source comes from the token, never from the body.
 */
export const observationSchema = z.object({
  series: slug,
  occurred_at: instant,
  value: z.union([z.number().finite(), z.boolean(), z.string()]),
  external_id: z.string().trim().min(1).max(200).optional(),
});

export type ObservationInput = z.infer<typeof observationSchema>;

export const ingestSchema = z.object({
  observations: z
    .array(observationSchema)
    .max(MAX_BATCH, `a batch cannot exceed ${MAX_BATCH} observations`),
});

export const listObservationsQuerySchema = z
  .object({
    series: slug.optional(),
    from: localDate.optional(),
    to: localDate.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE),
    cursor: z.string().min(1).optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: "'from' cannot be later than 'to'",
  });

export const statsQuerySchema = z
  .object({
    series: slug,
    bucket: z.enum(BUCKETS),
    from: localDate.optional(),
    to: localDate.optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: "'from' cannot be later than 'to'",
  });

/** Flattens zod issues into the single line the API returns. */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.join('.');
      return field === '' ? issue.message : `${field}: ${issue.message}`;
    })
    .join('; ');
}
