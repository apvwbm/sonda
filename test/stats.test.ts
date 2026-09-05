import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { beforeEach, describe, it } from 'node:test';
import type { Db } from '../src/db/index.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { ingestObservations } from '../src/routes/observations.ts';
import { SeriesDesconocida, computeStats } from '../src/routes/stats.ts';

const TZ = 'Europe/Madrid';

function baseTemporal(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  db.prepare(
    `INSERT INTO series (slug, name, value_type, unit, aggregation, created_at) VALUES
       ('pasos', 'Pasos', 'number', 'pasos', 'sum', '2026-01-01T00:00:00Z'),
       ('peso', 'Peso', 'number', 'kg', 'avg', '2026-01-01T00:00:00Z'),
       ('cafe', 'Cafes', 'bool', NULL, 'count', '2026-01-01T00:00:00Z'),
       ('animo', 'Animo', 'text', NULL, 'last', '2026-01-01T00:00:00Z'),
       ('vacia', 'Sin datos', 'number', NULL, 'sum', '2026-01-01T00:00:00Z')`,
  ).run();

  return db;
}

type Observations = Parameters<typeof ingestObservations>[1]['observations'];

const meter = (db: Db, observations: Observations) =>
  ingestObservations(db, { source: 'fijos', timeZone: TZ, observations });

let db: Db;
beforeEach(() => {
  db = baseTemporal();
});

/**
 * Datos fijos alrededor de la semana del lunes 2026-08-31, que es justo el
 * bucket que aparece en el ejemplo de la sección 4.2 del plan.
 *
 *   dom 2026-08-30  -> semana del 2026-08-24
 *   lun 2026-08-31  -> semana del 2026-08-31
 *   mié 2026-09-02  -> semana del 2026-08-31
 *   dom 2026-09-06  -> semana del 2026-08-31   (el domingo cierra la semana)
 *   lun 2026-09-07  -> semana del 2026-09-07
 */
function datosDeSemana(db: Db): void {
  meter(db, [
    { series: 'pasos', occurred_at: '2026-08-30T10:00:00Z', value: 1000, external_id: 'p1' },
    { series: 'pasos', occurred_at: '2026-08-31T10:00:00Z', value: 2000, external_id: 'p2' },
    { series: 'pasos', occurred_at: '2026-08-31T18:00:00Z', value: 500, external_id: 'p3' },
    { series: 'pasos', occurred_at: '2026-09-02T10:00:00Z', value: 3000, external_id: 'p4' },
    { series: 'pasos', occurred_at: '2026-09-06T10:00:00Z', value: 4000, external_id: 'p5' },
    { series: 'pasos', occurred_at: '2026-09-07T10:00:00Z', value: 9000, external_id: 'p6' },
  ]);
}

describe('bucket day', () => {
  it('agrupa por local_date y suma dentro del día', () => {
    datosDeSemana(db);

    const stats = computeStats(db, { series: 'pasos', bucket: 'day' });

    assert.equal(stats.aggregation, 'sum');
    assert.equal(stats.unit, 'pasos');
    assert.deepEqual(stats.buckets, [
      { date: '2026-08-30', value: 1000, count: 1 },
      { date: '2026-08-31', value: 2500, count: 2 },
      { date: '2026-09-02', value: 3000, count: 1 },
      { date: '2026-09-06', value: 4000, count: 1 },
      { date: '2026-09-07', value: 9000, count: 1 },
    ]);
  });

  it('el 2026-09-01 no aparece: un bucket sin datos no se inventa', () => {
    datosDeSemana(db);

    const dias = computeStats(db, { series: 'pasos', bucket: 'day' }).buckets.map((b) => b.date);
    assert.equal(dias.includes('2026-09-01'), false);
    assert.equal(dias.includes('2026-09-03'), false);
  });
});

