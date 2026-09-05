import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  FREE_ATTEMPTS,
  FORGET_AFTER_MS,
  LoginBackoff,
  MAX_DELAY_MS,
} from '../src/auth/backoff.ts';
import {
  SECRET_FILENAME,
  SESSION_TTL_SECONDS,
  createSessionValue,
  passwordMatches,
  resolveSessionSecret,
  sessionCookieOptions,
  verifySessionValue,
} from '../src/auth/session.ts';
import type { Config } from '../src/config.ts';

const SECRET = 'test-secret';
const NOW = Date.parse('2026-09-05T12:00:00Z');

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sonda-session-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const config = (extra: Partial<Config>): Config =>
  ({
    SONDA_PORT: 8080,
    SONDA_DATA_DIR: '/data',
    SONDA_TZ: 'Europe/Madrid',
    SONDA_PASSWORD: 'x',
    ...extra,
  }) as Config;

describe('session cookie signature', () => {
  it('a freshly issued cookie verifies', () => {
    const value = createSessionValue(SECRET, NOW);
    assert.equal(verifySessionValue(SECRET, value, NOW), true);
  });

  it('does not verify under another secret, so rotating it ends every session', () => {
    const value = createSessionValue(SECRET, NOW);
    assert.equal(verifySessionValue('another-secret', value, NOW), false);
  });

  it('rejects a tampered signature', () => {
    const value = createSessionValue(SECRET, NOW);
    const [expiry, signature] = value.split('.') as [string, string];

    assert.equal(verifySessionValue(SECRET, `${expiry}.${signature}x`, NOW), false);
    assert.equal(verifySessionValue(SECRET, `${expiry}.`, NOW), false);
    assert.equal(verifySessionValue(SECRET, `${expiry}.AAAA`, NOW), false);
  });

  it('rejects an extended expiry, because it is covered by the signature', () => {
    const value = createSessionValue(SECRET, NOW);
    const signature = value.slice(value.indexOf('.') + 1);
    const aCenturyAway = Math.floor(NOW / 1000) + 100 * 365 * 24 * 3600;

    assert.equal(verifySessionValue(SECRET, `${aCenturyAway}.${signature}`, NOW), false);
  });

  it('expires on its own', () => {
    const value = createSessionValue(SECRET, NOW);

    assert.equal(verifySessionValue(SECRET, value, NOW + (SESSION_TTL_SECONDS - 60) * 1000), true);
    assert.equal(verifySessionValue(SECRET, value, NOW + (SESSION_TTL_SECONDS + 60) * 1000), false);
  });

  it('rejects garbage and a missing cookie', () => {
    for (const bad of [undefined, '', '.', 'abc', 'abc.def', '12x3.abc', `${NOW}`]) {
      assert.equal(verifySessionValue(SECRET, bad, NOW), false, JSON.stringify(bad));
    }
  });
});

describe('cookie options', () => {
  it('HttpOnly and SameSite=Lax, with Secure deliberately off', () => {
    // Secure would break trying the app over plain HTTP on a LAN, which is the
    // first contact anyone has with it.
    assert.equal(sessionCookieOptions.httpOnly, true);
    assert.equal(sessionCookieOptions.sameSite, 'lax');
    assert.equal(sessionCookieOptions.secure, false);
    assert.equal(sessionCookieOptions.path, '/');
  });
});

describe('password comparison', () => {
  it('accepts the right one and rejects the rest', () => {
    assert.equal(passwordMatches('correct', 'correct'), true);
    assert.equal(passwordMatches('correct', 'Correct'), false);
    assert.equal(passwordMatches('correct', 'correc'), false);
    assert.equal(passwordMatches('correct', ''), false);
  });

  it('does not blow up on differing lengths', () => {
    // Hashing first equalises the lengths; without it timingSafeEqual throws.
    assert.equal(passwordMatches('short', 'a'.repeat(5000)), false);
  });
});

