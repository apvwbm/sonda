/**
 * occurred_at (instante UTC) + zona IANA → 'YYYY-MM-DD' local.
 *
 * Función pura. Es la que decide en qué día cae cada observación, así que un
 * fallo aquí no revienta nada: solo pone los datos en el día equivocado y no se
 * nota hasta meses después. De ahí la validación estricta de la entrada.
 */

// Exige designador de zona explícito. Sin él, '2026-09-05T10:00:00' lo
// interpretaría Date como hora local del servidor, que es justo el bug del que
// existe local_date.
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;

  if (!isValidTimeZone(timeZone)) {
    throw new RangeError(`Zona horaria desconocida: '${timeZone}'`);
  }

  // Calendario y numeración fijados a mano: sin ellos el resultado dependería
  // del locale del proceso, y una locale con calendario no gregoriano
  // devolvería otro año.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  formatters.set(timeZone, formatter);
  return formatter;
}

/**
 * Valida un instante ISO 8601 con zona explícita y lo devuelve como Date.
 * Única fuente de verdad de "qué es un instante válido" en todo el proyecto:
 * la usan toLocalDate y los esquemas zod de entrada.
 */
export function parseInstant(value: string, campo = 'occurred_at'): Date {
  const match = ISO_INSTANT.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new RangeError(
      `${campo} debe ser un instante ISO 8601 con zona explícita ` +
        `(p. ej. '2026-09-05T23:30:00Z'), y llegó '${value}'`,
    );
  }

  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError(`${campo} no es una fecha real: '${value}'`);
  }

  // V8 rechaza el mes 13 y la hora 25, pero el día del mes lo desborda en
  // silencio: '2026-02-30' se convierte en el 2 de marzo. Aquí eso sería una
  // observación archivada en un día que el cliente nunca dijo.
  if (!esFechaReal(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw new RangeError(`${campo} no es una fecha real: '${value}'`);
  }

  return instant;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Comprueba que el trío existe en el calendario: V8 desborda el día del mes. */
function esFechaReal(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** 'YYYY-MM-DD' del mismo formato que la columna local_date. */
export function isLocalDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return false;
  return esFechaReal(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function isIsoInstant(value: string): boolean {
  try {
    parseInstant(value);
    return true;
  } catch {
    return false;
  }
}

export function toLocalDate(occurredAt: string, timeZone: string): string {
  const instant = parseInstant(occurredAt);

  const parts = formatterFor(timeZone).formatToParts(instant);

  let localYear = '';
  let localMonth = '';
  let localDay = '';
  for (const part of parts) {
    if (part.type === 'year') localYear = part.value;
    else if (part.type === 'month') localMonth = part.value;
    else if (part.type === 'day') localDay = part.value;
  }

  if (localYear === '' || localMonth === '' || localDay === '') {
    throw new Error(`Intl no devolvió una fecha completa para '${timeZone}'`);
  }

  return `${localYear.padStart(4, '0')}-${localMonth}-${localDay}`;
}
