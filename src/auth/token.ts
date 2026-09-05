import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.ts';

/**
 * Tokens de ingesta. La tabla guarda solo el SHA-256: si alguien se lleva el
 * .db no se lleva los tokens. No hace falta bcrypt ni scrypt porque el token no
 * lo elige un humano, son 256 bits de aleatoriedad y no hay diccionario que
 * atacar.
 */

export interface TokenIdentity {
  id: number;
  source: string;
}

interface TokenRow {
  id: number;
  source: string;
  token_hash: string;
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Extrae el token de 'Authorization: Bearer xxx'. Esquema sin distinguir mayúsculas. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer +(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Devuelve el source atado al token, o null. Recorre todas las filas y compara
 * con timingSafeEqual en vez de hacer WHERE token_hash = ?: son cuatro tokens y
 * así la comparación no depende del contenido.
 */
export function findTokenIdentity(db: Db, token: string): TokenIdentity | null {
  const presented = Buffer.from(hashToken(token), 'hex');
  const rows = db.prepare('SELECT id, source, token_hash FROM tokens').all() as TokenRow[];

  let match: TokenIdentity | null = null;
  for (const row of rows) {
    const stored = Buffer.from(row.token_hash, 'hex');
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
      match = { id: row.id, source: row.source };
    }
  }

  return match;
}

export function touchToken(db: Db, id: number, when = new Date().toISOString()): void {
  db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(when, id);
}

/** Autentica y marca el uso. El source resultante es el único que la ingesta acepta. */
export function authenticateBearer(db: Db, header: string | undefined): TokenIdentity | null {
  const token = parseBearer(header);
  if (!token) return null;

  const identity = findTokenIdentity(db, token);
  if (!identity) return null;

  touchToken(db, identity.id);
  return identity;
}

export interface MintedToken {
  source: string;
  token: string;
  rotated: boolean;
}

/**
 * Crea (o rota) el token de un source y devuelve el texto plano una única vez:
 * en la base solo queda el hash, así que si se pierde hay que rotarlo.
 */
export function mintToken(db: Db, source: string, rotate = false): MintedToken {
  const token = generateToken();
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM tokens WHERE source = ?').get(source) as
    | { id: number }
    | undefined;

  if (existing && !rotate) {
    throw new Error(
      `Ya hay un token para el source '${source}'. Usa --rotate para reemplazarlo ` +
        `(el anterior dejará de funcionar)`,
    );
  }

  if (existing) {
    db.prepare(
      'UPDATE tokens SET token_hash = ?, created_at = ?, last_used_at = NULL WHERE id = ?',
    ).run(hashToken(token), now, existing.id);
  } else {
    db.prepare(
      'INSERT INTO tokens (source, token_hash, created_at) VALUES (?, ?, ?)',
    ).run(source, hashToken(token), now);
  }

  return { source, token, rotated: existing !== undefined };
}
