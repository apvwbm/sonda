import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import type { Db } from '../src/db/index.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { ingestObservations } from '../src/routes/observations.ts';
import { UnknownSeriesError, computeStats } from '../src/routes/stats.ts';

const TZ = 'Europe/Madrid';

function temporaryDb(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  db.prepare(
    `INSERT INTO series (slug, name, value_type, unit, aggregation, created_at) VALUES
       ('steps', 'Steps', 'number', 'steps', 'sum', '2026-01-01T00:00:00Z'),
       ('weight', 'Weight', 'number', 'kg', 'avg', '2026-01-01T00:00:00Z'),
       ('coffee', 'Coffees', 'bool', NULL, 'count', '2026-01-01T00:00:00Z'),
       ('mood', 'Mood', 'text', NULL, 'last', '2026-01-01T00:00:00Z'),
       ('empty', 'No data', 'number', NULL, 'sum', '2026-01-01T00:00:00Z')`,
  ).run();

  return db;
}

type Observations = Parameters<typeof ingestObservations>[1]['observations'];

const ingest = (db: Db, observations: Observations) =>
  ingestObservations(db, { source: 'fixtures', timeZone: TZ, observations });

let db: Db;
beforeEach(() => {
  db = temporaryDb();
});

/**
 * Fixed data around the week of Monday 2026-08-31.
 *
 *   Sun 2026-08-30 -> week of 2026-08-24
 *   Mon 2026-08-31 -> week of 2026-08-31
 *   Wed 2026-09-02 -> week of 2026-08-31
 *   Sun 2026-09-06 -> week of 2026-08-31   (Sunday closes the week)
 *   Mon 2026-09-07 -> week of 2026-09-07
 */
function weekFixtures(db: Db): void {
  ingest(db, [
    { series: 'steps', occurred_at: '2026-08-30T10:00:00Z', value: 1000, external_id: 's1' },
    { series: 'steps', occurred_at: '2026-08-31T10:00:00Z', value: 2000, external_id: 's2' },
    { series: 'steps', occurred_at: '2026-08-31T18:00:00Z', value: 500, external_id: 's3' },
    { series: 'steps', occurred_at: '2026-09-02T10:00:00Z', value: 3000, external_id: 's4' },
    { series: 'steps', occurred_at: '2026-09-06T10:00:00Z', value: 4000, external_id: 's5' },
    { series: 'steps', occurred_at: '2026-09-07T10:00:00Z', value: 9000, external_id: 's6' },
  ]);
}

describe('day bucket', () => {
  it('groups by local_date and sums within the day', () => {
    weekFixtures(db);

    const stats = computeStats(db, { series: 'steps', bucket: 'day' });

    assert.equal(stats.aggregation, 'sum');
    assert.equal(stats.unit, 'steps');
    assert.deepEqual(stats.buckets, [
      { date: '2026-08-30', value: 1000, count: 1 },
      { date: '2026-08-31', value: 2500, count: 2 },
      { date: '2026-09-02', value: 3000, count: 1 },
      { date: '2026-09-06', value: 4000, count: 1 },
      { date: '2026-09-07', value: 9000, count: 1 },
    ]);
  });

  it('2026-09-01 is absent: an empty bucket is not invented', () => {
    weekFixtures(db);

    const days = computeStats(db, { series: 'steps', bucket: 'day' }).buckets.map((b) => b.date);
    assert.equal(days.includes('2026-09-01'), false);
    assert.equal(days.includes('2026-09-03'), false);
  });
});

