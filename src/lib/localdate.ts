/**
 * occurred_at (a UTC instant) + an IANA zone -> the local 'YYYY-MM-DD'.
 *
 * Pure functions. This is what decides which day an observation belongs to, so
 * a bug here breaks nothing loudly: it files data under the wrong day and stays
 * unnoticed for months. Hence the strict input validation.
 */

// An explicit zone designator is required. Without one, Date would read
// '2026-09-05T10:00:00' as the server's local time, which is the exact bug
// local_date exists to prevent.
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** V8 silently rolls the day of the month over, so the triple is checked here. */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;

  if (!isValidTimeZone(timeZone)) {
    throw new RangeError(`Unknown time zone: '${timeZone}'`);
  }

  // Calendar and numbering system are pinned by hand. Without them the result
  // would depend on the process locale, and a locale with a non-Gregorian
  // calendar would return a different year entirely.
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
 * Validates an ISO 8601 instant with an explicit zone and returns it as a Date.
 * Single source of truth for "what counts as a valid instant" across the
 * project: both toLocalDate and the zod input schemas go through here.
 */
export function parseInstant(value: string, field = 'occurred_at'): Date {
  const match = ISO_INSTANT.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new RangeError(
      `${field} must be an ISO 8601 instant with an explicit zone ` +
        `(e.g. '2026-09-05T23:30:00Z'), got '${value}'`,
    );
  }

  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError(`${field} is not a real date: '${value}'`);
  }

  // V8 rejects month 13 and hour 25, but overflows the day of the month
  // silently: '2026-02-30' becomes March 2nd. Here that would file an
  // observation under a day the client never sent.
  if (!isRealCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw new RangeError(`${field} is not a real date: '${value}'`);
  }

  return instant;
}

export function isIsoInstant(value: string): boolean {
  try {
    parseInstant(value);
    return true;
  } catch {
    return false;
  }
}

/** 'YYYY-MM-DD', the same shape as the local_date column. */
export function isLocalDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return false;
  return isRealCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function toLocalDate(occurredAt: string, timeZone: string): string {
  const instant = parseInstant(occurredAt);
  const parts = formatterFor(timeZone).formatToParts(instant);

  let year = '';
  let month = '';
  let day = '';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }

  if (year === '' || month === '' || day === '') {
    throw new Error(`Intl returned an incomplete date for '${timeZone}'`);
  }

  return `${year.padStart(4, '0')}-${month}-${day}`;
}
