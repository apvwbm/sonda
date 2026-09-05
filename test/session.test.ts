import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  ESPERA_MAXIMA_MS,
  FALLOS_GRATIS,
  LoginBackoff,
  OLVIDO_MS,
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

const SECRETO = 'secreto-de-pruebas';
const AHORA = Date.parse('2026-09-05T12:00:00Z');

const temporales: string[] = [];
function dirTemporal(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sonda-sesion-'));
  temporales.push(dir);
  return dir;
}

after(() => {
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true });
});

const config = (extra: Partial<Config>): Config =>
  ({
    SONDA_PORT: 8080,
    SONDA_DATA_DIR: '/data',
    SONDA_TZ: 'Europe/Madrid',
    SONDA_PASSWORD: 'x',
    ...extra,
  }) as Config;

describe('firma de la cookie de sesión', () => {
  it('una cookie recién emitida vale', () => {
    const valor = createSessionValue(SECRETO, AHORA);
    assert.equal(verifySessionValue(SECRETO, valor, AHORA), true);
  });

  it('no vale con otro secreto: cambiarlo cierra todas las sesiones', () => {
    const valor = createSessionValue(SECRETO, AHORA);
    assert.equal(verifySessionValue('otro-secreto', valor, AHORA), false);
  });

  it('rechaza una firma manipulada', () => {
    const valor = createSessionValue(SECRETO, AHORA);
    const [caducidad, firma] = valor.split('.') as [string, string];

    assert.equal(verifySessionValue(SECRETO, `${caducidad}.${firma}x`, AHORA), false);
    assert.equal(verifySessionValue(SECRETO, `${caducidad}.`, AHORA), false);
    assert.equal(verifySessionValue(SECRETO, `${caducidad}.AAAA`, AHORA), false);
  });

  it('rechaza alargar la caducidad, porque va dentro de la firma', () => {
    const valor = createSessionValue(SECRETO, AHORA);
    const firma = valor.slice(valor.indexOf('.') + 1);
    const dentroDeUnSiglo = Math.floor(AHORA / 1000) + 100 * 365 * 24 * 3600;

    assert.equal(verifySessionValue(SECRETO, `${dentroDeUnSiglo}.${firma}`, AHORA), false);
  });

  it('caduca sola', () => {
    const valor = createSessionValue(SECRETO, AHORA);
    const casi = AHORA + (SESSION_TTL_SECONDS - 60) * 1000;
    const pasado = AHORA + (SESSION_TTL_SECONDS + 60) * 1000;

    assert.equal(verifySessionValue(SECRETO, valor, casi), true);
    assert.equal(verifySessionValue(SECRETO, valor, pasado), false);
  });

  it('rechaza basura y la ausencia de cookie', () => {
    for (const malo of [undefined, '', '.', 'abc', 'abc.def', '12x3.abc', `${AHORA}`]) {
      assert.equal(verifySessionValue(SECRETO, malo, AHORA), false, JSON.stringify(malo));
    }
  });
});

describe('opciones de la cookie', () => {
  it('HttpOnly y SameSite=Lax, y Secure desactivado a propósito', () => {
    // Secure a true rompería la prueba en LAN sobre HTTP plano, que es el
    // primer contacto con la app.
    assert.equal(sessionCookieOptions.httpOnly, true);
    assert.equal(sessionCookieOptions.sameSite, 'lax');
    assert.equal(sessionCookieOptions.secure, false);
    assert.equal(sessionCookieOptions.path, '/');
  });
});

describe('comparación de contraseña', () => {
  it('acepta la correcta y rechaza el resto', () => {
    assert.equal(passwordMatches('correcta', 'correcta'), true);
    assert.equal(passwordMatches('correcta', 'Correcta'), false);
    assert.equal(passwordMatches('correcta', 'correct'), false);
    assert.equal(passwordMatches('correcta', ''), false);
  });

  it('no revienta con longitudes distintas', () => {
    // El hash previo iguala las longitudes; sin él, timingSafeEqual lanzaría.
    assert.equal(passwordMatches('corta', 'a'.repeat(5000)), false);
  });
});

