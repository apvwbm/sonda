import { createRequire } from 'node:module';
import { z } from 'zod';
import { isValidTimeZone } from './lib/localdate.ts';

// package.json sits one level above both src/ and dist/, so the version
// reported by GET /api/health has a single source.
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const VERSION = pkg.version;

/**
 * Booleans out of the environment are strings, and z.coerce.boolean() would
 * read 'false' as true. Only the four spellings below are accepted, so a typo
 * stops the server instead of silently meaning the opposite of what was meant.
 */
const booleanEnv = z
  .enum(['true', 'false', '1', '0'], {
    errorMap: () => ({ message: "must be 'true', 'false', '1' or '0'" }),
  })
  .default('false')
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  SONDA_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SONDA_DATA_DIR: z.string().min(1).default('/data'),
  SONDA_TZ: z
    .string()
    .min(1)
    .default('Europe/Madrid')
    .refine(isValidTimeZone, { message: 'is not a valid IANA time zone' }),
  SONDA_PASSWORD: z.string({ required_error: 'is required' }).min(1, 'is required'),
  SONDA_SESSION_SECRET: z.string().min(1).optional(),
  SONDA_PUBLIC_READ: booleanEnv,
  SONDA_PUBLIC_WRITE: booleanEnv,
});

export type Config = z.infer<typeof envSchema>;

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  return result.data;
}
