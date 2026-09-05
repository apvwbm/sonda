import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { FastifyError } from 'fastify';
import Fastify from 'fastify';
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
      ? `migrations applied: ${migrations.applied.join(', ')}`
      : 'schema up to date, nothing to migrate',
  );

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('sessionSecret', resolveSessionSecret(config));

  await app.register(cookie);

  // Every error leaves as { "error": "message" }, per the API contract.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error(error);
      return reply.code(500).send({ error: 'Internal error' });
    }
    return reply.code(status).send({ error: error.message });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: `No route for ${request.method} ${request.url}` });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(seriesRoutes);
  await app.register(observationsRoutes);
  await app.register(statsRoutes);
  await app.register(exportRoutes);

  // Resolved against the module rather than the cwd, so it works the same
  // started from src/ or from dist/ inside the container.
  const webDist = join(import.meta.dirname, '..', 'web', 'dist');
  if (existsSync(webDist)) {
    // wildcard: false registers one route per file instead of a catch-all, so
    // an unknown /api path still returns the contract's JSON 404 rather than
    // being swallowed by an attempt to serve a file.
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.log.info({ webDist }, 'serving the web interface from web/dist');
  } else {
    app.log.info('no web/dist directory: API only');
  }

  // Node as PID 1 gets no default SIGTERM handling, so without this a
  // `docker stop` would wait out the ten-second grace period and then kill.
  const shutdown = (signal: NodeJS.Signals): void => {
    app.log.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => {
        db.close();
        process.exit(0);
      })
      .catch((error: unknown) => {
        app.log.error(error, 'failed to shut down cleanly');
        process.exit(1);
      });
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, shutdown);
  }

  // Loud on purpose, and the last thing before the listening line: an instance
  // left open by accident should be obvious in the first screen of logs.
  if (config.SONDA_PUBLIC_READ || config.SONDA_PUBLIC_WRITE) {
    const rule = '='.repeat(78);
    const lines = [rule];

    if (config.SONDA_PUBLIC_READ) {
      lines.push(
        'SONDA_PUBLIC_READ IS ON. Anyone who can reach this port can read the data.',
        '  open: GET /api/series, GET /api/observations, GET /api/stats',
      );
    }
    if (config.SONDA_PUBLIC_WRITE) {
      lines.push(
        'SONDA_PUBLIC_WRITE IS ON. Anyone who can reach this port can add data.',
        "  open: POST /api/series, POST /api/observations (stored as source 'public')",
      );
    }

    lines.push(
      'Always authenticated: PATCH, DELETE and GET /api/export.',
      'These flags are for throwaway demo instances. Never where the data is real.',
      rule,
    );

    for (const line of lines) app.log.warn(line);
  }

  // 0.0.0.0 so the port stays reachable from outside a container.
  await app.listen({ port: config.SONDA_PORT, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