describe('bucket week: la semana empieza en lunes', () => {
  it('el lunes abre la semana y el domingo la cierra', () => {
    datosDeSemana(db);

    assert.deepEqual(computeStats(db, { series: 'pasos', bucket: 'week' }).buckets, [
      // domingo 30 de agosto cae en la semana anterior
      { date: '2026-08-24', value: 1000, count: 1 },
      // lunes 31 + miércoles 2 + domingo 6
      { date: '2026-08-31', value: 9500, count: 4 },
      { date: '2026-09-07', value: 9000, count: 1 },
    ]);
  });

  it('la fecha del bucket es siempre un lunes', () => {
    datosDeSemana(db);

    for (const bucket of computeStats(db, { series: 'pasos', bucket: 'week' }).buckets) {
      const dia = new Date(`${bucket.date}T12:00:00Z`).getUTCDay();
      assert.equal(dia, 1, `${bucket.date} deberia ser lunes`);
    }
  });

  it('cruza el año sin romper la semana', () => {
    // El jueves 2026-01-01 pertenece a la semana del lunes 2025-12-29.
    meter(db, [
      { series: 'pasos', occurred_at: '2025-12-30T10:00:00Z', value: 10, external_id: 'a' },
      { series: 'pasos', occurred_at: '2026-01-01T10:00:00Z', value: 20, external_id: 'b' },
    ]);

    assert.deepEqual(computeStats(db, { series: 'pasos', bucket: 'week' }).buckets, [
      { date: '2025-12-29', value: 30, count: 2 },
    ]);
  });
});

describe('bucket month', () => {
  it('agrupa por el día 1 del mes', () => {
    datosDeSemana(db);

    assert.deepEqual(computeStats(db, { series: 'pasos', bucket: 'month' }).buckets, [
      { date: '2026-08-01', value: 3500, count: 3 },
      { date: '2026-09-01', value: 16000, count: 3 },
    ]);
  });
});

describe('la agregación sale de la serie, no del cliente', () => {
  it('avg promedia', () => {
    meter(db, [
      { series: 'peso', occurred_at: '2026-09-05T07:00:00Z', value: 74, external_id: 'a' },
      { series: 'peso', occurred_at: '2026-09-05T20:00:00Z', value: 76, external_id: 'b' },
    ]);

    const stats = computeStats(db, { series: 'peso', bucket: 'day' });
    assert.equal(stats.aggregation, 'avg');
    assert.equal(stats.unit, 'kg');
    assert.deepEqual(stats.buckets, [{ date: '2026-09-05', value: 75, count: 2 }]);
  });

  it('count cuenta observaciones, no valores', () => {
    meter(db, [
      { series: 'cafe', occurred_at: '2026-09-05T08:00:00Z', value: true, external_id: 'a' },
      { series: 'cafe', occurred_at: '2026-09-05T12:00:00Z', value: false, external_id: 'b' },
      { series: 'cafe', occurred_at: '2026-09-05T18:00:00Z', value: true, external_id: 'c' },
    ]);

    assert.deepEqual(computeStats(db, { series: 'cafe', bucket: 'day' }).buckets, [
      { date: '2026-09-05', value: 3, count: 3 },
    ]);
  });

  it('last se queda con la observación más reciente del bucket', () => {
    meter(db, [
      { series: 'animo', occurred_at: '2026-09-05T08:00:00Z', value: 'regular', external_id: 'a' },
      { series: 'animo', occurred_at: '2026-09-05T21:00:00Z', value: 'bien', external_id: 'b' },
      { series: 'animo', occurred_at: '2026-09-05T14:00:00Z', value: 'mal', external_id: 'c' },
    ]);

    assert.deepEqual(computeStats(db, { series: 'animo', bucket: 'day' }).buckets, [
      { date: '2026-09-05', value: 'bien', count: 3 },
    ]);
  });

  it('last dentro de un bucket de mes coge la última del mes entero', () => {
    meter(db, [
      { series: 'animo', occurred_at: '2026-09-01T08:00:00Z', value: 'primero', external_id: 'a' },
      { series: 'animo', occurred_at: '2026-09-28T08:00:00Z', value: 'ultimo', external_id: 'b' },
      { series: 'animo', occurred_at: '2026-09-15T08:00:00Z', value: 'medio', external_id: 'c' },
    ]);

    assert.deepEqual(computeStats(db, { series: 'animo', bucket: 'month' }).buckets, [
      { date: '2026-09-01', value: 'ultimo', count: 3 },
    ]);
  });
});

