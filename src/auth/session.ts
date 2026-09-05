import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import { authenticateBearer } from './token.ts';

/**
 * Sesión de la interfaz: cookie firmada, sin tabla de sesiones.
 *
 * La cookie lleva su propia caducidad dentro de la firma, así que un cliente no
 * puede alargarla ignorando el Max-Age. A cambio no hay revocación en servidor:
 * logout borra la cookie del navegador, y para invalidar todas las sesiones de
 * golpe hay que cambiar SONDA_SESSION_SECRET.
 */

export const SESSION_COOKIE = 'sonda_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 días
export const SECRET_FILENAME = 'session-secret';

/** El source que se atribuye a lo que entra con cookie en vez de con token. */
export const SOURCE_MANUAL = 'manual';

export interface RequestAuth {
  kind: 'session' | 'token';
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
 * Devuelve el secreto de firma. Si SONDA_SESSION_SECRET no viene, se genera uno
 * y se guarda en SONDA_DATA_DIR: sin persistirlo, cada reinicio echaría a todo
 * el mundo, que es justo lo que no queremos en un self-hosted que se reinicia
 * con cada actualización de imagen.
 */
export function resolveSessionSecret(config: Config): string {
  if (config.SONDA_SESSION_SECRET !== undefined) {
    return config.SONDA_SESSION_SECRET;
  }

  const dataDir = resolve(config.SONDA_DATA_DIR);
  mkdirSync(dataDir, { recursive: true });
  const ruta = join(dataDir, SECRET_FILENAME);

  if (existsSync(ruta)) {
    const guardado = readFileSync(ruta, 'utf8').trim();
    if (guardado !== '') return guardado;
  }

  const generado = randomBytes(32).toString('base64url');
  writeFileSync(ruta, `${generado}\n`, { mode: 0o600 });
  return generado;
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Valor de la cookie: '<caducidad en segundos>.<firma>'. */
export function createSessionValue(secret: string, now = Date.now()): string {
  const expira = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  return `${expira}.${sign(secret, String(expira))}`;
}

export function verifySessionValue(
  secret: string,
  value: string | undefined,
  now = Date.now(),
): boolean {
  if (value === undefined) return false;

  const corte = value.indexOf('.');
  if (corte === -1) return false;

  const expira = value.slice(0, corte);
  const firma = value.slice(corte + 1);
  if (!/^\d+$/.test(expira)) return false;

  const esperada = Buffer.from(sign(secret, expira), 'utf8');
  const recibida = Buffer.from(firma, 'utf8');
  if (esperada.length !== recibida.length) return false;
  if (!timingSafeEqual(esperada, recibida)) return false;

  // La caducidad va firmada, así que solo se comprueba con la firma ya validada.
  return Number(expira) * 1000 > now;
}

/** Compara contraseñas sin que el tiempo de respuesta delate el prefijo acertado. */
export function passwordMatches(esperada: string, recibida: string): boolean {
  const a = createHmac('sha256', 'sonda-password').update(esperada).digest();
  const b = createHmac('sha256', 'sonda-password').update(recibida).digest();
  return timingSafeEqual(a, b);
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  // Secure a propósito NO: esto tiene que funcionar sobre HTTP plano en la LAN,
  // que es como se prueba una app self-hosted el primer día. Expuesto a
  // internet, va detrás del proxy inverso del usuario.
  secure: false,
  maxAge: SESSION_TTL_SECONDS,
} as const;

function sessionValida(request: FastifyRequest): boolean {
  return verifySessionValue(request.server.sessionSecret, request.cookies[SESSION_COOKIE]);
}

function rechaza(reply: FastifyReply, mensaje: string): FastifyReply {
  return reply.code(401).send({ error: mensaje });
}

/** preHandler para lo que la tabla 4.2 marca como 'cookie'. */
export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!sessionValida(request)) {
    await rechaza(reply, 'Hace falta iniciar sesión');
    return;
  }
  request.auth = { kind: 'session', source: SOURCE_MANUAL };
}

/**
 * preHandler para lo que la tabla marca como 'cookie o bearer'. Lo que entra con
 * cookie se atribuye al source 'manual': la captura manual es una fuente de
 * ingesta más, no una rama aparte.
 */
export async function requireSessionOrBearer(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (sessionValida(request)) {
    request.auth = { kind: 'session', source: SOURCE_MANUAL };
    return;
  }

  const identity = authenticateBearer(request.server.db, request.headers.authorization);
  if (identity) {
    request.auth = { kind: 'token', source: identity.source };
    return;
  }

  await reply
    .header('WWW-Authenticate', 'Bearer')
    .code(401)
    .send({ error: 'Hace falta iniciar sesión o una cabecera Authorization: Bearer <token>' });
}
