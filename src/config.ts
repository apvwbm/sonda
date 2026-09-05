import { createRequire } from 'node:module';
import { z } from 'zod';
import { isValidTimeZone } from './lib/localdate.ts';

// package.json queda un nivel por encima tanto de src/ como de dist/,
// así que la version del contrato de /api/health tiene una sola fuente.
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const VERSION = pkg.version;

const envSchema = z.object({
  SONDA_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SONDA_DATA_DIR: z.string().min(1).default('/data'),
  SONDA_TZ: z
    .string()
    .min(1)
    .default('Europe/Madrid')
    .refine(isValidTimeZone, { message: 'no es una zona horaria IANA válida' }),
  SONDA_PASSWORD: z
    .string({ required_error: 'es obligatoria' })
    .min(1, 'es obligatoria'),
  SONDA_SESSION_SECRET: z.string().min(1).optional(),
});

export type Config = z.infer<typeof envSchema>;

// Las rutas leen SONDA_TZ y compañía por app.config.
declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuración de entorno inválida:\n${detail}`);
  }

  return result.data;
}