describe('manda la fecha local, no la UTC', () => {
  it('las 23:30 UTC cuentan en el día siguiente de Madrid', () => {
    meter(db, [
      // 23:30 UTC del 5 son las 01:30 del 6 en Madrid.
      { series: 'pasos', occurred_at: '2026-09-05T23:30:00Z', value: 100, external_id: 'a' },
      { series: 'pasos', occurred_at: '2026-09-06T10:00:00Z', value: 200, external_id: 'b' },
    ]);

    assert.deepEqual(computeStats(db, { series: 'pasos', bucket: 'day' }).buckets, [
      { date: '2026-09-06', value: 300, count: 2 },
    ]);
  });

  it('agrupar por UTC daría otro resultado: es justo lo que se evita', () => {
    meter(db, [
      { series: 'pasos', occurred_at: '2026-09-05T23:30:00Z', value: 100, external_id: 'a' },
    ]);

    const porLocal = computeStats(db, { series: 'pasos', bucket: 'day' }).buckets;
    const porUtc = db
      .prepare("SELECT substr(occurred_at, 1, 10) AS date FROM observations")
      .all() as { date: string }[];

    assert.equal(porLocal[0]?.date, '2026-09-06');
    assert.equal(porUtc[0]?.date, '2026-09-05');
  });

  it('la observación cae en la semana del día local, no la del UTC', () => {
    // Domingo 2026-09-06 a las 23:30 UTC ya es lunes 7 en Madrid, así que
    // abre la semana siguiente en vez de cerrar la anterior.
    meter(db, [
      { series: 'pasos', occurred_at: '2026-09-06T23:30:00Z', value: 100, external_id: 'a' },
    ]);

    assert.deepEqual(computeStats(db, { series: 'pasos', bucket: 'week' }).buckets, [
      { date: '2026-09-07', value: 100, count: 1 },
    ]);
  });
});

describe('filtros from y to', () => {
  it('recortan por fecha local, con ambos extremos incluidos', () => {
    datosDeSemana(db);

    const buckets = computeStats(db, {
      series: 'pasos',
      bucket: 'day',
      from: '2026-08-31',
      to: '2026-09-02',
    }).buckets;

    assert.deepEqual(buckets, [
      { date: '2026-08-31', value: 2500, count: 2 },
      { date: '2026-09-02', value: 3000, count: 1 },
    ]);
  });

  it('un rango sin datos devuelve una lista vacía, no un error', () => {
    datosDeSemana(db);

    assert.deepEqual(
      computeStats(db, { series: 'pasos', bucket: 'day', from: '2030-01-01', to: '2030-12-31' })
        .buckets,
      [],
    );
  });

  it('el recorte es por observación: la semana queda parcial y se ve', () => {
    datosDeSemana(db);

    // Desde el miércoles: la semana del 31 pierde el lunes y se queda en 7000.
    assert.deepEqual(
      computeStats(db, { series: 'pasos', bucket: 'week', from: '2026-09-02' }).buckets,
      [
        { date: '2026-08-31', value: 7000, count: 2 },
        { date: '2026-09-07', value: 9000, count: 1 },
      ],
    );
  });
});

describe('casos borde', () => {
  it('una serie sin observaciones devuelve buckets vacíos con sus metadatos', () => {
    assert.deepEqual(computeStats(db, { series: 'vacia', bucket: 'day' }), {
      series: 'vacia',
      aggregation: 'sum',
      unit: null,
      buckets: [],
    });
  });

  it('una serie que no existe se distingue de una serie vacía', () => {
    assert.throws(() => computeStats(db, { series: 'inventada', bucket: 'day' }), SeriesDesconocida);
  });

  it('solo agrega la serie pedida', () => {
    meter(db, [
      { series: 'pasos', occurred_at: '2026-09-05T10:00:00Z', value: 1000, external_id: 'a' },
      { series: 'peso', occurred_at: '2026-09-05T10:00:00Z', value: 74, external_id: 'b' },
    ]);

    assert.deepEqual(computeStats(db, { series: 'pasos', bucket: 'day' }).buckets, [
      { date: '2026-09-05', value: 1000, count: 1 },
    ]);
  });

  it('agrega observaciones de varias fuentes en el mismo bucket', () => {
    meter(db, [
      { series: 'pasos', occurred_at: '2026-09-05T10:00:00Z', value: 1000, external_id: 'a' },
    ]);
    ingestObservations(db, {
      source: 'otro',
      timeZone: TZ,
      observations: [
        { series: 'pasos', occurred_at: '2026-09-05T11:00:00Z', value: 500, external_id: 'a' },
      ],
    });

    assert.deepEqual(computeStats(db, { series: 'pasos', bucket: 'day' }).buckets, [
      { date: '2026-09-05', value: 1500, count: 2 },
    ]);
  });
});
