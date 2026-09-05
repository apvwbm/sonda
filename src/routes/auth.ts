import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LoginBackoff } from '../auth/backoff.ts';
import {
  SESSION_COOKIE,
  createSessionValue,
  passwordMatches,
  requireSession,
  sessionCookieOptions,
} from '../auth/session.ts';

const loginSchema = z.object({
  password: z.string(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const backoff = new LoginBackoff();

  app.post('/api/auth/login', async (request, reply) => {
    const bloqueo = backoff.check(request.ip);
    if (bloqueo.bloqueada) {
      // Se corta antes de mirar la contraseña: si no, el bloqueo no ahorraría
      // nada y seguiría siendo un oráculo.
      request.log.warn({ ip: request.ip, retryAfter: bloqueo.retryAfter }, 'login bloqueado');
      return reply
        .code(429)
        .header('Retry-After', String(bloqueo.retryAfter))
        .send({
          error: `Demasiados intentos fallidos. Reinténtalo en ${bloqueo.retryAfter} s`,
        });
    }

    const parsed = loginSchema.safeParse(request.body);
    // Un cuerpo mal formado cuenta como intento fallido y devuelve lo mismo que
    // una contraseña incorrecta: no debe poder distinguirse.
    const acertada =
      parsed.success && passwordMatches(app.config.SONDA_PASSWORD, parsed.data.password);

    if (!acertada) {
      const tras = backoff.fail(request.ip);
      request.log.warn({ ip: request.ip, bloqueada: tras.bloqueada }, 'intento de login fallido');
      return reply.code(401).send({ error: 'Contraseña incorrecta' });
    }

    backoff.success(request.ip);
    reply.setCookie(SESSION_COOKIE, createSessionValue(app.sessionSecret), sessionCookieOptions);
    return { status: 'ok' };
  });

  app.post('/api/auth/logout', { preHandler: requireSession }, async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: sessionCookieOptions.path });
    return { status: 'ok' };
  });
}