describe('session secret', () => {
  it('uses SONDA_SESSION_SECRET when set and writes nothing', () => {
    const dir = tempDir();
    const secret = resolveSessionSecret(
      config({ SONDA_DATA_DIR: dir, SONDA_SESSION_SECRET: 'from-the-environment' }),
    );

    assert.equal(secret, 'from-the-environment');
    assert.throws(() => readFileSync(join(dir, SECRET_FILENAME), 'utf8'));
  });

  it('generates and stores one in SONDA_DATA_DIR when unset', () => {
    const dir = tempDir();
    const secret = resolveSessionSecret(config({ SONDA_DATA_DIR: dir }));

    assert.ok(secret.length >= 32);
    assert.equal(readFileSync(join(dir, SECRET_FILENAME), 'utf8').trim(), secret);
  });

  it('reuses it on the next start, so sessions survive a restart', () => {
    const dir = tempDir();
    const first = resolveSessionSecret(config({ SONDA_DATA_DIR: dir }));
    const second = resolveSessionSecret(config({ SONDA_DATA_DIR: dir }));

    assert.equal(first, second);
    assert.equal(verifySessionValue(second, createSessionValue(first, NOW), NOW), true);
  });

  it('creates the directory when it does not exist', () => {
    const dir = join(tempDir(), 'not', 'created');
    const secret = resolveSessionSecret(config({ SONDA_DATA_DIR: dir }));

    assert.equal(readFileSync(join(dir, SECRET_FILENAME), 'utf8').trim(), secret);
  });
});

describe('login backoff', () => {
  const IP = '192.168.1.50';

  it('the first few failures do not block, because mistyping is normal', () => {
    const backoff = new LoginBackoff();

    for (let n = 1; n <= FREE_ATTEMPTS; n += 1) {
      assert.equal(backoff.fail(IP, NOW).blocked, false, `failure ${n}`);
    }
    assert.equal(backoff.check(IP, NOW).blocked, false);
  });

  it('the fifth failure blocks', () => {
    const backoff = new LoginBackoff();

    for (let n = 1; n < 5; n += 1) backoff.fail(IP, NOW);
    const after = backoff.fail(IP, NOW);

    assert.equal(after.blocked, true);
    assert.equal(after.retryAfter, 1);
  });

  it('the wait doubles with each further failure', () => {
    const backoff = new LoginBackoff();
    let now = NOW;

    for (let n = 1; n < 5; n += 1) backoff.fail(IP, now);

    const waits: number[] = [];
    for (let n = 0; n < 5; n += 1) {
      const after = backoff.fail(IP, now);
      waits.push(after.retryAfter);
      // Let the block lapse so the next attempt can be spent.
      now += after.retryAfter * 1000;
    }

    assert.deepEqual(waits, [1, 2, 4, 8, 16]);
  });

  it('the wait is capped', () => {
    const backoff = new LoginBackoff();
    let now = NOW;
    let last = 0;

    for (let n = 0; n < 40; n += 1) {
      const after = backoff.fail(IP, now);
      last = after.retryAfter;
      now += after.retryAfter * 1000;
    }

    assert.equal(last, MAX_DELAY_MS / 1000);
  });

  it('the block lapses on its own', () => {
    const backoff = new LoginBackoff();
    for (let n = 1; n <= 5; n += 1) backoff.fail(IP, NOW);

    assert.equal(backoff.check(IP, NOW + 500).blocked, true);
    assert.equal(backoff.check(IP, NOW + 1_500).blocked, false);
  });

  it('a success clears the history', () => {
    const backoff = new LoginBackoff();
    for (let n = 1; n <= 5; n += 1) backoff.fail(IP, NOW);
    assert.equal(backoff.check(IP, NOW).blocked, true);

    backoff.success(IP);

    assert.equal(backoff.check(IP, NOW).blocked, false);
    assert.equal(backoff.fail(IP, NOW).blocked, false);
  });

  it('blocks per IP, not everybody', () => {
    const backoff = new LoginBackoff();
    for (let n = 1; n <= 5; n += 1) backoff.fail(IP, NOW);

    assert.equal(backoff.check(IP, NOW).blocked, true);
    assert.equal(backoff.check('10.0.0.9', NOW).blocked, false);
  });

  it('forgets idle IPs so the map does not grow without bound', () => {
    const backoff = new LoginBackoff();
    for (let i = 0; i < 50; i += 1) backoff.fail(`10.0.0.${i}`, NOW);
    assert.equal(backoff.size, 50);

    backoff.check('someone-else', NOW + FORGET_AFTER_MS + 1);
    assert.equal(backoff.size, 0);
  });
});
