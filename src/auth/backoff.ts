/**
 * Freno de fuerza bruta para /api/auth/login.
 *
 * En memoria y por IP, sin dependencias ni tabla: reiniciar el servidor lo
 * limpia, lo cual es aceptable porque el objetivo no es un WAF, es que probar
 * contraseñas a ciegas contra una instancia expuesta pase de miles por minuto a
 * un puñado por hora.
 *
 * Los cuatro primeros fallos salen gratis: equivocarse escribiendo la
 * contraseña es normal. Del quinto en adelante se bloquea con espera que dobla
 * cada vez, hasta un techo.
 */

export const FALLOS_GRATIS = 4;
export const ESPERA_BASE_MS = 1_000;
export const ESPERA_MAXIMA_MS = 5 * 60 * 1_000;
/** Una entrada sin actividad durante este tiempo se olvida. */
export const OLVIDO_MS = 60 * 60 * 1_000;

interface Intentos {
  fallos: number;
  bloqueadaHasta: number;
  visto: number;
}

export interface EstadoBloqueo {
  bloqueada: boolean;
  /** Segundos que faltan, redondeados hacia arriba. Cero si no está bloqueada. */
  retryAfter: number;
}

const LIBRE: EstadoBloqueo = { bloqueada: false, retryAfter: 0 };

function esperaTras(fallos: number): number {
  const exponente = fallos - FALLOS_GRATIS - 1;
  return Math.min(ESPERA_BASE_MS * 2 ** exponente, ESPERA_MAXIMA_MS);
}

export class LoginBackoff {
  readonly #porIp = new Map<string, Intentos>();

  /** Solo para tests: cuántas IPs se están recordando. */
  get size(): number {
    return this.#porIp.size;
  }

  #limpia(ahora: number): void {
    for (const [ip, intentos] of this.#porIp) {
      if (ahora - intentos.visto > OLVIDO_MS) this.#porIp.delete(ip);
    }
  }

  /** Se llama antes de comprobar la contraseña. */
  check(ip: string, ahora = Date.now()): EstadoBloqueo {
    this.#limpia(ahora);

    const intentos = this.#porIp.get(ip);
    if (!intentos || intentos.bloqueadaHasta <= ahora) return LIBRE;

    return {
      bloqueada: true,
      retryAfter: Math.ceil((intentos.bloqueadaHasta - ahora) / 1000),
    };
  }

  /** Registra un intento fallido y devuelve el bloqueo resultante. */
  fail(ip: string, ahora = Date.now()): EstadoBloqueo {
    const intentos = this.#porIp.get(ip) ?? { fallos: 0, bloqueadaHasta: 0, visto: ahora };
    intentos.fallos += 1;
    intentos.visto = ahora;

    if (intentos.fallos > FALLOS_GRATIS) {
      intentos.bloqueadaHasta = ahora + esperaTras(intentos.fallos);
    }

    this.#porIp.set(ip, intentos);
    return this.check(ip, ahora);
  }

  /** Un login correcto borra el historial de esa IP. */
  success(ip: string): void {
    this.#porIp.delete(ip);
  }
}