describe('week bucket: weeks start on Monday', () => {
  it('Monday opens the week and Sunday closes it', () => {
    weekFixtures(db);

    assert.deepEqual(computeStats(db, { series: 'steps', bucket: 'week' }).buckets, [
      // Sunday August 30th belongs to the previous week
      { date: '2026-08-24', value: 1000, count: 1 },
      // Monday 31st + Wednesday 2nd + Sunday 6th
      { date: '2026-08-31', value: 9500, count: 4 },
      { date: '2026-09-07', value: 9000, count: 1 },
    ]);
  });

  it('the bucket date is always a Monday', () => {
    weekFixtures(db);

    for (const bucket of computeStats(db, { series: 'steps', bucket: 'week' }).buckets) {
      assert.equal(new Date(`${bucket.date}T12:00:00Z`).getUTCDay(), 1, `${bucket.date}`);
    }
  });

  it('crosses the year without breaking the week', () => {
    // Thursday 2026-01-01 belongs to the week of Monday 2025-12-29.
    ingest(db, [
      { series: 'steps', occurred_at: '2025-12-30T10:00:00Z', value: 10, external_id: 'a' },
      { series: 'steps', occurred_at: '2026-01-01T10:00:00Z', value: 20, external_id: 'b' },
    ]);

    assert.deepEqual(computeStats(db, { series: 'steps', bucket: 'week' }).buckets, [
      { date: '2025-12-29', value: 30, count: 2 },
    ]);
  });
});

describe('month bucket', () => {
  it('groups on the first day of the month', () => {
    weekFixtures(db);

    assert.deepEqual(computeStats(db, { series: 'steps', bucket: 'month' }).buckets, [
      { date: '2026-08-01', value: 3500, count: 3 },
      { date: '2026-09-01', value: 16000, count: 3 },
    ]);
  });
});

describe('the aggregation comes from the series, not from the client', () => {
  it('avg averages', () => {
    ingest(db, [
      { series: 'weight', occurred_at: '2026-09-05T07:00:00Z', value: 74, external_id: 'a' },
      { series: 'weight', occurred_at: '2026-09-05T20:00:00Z', value: 76, external_id: 'b' },
    ]);

    const stats = computeStats(db, { series: 'weight', bucket: 'day' });
    assert.equal(stats.aggregation, 'avg');
    assert.equal(stats.unit, 'kg');
    assert.deepEqual(stats.buckets, [{ date: '2026-09-05', value: 75, count: 2 }]);
  });

  it('count counts observations, not values', () => {
    ingest(db, [
      { series: 'coffee', occurred_at: '2026-09-05T08:00:00Z', value: true, external_id: 'a' },
      { series: 'coffee', occurred_at: '2026-09-05T12:00:00Z', value: false, external_id: 'b' },
      { series: 'coffee', occurred_at: '2026-09-05T18:00:00Z', value: true, external_id: 'c' },
    ]);

    assert.deepEqual(computeStats(db, { series: 'coffee', bucket: 'day' }).buckets, [
      { date: '2026-09-05', value: 3, count: 3 },
    ]);
  });

  it('last takes the most recent observation of the bucket', () => {
    ingest(db, [
      { series: 'mood', occurred_at: '2026-09-05T08:00:00Z', value: 'so-so', external_id: 'a' },
      { series: 'mood', occurred_at: '2026-09-05T21:00:00Z', value: 'good', external_id: 'b' },
      { series: 'mood', occurred_at: '2026-09-05T14:00:00Z', value: 'bad', external_id: 'c' },
    ]);

    assert.deepEqual(computeStats(db, { series: 'mood', bucket: 'day' }).buckets, [
      { date: '2026-09-05', value: 'good', count: 3 },
    ]);
  });

  it('last inside a month bucket takes the last of the whole month', () => {
    ingest(db, [
      { series: 'mood', occurred_at: '2026-09-01T08:00:00Z', value: 'first', external_id: 'a' },
      { series: 'mood', occurred_at: '2026-09-28T08:00:00Z', value: 'last', external_id: 'b' },
      { series: 'mood', occurred_at: '2026-09-15T08:00:00Z', value: 'middle', external_id: 'c' },
    ]);

    assert.deepEqual(computeStats(db, { series: 'mood', bucket: 'month' }).buckets, [
      { date: '2026-09-01', value: 'last', count: 3 },
    ]);
  });
});