describe('secreto de sesión', () => {
  it('usa SONDA_SESSION_SECRET si viene y no escribe nada', () => {
    const dir = dirTemporal();
    const secreto = resolveSessionSecret(
      config({ SONDA_DATA_DIR: dir, SONDA_SESSION_SECRET: 'del-entorno' }),
    );

    assert.equal(secreto, 'del-entorno');
    assert.throws(() => readFileSync(join(dir, SECRET_FILENAME), 'utf8'));
  });

  it('si falta, lo genera y lo guarda en SONDA_DATA_DIR', () => {
    const dir = dirTemporal();
    const secreto = resolveSessionSecret(config({ SONDA_DATA_DIR: dir }));

    assert.ok(secreto.length >= 32);
    assert.equal(readFileSync(join(dir, SECRET_FILENAME), 'utf8').trim(), secreto);
  });

  it('lo reutiliza en el arranque siguiente: las sesiones sobreviven al reinicio', () => {
    const dir = dirTemporal();
    const primero = resolveSessionSecret(config({ SONDA_DATA_DIR: dir }));
    const segundo = resolveSessionSecret(config({ SONDA_DATA_DIR: dir }));

    assert.equal(primero, segundo);

    const cookie = createSessionValue(primero, AHORA);
    assert.equal(verifySessionValue(segundo, cookie, AHORA), true);
  });

  it('crea el directorio si no existe', () => {
    const dir = join(dirTemporal(), 'sin', 'crear');
    const secreto = resolveSessionSecret(config({ SONDA_DATA_DIR: dir }));

    assert.equal(readFileSync(join(dir, SECRET_FILENAME), 'utf8').trim(), secreto);
  });
});

describe('backoff de login', () => {
  const IP = '192.168.1.50';

  it('los cuatro primeros fallos no bloquean: equivocarse es normal', () => {
    const backoff = new LoginBackoff();

    for (let n = 1; n <= FALLOS_GRATIS; n += 1) {
      assert.equal(backoff.fail(IP, AHORA).bloqueada, false, `fallo ${n}`);
    }
    assert.equal(backoff.check(IP, AHORA).bloqueada, false);
  });

  it('el quinto fallo bloquea', () => {
    const backoff = new LoginBackoff();

    for (let n = 1; n < 5; n += 1) backoff.fail(IP, AHORA);
    const tras = backoff.fail(IP, AHORA);

    assert.equal(tras.bloqueada, true);
    assert.equal(tras.retryAfter, 1);
  });

  it('la espera dobla con cada fallo posterior', () => {
    const backoff = new LoginBackoff();
    let ahora = AHORA;

    for (let n = 1; n < 5; n += 1) backoff.fail(IP, ahora);

    const esperas: number[] = [];
    for (let n = 0; n < 5; n += 1) {
      const tras = backoff.fail(IP, ahora);
      esperas.push(tras.retryAfter);
      // Dejar pasar el bloqueo para poder gastar el siguiente intento.
      ahora += tras.retryAfter * 1000;
    }

    assert.deepEqual(esperas, [1, 2, 4, 8, 16]);
  });

  it('la espera tiene techo', () => {
    const backoff = new LoginBackoff();
    let ahora = AHORA;
    let ultima = 0;

    for (let n = 0; n < 40; n += 1) {
      const tras = backoff.fail(IP, ahora);
      ultima = tras.retryAfter;
      ahora += tras.retryAfter * 1000;
    }

    assert.equal(ultima, ESPERA_MAXIMA_MS / 1000);
  });

  it('el bloqueo expira solo', () => {
    const backoff = new LoginBackoff();
    for (let n = 1; n <= 5; n += 1) backoff.fail(IP, AHORA);

    assert.equal(backoff.check(IP, AHORA + 500).bloqueada, true);
    assert.equal(backoff.check(IP, AHORA + 1_500).bloqueada, false);
  });

  it('un acierto borra el historial', () => {
    const backoff = new LoginBackoff();
    for (let n = 1; n <= 5; n += 1) backoff.fail(IP, AHORA);
    assert.equal(backoff.check(IP, AHORA).bloqueada, true);

    backoff.success(IP);

    assert.equal(backoff.check(IP, AHORA).bloqueada, false);
    assert.equal(backoff.fail(IP, AHORA).bloqueada, false);
  });

  it('bloquea por IP, no a todo el mundo', () => {
    const backoff = new LoginBackoff();
    for (let n = 1; n <= 5; n += 1) backoff.fail(IP, AHORA);

    assert.equal(backoff.check(IP, AHORA).bloqueada, true);
    assert.equal(backoff.check('10.0.0.9', AHORA).bloqueada, false);
  });

  it('olvida las IPs inactivas y no crece sin límite', () => {
    const backoff = new LoginBackoff();
    for (let i = 0; i < 50; i += 1) backoff.fail(`10.0.0.${i}`, AHORA);
    assert.equal(backoff.size, 50);

    backoff.check('otra', AHORA + OLVIDO_MS + 1);
    assert.equal(backoff.size, 0);
  });
});
