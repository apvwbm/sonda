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
    const block = backoff.check(request.ip);
    if (block.blocked) {
      // Bail out before looking at the password. Otherwise the block would save
      // nothing and would still answer as an oracle.
      request.log.warn({ ip: request.ip, retryAfter: block.retryAfter }, 'login blocked');
      return reply
        .code(429)
        .header('Retry-After', String(block.retryAfter))
        .send({ error: `Too many failed attempts. Try again in ${block.retryAfter}s` });
    }

    // A malformed body counts as a failed attempt and answers exactly like a
    // wrong password: the two must not be distinguishable.
    const parsed = loginSchema.safeParse(request.body);
    const correct =
      parsed.success && passwordMatches(app.config.SONDA_PASSWORD, parsed.data.password);

    if (!correct) {
      const after = backoff.fail(request.ip);
      request.log.warn({ ip: request.ip, blocked: after.blocked }, 'failed login attempt');
      return reply.code(401).send({ error: 'Wrong password' });
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
