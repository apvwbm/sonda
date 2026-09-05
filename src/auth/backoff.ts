/**
 * Brute-force brake for POST /api/auth/login.
 *
 * In memory and per IP, with no dependency and no table: restarting clears it,
 * which is acceptable because the goal is not to be a WAF. It is to turn blind
 * password guessing against an exposed instance from thousands per minute into
 * a handful per hour.
 *
 * The first few failures are free because mistyping a password is normal.
 */

export const FREE_ATTEMPTS = 4;
export const BASE_DELAY_MS = 1_000;
export const MAX_DELAY_MS = 5 * 60 * 1_000;
/** An entry idle for longer than this is forgotten. */
export const FORGET_AFTER_MS = 60 * 60 * 1_000;

interface Attempts {
  failures: number;
  blockedUntil: number;
  lastSeen: number;
}

export interface BlockState {
  blocked: boolean;
  /** Seconds left, rounded up. Zero when not blocked. */
  retryAfter: number;
}

const NOT_BLOCKED: BlockState = { blocked: false, retryAfter: 0 };

function delayAfter(failures: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** (failures - FREE_ATTEMPTS - 1), MAX_DELAY_MS);
}

export class LoginBackoff {
  readonly #byIp = new Map<string, Attempts>();

  /** Number of IPs currently remembered. Used by the tests. */
  get size(): number {
    return this.#byIp.size;
  }

  #prune(now: number): void {
    for (const [ip, attempts] of this.#byIp) {
      if (now - attempts.lastSeen > FORGET_AFTER_MS) this.#byIp.delete(ip);
    }
  }

  /** Called before checking the password. */
  check(ip: string, now = Date.now()): BlockState {
    this.#prune(now);

    const attempts = this.#byIp.get(ip);
    if (!attempts || attempts.blockedUntil <= now) return NOT_BLOCKED;

    return { blocked: true, retryAfter: Math.ceil((attempts.blockedUntil - now) / 1000) };
  }

  /** Records a failed attempt and returns the resulting block. */
  fail(ip: string, now = Date.now()): BlockState {
    const attempts = this.#byIp.get(ip) ?? { failures: 0, blockedUntil: 0, lastSeen: now };
    attempts.failures += 1;
    attempts.lastSeen = now;

    if (attempts.failures > FREE_ATTEMPTS) {
      attempts.blockedUntil = now + delayAfter(attempts.failures);
    }

    this.#byIp.set(ip, attempts);
    return this.check(ip, now);
  }

  /** A successful login clears that IP's history. */
  success(ip: string): void {
    this.#byIp.delete(ip);
  }
}
