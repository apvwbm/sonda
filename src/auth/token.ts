import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.ts';

/**
 * Ingest tokens.
 *
 * The table stores only the SHA-256 digest: whoever walks away with the .db
 * does not walk away with the tokens. bcrypt or scrypt would buy nothing here
 * because the token is not human-chosen -- it is 256 bits of randomness, and
 * there is no dictionary to attack.
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

/** Scheme match is case-insensitive, as required by RFC 7235. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer +(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Returns the source bound to the token, or null.
 *
 * Walks every row and compares with timingSafeEqual instead of doing
 * WHERE token_hash = ?. There are a handful of tokens, so the scan is free, and
 * this way the comparison time does not depend on the contents.
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

/** Authenticates and records the use. The resulting source is the only one ingest accepts. */
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
 * Creates or rotates the token for a source and returns the plaintext once.
 * Only the hash is kept, so a lost token cannot be recovered, only rotated.
 */
export function mintToken(db: Db, source: string, rotate = false): MintedToken {
  const token = generateToken();
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM tokens WHERE source = ?').get(source) as
    | { id: number }
    | undefined;

  if (existing && !rotate) {
    throw new Error(
      `A token already exists for source '${source}'. Use --rotate to replace it ` +
        `(the old one stops working)`,
    );
  }

  if (existing) {
    db.prepare(
      'UPDATE tokens SET token_hash = ?, created_at = ?, last_used_at = NULL WHERE id = ?',
    ).run(hashToken(token), now, existing.id);
  } else {
    db.prepare('INSERT INTO tokens (source, token_hash, created_at) VALUES (?, ?, ?)').run(
      source,
      hashToken(token),
      now,
    );
  }

  return { source, token, rotated: existing !== undefined };
}
