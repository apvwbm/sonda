import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import {
  authenticateBearer,
  findTokenIdentity,
  hashToken,
  mintToken,
  parseBearer,
} from '../src/auth/token.ts';
import type { Db } from '../src/db/index.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { IngestValidationError, ingestObservations } from '../src/routes/observations.ts';

const TZ = 'Europe/Madrid';

/** In-memory database, migrated exactly like the real one and gone on exit. */
function temporaryDb(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  db.prepare(
    `INSERT INTO series (slug, name, value_type, unit, aggregation, created_at) VALUES
       ('coffee', 'Coffees', 'bool', NULL, 'count', '2026-01-01T00:00:00Z'),
       ('weight', 'Weight', 'number', 'kg', 'avg', '2026-01-01T00:00:00Z'),
       ('sleep', 'Sleep', 'duration', 'min', 'avg', '2026-01-01T00:00:00Z'),
       ('notes', 'Notes', 'text', NULL, 'last', '2026-01-01T00:00:00Z')`,
  ).run();

  return db;
}

type Observations = Parameters<typeof ingestObservations>[1]['observations'];

const ingest = (db: Db, observations: Observations) =>
  ingestObservations(db, { source: 'tests', timeZone: TZ, observations });

const count = (db: Db, sql = 'SELECT COUNT(*) n FROM observations') =>
  (db.prepare(sql).get() as { n: number }).n;

let db: Db;
beforeEach(() => {
  db = temporaryDb();
});

describe('idempotency: resending is correcting, not duplicating', () => {
  const batch = [
    {
      series: 'coffee',
      occurred_at: '2026-09-05T08:12:00Z',
      value: 1,
      external_id: 'coffee-2026-09-05-1',
    },
    {
      series: 'weight',
      occurred_at: '2026-09-05T07:30:00Z',
      value: 74.2,
      external_id: 'weight-2026-09-05',
    },
  ];

  it('the same batch twice leaves the same rows', () => {
    assert.deepEqual(ingest(db, batch), { inserted: 2, updated: 0, series_desconocidas: [] });
    assert.deepEqual(ingest(db, batch), { inserted: 0, updated: 2, series_desconocidas: [] });
    assert.equal(count(db), 2);
  });

  it('one new row and one corrected row in the same batch', () => {
    ingest(db, [batch[0]!]);

    assert.deepEqual(ingest(db, batch), { inserted: 1, updated: 1, series_desconocidas: [] });
    assert.equal(count(db), 2);
  });

  it('resending thirty whole days duplicates nothing', () => {
    const thirtyDays = Array.from({ length: 30 }, (_, i) => ({
      series: 'coffee',
      occurred_at: `2026-09-${String(i + 1).padStart(2, '0')}T08:00:00Z`,
      value: 1,
      external_id: `coffee-day-${i + 1}`,
    }));

    assert.equal(ingest(db, thirtyDays).inserted, 30);
    assert.equal(ingest(db, thirtyDays).updated, 30);
    assert.equal(ingest(db, thirtyDays).updated, 30);
    assert.equal(count(db), 30);
  });

  it('a conflict UPDATEs rather than IGNOREs: the new value wins', () => {
    ingest(db, [
      { series: 'weight', occurred_at: '2026-09-05T07:30:00Z', value: 74.2, external_id: 'w1' },
    ]);
    ingest(db, [
      { series: 'weight', occurred_at: '2026-09-05T07:30:00Z', value: 73.8, external_id: 'w1' },
    ]);

    assert.deepEqual(
      db.prepare('SELECT value_num FROM observations WHERE external_id = ?').get('w1'),
      { value_num: 73.8 },
    );
    assert.equal(count(db), 1);
  });

  it('a correction keeps created_at but updates occurred_at and local_date', () => {
    ingest(db, [
      { series: 'coffee', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'c1' },
    ]);
    const before = db
      .prepare('SELECT created_at FROM observations WHERE external_id = ?')
      .get('c1') as { created_at: string };

    ingest(db, [
      { series: 'coffee', occurred_at: '2026-09-05T23:30:00Z', value: 0, external_id: 'c1' },
    ]);
    const after = db
      .prepare(
        'SELECT created_at, occurred_at, local_date, value_num FROM observations WHERE external_id = ?',
      )
      .get('c1') as {
      created_at: string;
      occurred_at: string;
      local_date: string;
      value_num: number;
    };

    assert.equal(after.created_at, before.created_at);
    assert.equal(after.occurred_at, '2026-09-05T23:30:00Z');
    assert.equal(after.local_date, '2026-09-06');
    assert.equal(after.value_num, 0);
  });

  it('a duplicate within the batch itself counts as an update, not two rows', () => {
    const result = ingest(db, [
      { series: 'coffee', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'dup' },
      { series: 'coffee', occurred_at: '2026-09-05T09:00:00Z', value: 0, external_id: 'dup' },
    ]);

    assert.deepEqual(result, { inserted: 1, updated: 1, series_desconocidas: [] });
    assert.equal(count(db), 1);
  });

  it('the same external_id from another source is a different row: the pair is what is unique', () => {
    ingest(db, [
      { series: 'coffee', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'x' },
    ]);
    ingestObservations(db, {
      source: 'another-source',
      timeZone: TZ,
      observations: [
        { series: 'coffee', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'x' },
      ],
    });

    assert.equal(count(db), 2);
  });
});

