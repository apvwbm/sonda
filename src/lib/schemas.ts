import { z } from 'zod';
import { isIsoInstant, isLocalDate } from './localdate.ts';

// Espejo de los CHECK de 001_init.sql. Si aquí y allí divergen, el fallo sale
// como error 500 de SQLite en vez de como un 400 legible.
export const VALUE_TYPES = ['bool', 'number', 'duration', 'text'] as const;
export const AGGREGATIONS = ['sum', 'avg', 'last', 'count'] as const;

export type ValueType = (typeof VALUE_TYPES)[number];
export type Aggregation = (typeof AGGREGATIONS)[number];

const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "solo minúsculas, dígitos y guiones interiores (p. ej. 'peso' o 'horas-sueno')",
  );

const instant = z
  .string()
  .refine(isIsoInstant, { message: "instante ISO 8601 con zona, p. ej. '2026-09-05T08:12:00Z'" });

/**
 * Qué agregaciones tienen sentido para cada tipo. Los CHECK de 001_init.sql
 * validan cada columna por separado y no pueden expresar esto, así que la
 * combinación se valida aquí: 'sum' sobre texto devolvería null en todos los
 * buckets de /api/stats, y una serie así solo se descubre rota al consultarla.
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
  .superRefine((serie, ctx) => {
    const permitidas = AGGREGATIONS_BY_VALUE_TYPE[serie.value_type];
    if (!permitidas.includes(serie.aggregation)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aggregation'],
        message:
          `'${serie.aggregation}' no vale para una serie de tipo ` +
          `'${serie.value_type}'; usa ${permitidas.map((a) => `'${a}'`).join(', ')}`,
      });
    }
  });

export type CreateSeriesInput = z.infer<typeof createSeriesSchema>;

/**
 * PATCH solo toca name y archived_at. El slug y el value_type quedan fuera a
 * propósito: cambiarlos reinterpretaría las observaciones ya guardadas, que se
 * escribieron con el tipo antiguo. strict() hace que intentarlo dé un 400 en vez
 * de ignorarse en silencio.
 */
export const patchSeriesSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    archived_at: instant.nullable().optional(),
  })
  .strict(
    'solo se pueden cambiar name y archived_at; el slug y el value_type son ' +
      'inmutables porque reinterpretarían las observaciones ya guardadas',
  );

export type PatchSeriesInput = z.infer<typeof patchSeriesSchema>;

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/** Aplana los errores de zod a la línea única que devuelve la API. */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const campo = issue.path.join('.');
      return campo === '' ? issue.message : `${campo}: ${issue.message}`;
    })
    .join('; ');
}

export const MAX_BATCH = 1000;

/**
 * Una observación del lote de ingesta.
 *
 * No lleva .strict() a propósito: 'local_date' y 'source' que lleguen en el
 * payload se descartan sin ruido. local_date lo calcula el servidor con
 * SONDA_TZ, y el source sale del token, nunca del cuerpo.
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
    .max(MAX_BATCH, `el lote no puede pasar de ${MAX_BATCH} observaciones`),
});

export const sourceSchema = slug;

export const BUCKETS = ['day', 'week', 'month'] as const;
export type Bucket = (typeof BUCKETS)[number];

/** 'YYYY-MM-DD', el mismo formato que la columna local_date. */
const localDate = z
  .string()
  .refine(isLocalDate, { message: "fecha local 'YYYY-MM-DD', p. ej. '2026-09-05'" });

export const MAX_PAGE = 1000;
export const DEFAULT_PAGE = 200;

export const listObservationsQuerySchema = z
  .object({
    series: slug.optional(),
    from: localDate.optional(),
    to: localDate.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE),
    cursor: z.string().min(1).optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: "'from' no puede ser posterior a 'to'",
  });

export const statsQuerySchema = z
  .object({
    series: slug,
    bucket: z.enum(BUCKETS),
    from: localDate.optional(),
    to: localDate.optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: "'from' no puede ser posterior a 'to'",
  });
