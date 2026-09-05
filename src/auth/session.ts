import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import { authenticateBearer } from './token.ts';

/**
 * Interface session: a signed cookie, with no sessions table.
 *
 * The cookie carries its own expiry inside the signature, so a client cannot
 * extend it by ignoring Max-Age. The trade-off is that there is no server-side
 * revocation: logout clears the browser's cookie, and invalidating every
 * session at once means changing SONDA_SESSION_SECRET.
 */

export const SESSION_COOKIE = 'sonda_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const SECRET_FILENAME = 'session-secret';

/** The source attributed to anything ingested with a cookie rather than a token. */
export const SOURCE_MANUAL = 'manual';

/**
 * The source attributed to an unauthenticated write under SONDA_PUBLIC_WRITE.
 *
 * Giving it a source of its own rather than reusing 'manual' keeps anonymous
 * rows identifiable, so a demo instance can sweep them with a single
 * DELETE ... WHERE source = 'public'.
 */
export const SOURCE_PUBLIC = 'public';

export interface RequestAuth {
  kind: 'session' | 'token' | 'public';
  source: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    sessionSecret: string;
  }
  interface FastifyRequest {
    auth?: RequestAuth;
  }
}

/**
 * Returns the signing secret, generating and persisting one when
 * SONDA_SESSION_SECRET is not set.
 *
 * Persisting matters: without it every restart would log everyone out, which is
 * exactly wrong for a self-hosted service that restarts on each image update.
 */
export function resolveSessionSecret(config: Config): string {
  if (config.SONDA_SESSION_SECRET !== undefined) {
    return config.SONDA_SESSION_SECRET;
  }

  const dataDir = resolve(config.SONDA_DATA_DIR);
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, SECRET_FILENAME);

  if (existsSync(path)) {
    const stored = readFileSync(path, 'utf8').trim();
    if (stored !== '') return stored;
  }

  const generated = randomBytes(32).toString('base64url');
  writeFileSync(path, `${generated}\n`, { mode: 0o600 });
  return generated;
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Cookie value: '<expiry in seconds>.<signature>'. */
export function createSessionValue(secret: string, now = Date.now()): string {
  const expiresAt = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  return `${expiresAt}.${sign(secret, String(expiresAt))}`;
}

export function verifySessionValue(
  secret: string,
  value: string | undefined,
  now = Date.now(),
): boolean {
  if (value === undefined) return false;

  const separator = value.indexOf('.');
  if (separator === -1) return false;

  const expiresAt = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!/^\d+$/.test(expiresAt)) return false;

  const expected = Buffer.from(sign(secret, expiresAt), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  if (expected.length !== received.length) return false;
  if (!timingSafeEqual(expected, received)) return false;

  // The expiry is only trusted once the signature over it has been verified.
  return Number(expiresAt) * 1000 > now;
}

/** Hashing first equalises the lengths, so timingSafeEqual never throws. */
export function passwordMatches(expected: string, received: string): boolean {
  const a = createHmac('sha256', 'sonda-password').update(expected).digest();
  const b = createHmac('sha256', 'sonda-password').update(received).digest();
  return timingSafeEqual(a, b);
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  // Secure is deliberately off: this has to work over plain HTTP on a LAN,
  // which is how a self-hosted app gets tried on day one. Exposed to the
  // internet, it sits behind the user's own reverse proxy.
  secure: false,
  maxAge: SESSION_TTL_SECONDS,
} as const;

function hasValidSession(request: FastifyRequest): boolean {
  return verifySessionValue(request.server.sessionSecret, request.cookies[SESSION_COOKIE]);
}

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Who the request is, or undefined. Answers without touching the reply. */
function identify(request: FastifyRequest): RequestAuth | undefined {
  if (hasValidSession(request)) {
    return { kind: 'session', source: SOURCE_MANUAL };
  }

  const identity = authenticateBearer(request.server.db, request.headers.authorization);
  if (identity) {
    return { kind: 'token', source: identity.source };
  }

  return undefined;
}

/**
 * Wraps a preHandler so that, with SONDA_PUBLIC_READ on, the request passes
 * without any credentials.
 *
 * Only the three read endpoints are wrapped. request.auth stays undefined on a
 * public read, which is the truth: nobody was identified, and no read handler
 * looks at it.
 */
export function allowPublicRead(guard: PreHandler): PreHandler {
  return async function publicReadGuard(request, reply) {
    if (request.server.config.SONDA_PUBLIC_READ) return;
    await guard(request, reply);
  };
}

/**
 * Wraps a preHandler so that, with SONDA_PUBLIC_WRITE on, an anonymous request
 * is let through as the 'public' source.
 *
 * Only the two creating endpoints are wrapped. DELETE, PATCH and /api/export
 * keep their guard under every flag, so the worst an anonymous visitor can do
 * is add rows, never remove or rewrite what is already there, and never walk
 * off with the database file.
 *
 * A real credential still wins, so token ingest into a public instance stays
 * attributed to its own source instead of being flattened to 'public'.
 */
export function allowPublicWrite(guard: PreHandler): PreHandler {
  return async function publicWriteGuard(request, reply) {
    if (!request.server.config.SONDA_PUBLIC_WRITE) {
      await guard(request, reply);
      return;
    }
    request.auth = identify(request) ?? { kind: 'public', source: SOURCE_PUBLIC };
  };
}

/** preHandler for everything the endpoint table marks as 'cookie'. */
export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!hasValidSession(request)) {
    await reply.code(401).send({ error: 'Authentication required' });
    return;
  }
  request.auth = { kind: 'session', source: SOURCE_MANUAL };
}

/**
 * preHandler for what the table marks as 'cookie or bearer'.
 *
 * Anything arriving with a cookie is attributed to the 'manual' source: manual
 * capture is just another ingest source, not a separate path.
 */
export async function requireSessionOrBearer(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const identity = identify(request);
  if (identity) {
    request.auth = identity;
    return;
  }

  await reply
    .header('WWW-Authenticate', 'Bearer')
    .code(401)
    .send({ error: 'Authentication required: session cookie or Authorization: Bearer <token>' });
}