describe('the local date rules, not the UTC one', () => {
  it('23:30 UTC counts towards the next day in Madrid', () => {
    ingest(db, [
      // 23:30 UTC on the 5th is 01:30 on the 6th in Madrid.
      { series: 'steps', occurred_at: '2026-09-05T23:30:00Z', value: 100, external_id: 'a' },
      { series: 'steps', occurred_at: '2026-09-06T10:00:00Z', value: 200, external_id: 'b' },
    ]);

    assert.deepEqual(computeStats(db, { series: 'steps', bucket: 'day' }).buckets, [
      { date: '2026-09-06', value: 300, count: 2 },
    ]);
  });

  it('grouping by UTC would give a different answer, which is the whole point', () => {
    ingest(db, [
      { series: 'steps', occurred_at: '2026-09-05T23:30:00Z', value: 100, external_id: 'a' },
    ]);

    const byLocal = computeStats(db, { series: 'steps', bucket: 'day' }).buckets;
    const byUtc = db
      .prepare('SELECT substr(occurred_at, 1, 10) AS date FROM observations')
      .all() as { date: string }[];

    assert.equal(byLocal[0]?.date, '2026-09-06');
    assert.equal(byUtc[0]?.date, '2026-09-05');
  });

  it('an observation falls in the local day week, not the UTC one', () => {
    // Sunday 2026-09-06 at 23:30 UTC is already Monday the 7th in Madrid, so it
    // opens the next week instead of closing the previous one.
    ingest(db, [
      { series: 'steps', occurred_at: '2026-09-06T23:30:00Z', value: 100, external_id: 'a' },
    ]);

    assert.deepEqual(computeStats(db, { series: 'steps', bucket: 'week' }).buckets, [
      { date: '2026-09-07', value: 100, count: 1 },
    ]);
  });
});

describe('from and to filters', () => {
  it('trim by local date, with both ends included', () => {
    weekFixtures(db);

    assert.deepEqual(
      computeStats(db, {
        series: 'steps',
        bucket: 'day',
        from: '2026-08-31',
        to: '2026-09-02',
      }).buckets,
      [
        { date: '2026-08-31', value: 2500, count: 2 },
        { date: '2026-09-02', value: 3000, count: 1 },
      ],
    );
  });

  it('a range with no data returns an empty list, not an error', () => {
    weekFixtures(db);

    assert.deepEqual(
      computeStats(db, { series: 'steps', bucket: 'day', from: '2030-01-01', to: '2030-12-31' })
        .buckets,
      [],
    );
  });

  it('trimming happens per observation, so a partial week shows as partial', () => {
    weekFixtures(db);

    // From Wednesday on: the week of the 31st loses Monday and drops to 7000.
    assert.deepEqual(
      computeStats(db, { series: 'steps', bucket: 'week', from: '2026-09-02' }).buckets,
      [
        { date: '2026-08-31', value: 7000, count: 2 },
        { date: '2026-09-07', value: 9000, count: 1 },
      ],
    );
  });
});

describe('edge cases', () => {
  it('a series with no observations returns empty buckets plus its metadata', () => {
    assert.deepEqual(computeStats(db, { series: 'empty', bucket: 'day' }), {
      series: 'empty',
      aggregation: 'sum',
      unit: null,
      buckets: [],
    });
  });

  it('a series that does not exist is distinguishable from an empty one', () => {
    assert.throws(
      () => computeStats(db, { series: 'invented', bucket: 'day' }),
      UnknownSeriesError,
    );
  });

  it('only aggregates the requested series', () => {
    ingest(db, [
      { series: 'steps', occurred_at: '2026-09-05T10:00:00Z', value: 1000, external_id: 'a' },
      { series: 'weight', occurred_at: '2026-09-05T10:00:00Z', value: 74, external_id: 'b' },
    ]);

    assert.deepEqual(computeStats(db, { series: 'steps', bucket: 'day' }).buckets, [
      { date: '2026-09-05', value: 1000, count: 1 },
    ]);
  });

  it('aggregates observations from several sources into the same bucket', () => {
    ingest(db, [
      { series: 'steps', occurred_at: '2026-09-05T10:00:00Z', value: 1000, external_id: 'a' },
    ]);
    ingestObservations(db, {
      source: 'other',
      timeZone: TZ,
      observations: [
        { series: 'steps', occurred_at: '2026-09-05T11:00:00Z', value: 500, external_id: 'a' },
      ],
    });

    assert.deepEqual(computeStats(db, { series: 'steps', bucket: 'day' }).buckets, [
      { date: '2026-09-05', value: 1500, count: 2 },
    ]);
  });
});
