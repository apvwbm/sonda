import type { FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSessionSecret } from './auth/session.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/index.ts';
import { runMigrations } from './db/migrate.ts';
import { authRoutes } from './routes/auth.ts';
import { exportRoutes } from './routes/export.ts';
import { healthRoutes } from './routes/health.ts';
import { observationsRoutes } from './routes/observations.ts';
import { seriesRoutes } from './routes/series.ts';
import { statsRoutes } from './routes/stats.ts';

async function main(): Promise<void> {
  const config = loadConfig();

  const db = openDatabase(config);
  const migrations = runMigrations(db);

  const app = Fastify({ logger: true });
  app.log.info(
    { schema: migrations.to, applied: migrations.applied },
    migrations.applied.length > 0
      ? `migraciones aplicadas: ${migrations.applied.join(', ')}`
      : 'esquema al día, nada que migrar',
  );

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('sessionSecret', resolveSessionSecret(config));

  await app.register(cookie);

  // Contrato de la sección 4.2: todo error sale como { "error": "mensaje" }.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error(error);
      return reply.code(500).send({ error: 'Error interno' });
    }
    return reply.code(status).send({ error: error.message });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: `No existe ${request.method} ${request.url}` });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(seriesRoutes);
  await app.register(observationsRoutes);
  await app.register(statsRoutes);
  await app.register(exportRoutes);

  // La interfaz compilada, si la hay. Relativo al módulo y no al cwd: vale
  // igual arrancando desde src/ que desde dist/ dentro del contenedor.
  const webDist = join(import.meta.dirname, '..', 'web', 'dist');
  if (existsSync(webDist)) {
    // wildcard: false registra una ruta por fichero en vez de un catch-all, así
    // una ruta /api que no existe sigue devolviendo el 404 en JSON del contrato
    // en lugar de intentar servir un fichero.
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.log.info({ webDist }, 'sirviendo la interfaz desde web/dist');
  } else {
    app.log.info('web/dist no existe: solo API');
  }

  // Node como PID 1 no trae manejo por defecto de SIGTERM, así que sin esto un
  // 'docker stop' esperaría los diez segundos de cortesía y mataría a lo bruto.
  const cierra = (senal: NodeJS.Signals): void => {
    app.log.info({ senal }, 'cerrando');
    app
      .close()
      .then(() => {
        db.close();
        process.exit(0);
      })
      .catch((error: unknown) => {
        app.log.error(error, 'fallo al cerrar');
        process.exit(1);
      });
  };
  for (const senal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(senal, cierra);
  }

  // 0.0.0.0 para que el puerto siga siendo alcanzable dentro de un contenedor.
  await app.listen({ port: config.SONDA_PORT, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