describe('generated external_id', () => {
  it('the server assigns a UUID when none is sent', () => {
    ingest(db, [{ series: 'coffee', occurred_at: '2026-09-05T08:00:00Z', value: 1 }]);

    const row = db.prepare('SELECT external_id FROM observations').get() as {
      external_id: string;
    };
    assert.match(
      row.external_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('without an external_id it is NOT idempotent: every send is a new observation', () => {
    // The consequence of making it optional, and why ingest scripts are told to
    // always send one.
    const observations = [{ series: 'coffee', occurred_at: '2026-09-05T08:00:00Z', value: 1 }];
    ingest(db, observations);
    ingest(db, observations);

    assert.equal(count(db), 2);
  });
});

describe('local_date is computed by the server', () => {
  it('uses the server time zone, not UTC', () => {
    ingest(db, [
      { series: 'coffee', occurred_at: '2026-09-05T23:30:00Z', value: 1, external_id: 'late' },
    ]);

    assert.deepEqual(db.prepare('SELECT local_date FROM observations').get(), {
      local_date: '2026-09-06',
    });
  });

  it('ignores a local_date sent by the client', () => {
    ingest(db, [
      {
        series: 'coffee',
        occurred_at: '2026-09-05T23:30:00Z',
        value: 1,
        external_id: 'lie',
        local_date: '1999-01-01',
      } as never,
    ]);

    assert.deepEqual(db.prepare('SELECT local_date FROM observations').get(), {
      local_date: '2026-09-06',
    });
  });

  it('the same UTC wall time falls on the same day either side of the DST change', () => {
    ingest(db, [
      { series: 'coffee', occurred_at: '2026-10-24T22:30:00Z', value: 1, external_id: 'a' },
      { series: 'coffee', occurred_at: '2026-10-25T22:30:00Z', value: 1, external_id: 'b' },
    ]);

    const days = db
      .prepare('SELECT local_date FROM observations ORDER BY external_id')
      .all()
      .map((row) => (row as { local_date: string }).local_date);
    assert.deepEqual(days, ['2026-10-25', '2026-10-25']);
  });
});

describe('source comes from the token, never from the payload', () => {
  it('a source in the body is discarded', () => {
    ingestObservations(db, {
      source: 'tests',
      timeZone: TZ,
      observations: [
        {
          series: 'coffee',
          occurred_at: '2026-09-05T08:00:00Z',
          value: 1,
          external_id: 'x',
          source: 'opengym',
        } as never,
      ],
    });

    assert.deepEqual(db.prepare('SELECT source FROM observations').get(), { source: 'tests' });
  });
});

describe('unknown series are reported and the rest goes through', () => {
  it('does not blow up the batch', () => {
    const result = ingest(db, [
      { series: 'coffee', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'a' },
      { series: 'invented', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'b' },
      { series: 'weight', occurred_at: '2026-09-05T07:00:00Z', value: 74, external_id: 'c' },
    ]);

    assert.deepEqual(result, { inserted: 2, updated: 0, series_desconocidas: ['invented'] });
    assert.equal(count(db), 2);
  });

  it('each unknown slug is reported once and sorted', () => {
    const result = ingest(db, [
      { series: 'zulu', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'a' },
      { series: 'alpha', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'b' },
      { series: 'zulu', occurred_at: '2026-09-05T09:00:00Z', value: 1, external_id: 'c' },
    ]);

    assert.deepEqual(result, {
      inserted: 0,
      updated: 0,
      series_desconocidas: ['alpha', 'zulu'],
    });
    assert.equal(count(db), 0);
  });
});

describe('value is stored according to the series value_type', () => {
  it('bool accepts booleans and 0/1, and stores 0/1 in value_num', () => {
    ingest(db, [
      { series: 'coffee', occurred_at: '2026-09-05T08:00:00Z', value: true, external_id: 'a' },
      { series: 'coffee', occurred_at: '2026-09-05T09:00:00Z', value: false, external_id: 'b' },
      { series: 'coffee', occurred_at: '2026-09-05T10:00:00Z', value: 1, external_id: 'c' },
    ]);

    const values = db
      .prepare('SELECT value_num FROM observations ORDER BY external_id')
      .all()
      .map((row) => (row as { value_num: number }).value_num);
    assert.deepEqual(values, [1, 0, 1]);
  });

  it('text goes to value_text and leaves value_num null', () => {
    ingest(db, [
      { series: 'notes', occurred_at: '2026-09-05T08:00:00Z', value: 'good day', external_id: 'n' },
    ]);

    assert.deepEqual(db.prepare('SELECT value_num, value_text FROM observations').get(), {
      value_num: null,
      value_text: 'good day',
    });
  });

  it('a mismatched type aborts the whole batch', () => {
    assert.throws(
      () =>
        ingest(db, [
          { series: 'coffee', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'a' },
          { series: 'weight', occurred_at: '2026-09-05T08:00:00Z', value: 'heavy', external_id: 'b' },
        ]),
      IngestValidationError,
    );

    // The transaction rolls back the good observation that came first too.
    assert.equal(count(db), 0);
  });

  it('rejects negative durations', () => {
    assert.throws(
      () =>
        ingest(db, [
          { series: 'sleep', occurred_at: '2026-09-05T08:00:00Z', value: -60, external_id: 'a' },
        ]),
      IngestValidationError,
    );
  });
});

describe('the transaction wraps the whole batch', () => {
  it('a failure halfway through writes nothing', () => {
    ingest(db, [
      { series: 'coffee', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'earlier' },
    ]);

    assert.throws(() =>
      ingest(db, [
        { series: 'coffee', occurred_at: '2026-09-06T08:00:00Z', value: 1, external_id: 'new' },
        { series: 'notes', occurred_at: '2026-09-06T08:00:00Z', value: 999, external_id: 'bad' },
      ]),
    );

    assert.equal(count(db), 1);
    assert.equal(count(db, "SELECT COUNT(*) n FROM observations WHERE external_id = 'new'"), 0);
  });

  it('an empty batch does nothing and answers zeroes', () => {
    assert.deepEqual(ingest(db, []), { inserted: 0, updated: 0, series_desconocidas: [] });
  });
});

describe('tokens', () => {
  it('only the hash is stored, never the token', () => {
    const { token } = mintToken(db, 'opengym');
    const row = db.prepare('SELECT token_hash FROM tokens WHERE source = ?').get('opengym') as {
      token_hash: string;
    };

    assert.notEqual(row.token_hash, token);
    assert.equal(row.token_hash, hashToken(token));
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  });

  it('a token resolves to its source', () => {
    const { token } = mintToken(db, 'opengym');
    assert.equal(findTokenIdentity(db, token)?.source, 'opengym');
  });

  it('each source has its own token and they do not cross', () => {
    const a = mintToken(db, 'opengym');
    const b = mintToken(db, 'jellyfin');

    assert.equal(findTokenIdentity(db, a.token)?.source, 'opengym');
    assert.equal(findTokenIdentity(db, b.token)?.source, 'jellyfin');
  });

  it('a made-up token does not authenticate', () => {
    mintToken(db, 'opengym');
    for (const bad of ['', 'x', 'a'.repeat(43)]) {
      assert.equal(findTokenIdentity(db, bad), null, JSON.stringify(bad));
    }
  });

  it('refuses a second token for the same source without --rotate', () => {
    mintToken(db, 'opengym');
    assert.throws(() => mintToken(db, 'opengym'), /--rotate/);
  });

  it('rotating invalidates the previous one', () => {
    const old = mintToken(db, 'opengym');
    const fresh = mintToken(db, 'opengym', true);

    assert.equal(findTokenIdentity(db, old.token), null);
    assert.equal(findTokenIdentity(db, fresh.token)?.source, 'opengym');
    assert.equal(count(db, 'SELECT COUNT(*) n FROM tokens'), 1);
  });

  it('parseBearer accepts any casing of the scheme and rejects the rest', () => {
    assert.equal(parseBearer('Bearer abc'), 'abc');
    assert.equal(parseBearer('bearer abc'), 'abc');
    assert.equal(parseBearer('  Bearer   abc  '), 'abc');
    for (const bad of [undefined, '', 'abc', 'Basic abc', 'Bearer', 'Bearer a b']) {
      assert.equal(parseBearer(bad), null, JSON.stringify(bad));
    }
  });

  it('authenticateBearer records last_used_at', () => {
    const { token } = mintToken(db, 'opengym');
    assert.deepEqual(db.prepare('SELECT last_used_at FROM tokens').get(), { last_used_at: null });

    assert.equal(authenticateBearer(db, `Bearer ${token}`)?.source, 'opengym');

    const after = db.prepare('SELECT last_used_at FROM tokens').get() as { last_used_at: string };
    assert.match(after.last_used_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('no header means no authentication and no touch to last_used_at', () => {
    mintToken(db, 'opengym');
    assert.equal(authenticateBearer(db, undefined), null);
    assert.deepEqual(db.prepare('SELECT last_used_at FROM tokens').get(), { last_used_at: null });
  });
});
