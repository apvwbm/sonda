import type { FastifyInstance } from 'fastify';
import { VERSION } from '../config.ts';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ status: 'ok', version: VERSION }));
}
