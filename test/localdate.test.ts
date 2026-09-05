import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isValidTimeZone, toLocalDate } from '../src/lib/localdate.ts';

const MADRID = 'Europe/Madrid';

describe('toLocalDate', () => {
  describe('el caso que justifica la columna', () => {
    it('las 23:30 UTC ya son del día siguiente en Madrid', () => {
      assert.equal(toLocalDate('2026-09-05T23:30:00Z', MADRID), '2026-09-06');
    });

    it('las 00:30 UTC siguen siendo del mismo día en Madrid', () => {
      assert.equal(toLocalDate('2026-09-05T00:30:00Z', MADRID), '2026-09-05');
    });

    it('no arrastra el día del servidor: el mismo instante da el mismo día', () => {
      // Mismo instante escrito con offset en vez de con Z.
      assert.equal(
        toLocalDate('2026-09-06T01:30:00+02:00', MADRID),
        toLocalDate('2026-09-05T23:30:00Z', MADRID),
      );
    });
  });

  describe('cambio de hora de octubre en Madrid (2026-10-25, 03:00 CEST → 02:00 CET)', () => {
    it('antes del cambio, 22:30 UTC ya es el día 25 (CEST, +2)', () => {
      assert.equal(toLocalDate('2026-10-24T22:30:00Z', MADRID), '2026-10-25');
    });

    it('después del cambio, 22:30 UTC sigue siendo el día 25 (CET, +1)', () => {
      // 24 horas exactas más tarde y la misma fecha local: el offset encogió una
      // hora por el camino. Si esto se rompe, el bug es de los que no se ven.
      assert.equal(toLocalDate('2026-10-25T22:30:00Z', MADRID), '2026-10-25');
    });

    it('la hora ambigua (02:30 local dos veces) cae el mismo día las dos', () => {
      assert.equal(toLocalDate('2026-10-25T00:30:00Z', MADRID), '2026-10-25'); // CEST
      assert.equal(toLocalDate('2026-10-25T01:30:00Z', MADRID), '2026-10-25'); // CET
    });

    it('cruza a día 26 una hora más tarde que antes del cambio', () => {
      assert.equal(toLocalDate('2026-10-25T23:30:00Z', MADRID), '2026-10-26');
    });
  });

  describe('cambio de hora de marzo en Madrid (2026-03-29, 02:00 CET → 03:00 CEST)', () => {
    it('23:30 UTC del día 28 ya es el 29 (CET, +1)', () => {
      assert.equal(toLocalDate('2026-03-28T23:30:00Z', MADRID), '2026-03-29');
    });

    it('el salto hacia adelante no cambia de día', () => {
      assert.equal(toLocalDate('2026-03-29T00:59:00Z', MADRID), '2026-03-29'); // 01:59 CET
      assert.equal(toLocalDate('2026-03-29T01:00:00Z', MADRID), '2026-03-29'); // 03:00 CEST
    });
  });

  describe('offsets que no son horas enteras', () => {
    it('Asia/Kolkata (+05:30) cambia de día a las 18:30 UTC', () => {
      assert.equal(toLocalDate('2026-09-05T18:29:59Z', 'Asia/Kolkata'), '2026-09-05');
      assert.equal(toLocalDate('2026-09-05T18:30:00Z', 'Asia/Kolkata'), '2026-09-06');
    });

    it('Pacific/Chatham (+12:45) cambia de día a las 11:15 UTC', () => {
      assert.equal(toLocalDate('2026-09-05T11:14:00Z', 'Pacific/Chatham'), '2026-09-05');
      assert.equal(toLocalDate('2026-09-05T11:15:00Z', 'Pacific/Chatham'), '2026-09-06');
    });
  });

  describe('extremos del huso', () => {
    it('Pacific/Kiritimati (+14) va un día por delante de UTC', () => {
      assert.equal(toLocalDate('2026-09-05T10:00:00Z', 'Pacific/Kiritimati'), '2026-09-06');
    });

    it('Pacific/Niue (-11) va un día por detrás de UTC', () => {
      assert.equal(toLocalDate('2026-09-05T10:00:00Z', 'Pacific/Niue'), '2026-09-04');
    });

    it('UTC devuelve la parte de fecha tal cual', () => {
      assert.equal(toLocalDate('2026-09-05T23:30:00Z', 'UTC'), '2026-09-05');
    });
  });

  describe('formato de salida', () => {
    it('rellena mes y día a dos dígitos', () => {
      assert.equal(toLocalDate('2026-01-02T12:00:00Z', MADRID), '2026-01-02');
    });

    it('cruza el año correctamente', () => {
      assert.equal(toLocalDate('2026-12-31T23:30:00Z', MADRID), '2027-01-01');
    });

    it('admite segundos omitidos y fracciones de segundo', () => {
      assert.equal(toLocalDate('2026-09-05T23:30Z', MADRID), '2026-09-06');
      assert.equal(toLocalDate('2026-09-05T23:30:00.123Z', MADRID), '2026-09-06');
    });

    it('es determinista entre llamadas (el formatter cacheado no ensucia)', () => {
      const primera = toLocalDate('2026-09-05T23:30:00Z', MADRID);
      toLocalDate('2026-09-05T23:30:00Z', 'Asia/Kolkata');
      assert.equal(toLocalDate('2026-09-05T23:30:00Z', MADRID), primera);
    });
  });

  describe('entradas inválidas: tienen que fallar, no devolver una fecha cualquiera', () => {
    it('rechaza una zona que no existe', () => {
      assert.throws(() => toLocalDate('2026-09-05T23:30:00Z', 'Marte/Olympus'), {
        name: 'RangeError',
        message: /Marte\/Olympus/,
      });
    });

    it('rechaza la zona vacía', () => {
      assert.throws(() => toLocalDate('2026-09-05T23:30:00Z', ''), RangeError);
    });

    it('rechaza un instante sin designador de zona', () => {
      // Este es el peligroso: Date lo aceptaría como hora local del servidor.
      assert.throws(() => toLocalDate('2026-09-05T23:30:00', MADRID), {
        name: 'RangeError',
        message: /zona explícita/,
      });
    });

    it('rechaza una fecha sin hora', () => {
      assert.throws(() => toLocalDate('2026-09-05', MADRID), RangeError);
    });

    it('rechaza texto que no es una fecha', () => {
      assert.throws(() => toLocalDate('ayer por la tarde', MADRID), RangeError);
      assert.throws(() => toLocalDate('', MADRID), RangeError);
    });

    it('rechaza días que no existen en vez de desbordarlos al mes siguiente', () => {
      // new Date('2026-02-30') devuelve el 2 de marzo sin quejarse. Sin esta
      // guarda, la observación se archivaría en un día que nadie pidió.
      for (const inexistente of [
        '2026-02-30T12:00:00Z',
        '2026-02-29T12:00:00Z', // 2026 no es bisiesto
        '2026-04-31T12:00:00Z',
        '2026-06-31T12:00:00Z',
      ]) {
        assert.throws(
          () => toLocalDate(inexistente, MADRID),
          { name: 'RangeError', message: /no es una fecha real/ },
          inexistente,
        );
      }
    });

    it('acepta el 29 de febrero de un año bisiesto', () => {
      assert.equal(toLocalDate('2024-02-29T12:00:00Z', MADRID), '2024-02-29');
    });

    it('rechaza mes, día y hora fuera de rango', () => {
      for (const fuera of [
        '2026-13-01T12:00:00Z',
        '2026-00-10T12:00:00Z',
        '2026-09-00T12:00:00Z',
        '2026-09-05T25:00:00Z',
        '2026-09-05T23:61:00Z',
      ]) {
        assert.throws(() => toLocalDate(fuera, MADRID), RangeError, fuera);
      }
    });
  });
});

describe('isValidTimeZone', () => {
  it('acepta zonas IANA reales', () => {
    for (const tz of ['Europe/Madrid', 'UTC', 'Asia/Kolkata', 'Pacific/Chatham']) {
      assert.equal(isValidTimeZone(tz), true, tz);
    }
  });

  it('rechaza lo que no lo es', () => {
    for (const tz of ['Marte/Olympus', '', 'CEST', 'Europe/Madriz']) {
      assert.equal(isValidTimeZone(tz), false, JSON.stringify(tz));
    }
  });
});
