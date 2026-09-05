import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import cookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { SESSION_COOKIE, SOURCE_PUBLIC, createSessionValue } from '../src/auth/session.ts';
import { mintToken } from '../src/auth/token.ts';
import { loadConfig } from '../src/config.ts';
import type { Db } from '../src/db/index.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { exportRoutes } from '../src/routes/export.ts';
import { ingestObservations, observationsRoutes } from '../src/routes/observations.ts';
import { seriesRoutes } from '../src/routes/series.ts';
import { statsRoutes } from '../src/routes/stats.ts';

const SECRET = 'test-secret';
const TZ = 'Europe/Madrid';

const closers: Array<() => void> = [];
after(() => {
  for (const close of closers) close();
});

function temporaryDb(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    `INSERT INTO series (slug, name, value_type, unit, aggregation, created_at)
     VALUES ('steps', 'Steps', 'number', 'steps', 'sum', '2026-01-01T00:00:00Z')`,
  ).run();
  ingestObservations(db, {
    source: 'fixtures',
    timeZone: TZ,
    observations: [{ series: 'steps', occurred_at: '2026-09-01T10:00:00Z', value: 1200 }],
  });
  closers.push(() => db.close());
  return db;
}

interface Flags {
  read?: boolean;
  write?: boolean;
}

/**
 * The real route plugins on a real Fastify instance, so what is under test is
 * the guard each route actually carries, not a re-description of it.
 */
async function buildApp(flags: Flags = {}): Promise<FastifyInstance> {
  const dataDir = mkdtempSync(join(tmpdir(), 'sonda-public-'));
  closers.push(() => rmSync(dataDir, { recursive: true, force: true }));

  const app = Fastify();
  app.decorate('db', temporaryDb());
  app.decorate('sessionSecret', SECRET);
  app.decorate(
    'config',
    loadConfig({
      SONDA_DATA_DIR: dataDir,
      SONDA_TZ: TZ,
      SONDA_PASSWORD: 'x',
      SONDA_PUBLIC_READ: String(flags.read ?? false),
      SONDA_PUBLIC_WRITE: String(flags.write ?? false),
    }),
  );

  await app.register(cookie);
  await app.register(seriesRoutes);
  await app.register(observationsRoutes);
  await app.register(statsRoutes);
  await app.register(exportRoutes);
  await app.ready();
  closers.push(() => void app.close());

  return app;
}

const validCookie = () => ({ [SESSION_COOKIE]: createSessionValue(SECRET) });

/** The three reads, which SONDA_PUBLIC_READ opens. */
const READS = [
  { method: 'GET', url: '/api/series' },
  { method: 'GET', url: '/api/observations' },
  { method: 'GET', url: '/api/stats?series=steps&bucket=day' },
] as const;

/** The two creating endpoints, which SONDA_PUBLIC_WRITE opens. */
const CREATES = [
  {
    method: 'POST',
    url: '/api/series',
    payload: { slug: 'pushups', name: 'Push-ups', value_type: 'number', aggregation: 'sum' },
  },
  {
    method: 'POST',
    url: '/api/observations',
    payload: { observations: [{ series: 'steps', occurred_at: '2026-09-02T10:00:00Z', value: 1 }] },
  },
] as const;

/** Destructive or exfiltrating: closed under every flag, which is the point. */
const ALWAYS_CLOSED = [
  { method: 'PATCH', url: '/api/series/1', payload: { name: 'Renamed' } },
  { method: 'DELETE', url: '/api/observations/1' },
  { method: 'GET', url: '/api/export' },
] as const;

type Flag = 'SONDA_PUBLIC_READ' | 'SONDA_PUBLIC_WRITE';
const parseFlag = (name: Flag, value: string): boolean =>
  loadConfig({ SONDA_PASSWORD: 'x', [name]: value })[name];

describe('the public flags parse as booleans, not as truthy strings', () => {
  for (const name of ['SONDA_PUBLIC_READ', 'SONDA_PUBLIC_WRITE'] as const) {
    describe(name, () => {
      it('an environment that never mentions it parses to false', () => {
        assert.equal(loadConfig({ SONDA_PASSWORD: 'x' })[name], false);
      });

      it("reads 'false' and '0' as false, which z.coerce.boolean() would not", () => {
        assert.equal(parseFlag(name, 'false'), false);
        assert.equal(parseFlag(name, '0'), false);
      });

      it("accepts 'true' and '1'", () => {
        assert.equal(parseFlag(name, 'true'), true);
        assert.equal(parseFlag(name, '1'), true);
      });

      it('refuses anything else instead of guessing', () => {
        assert.throws(
          () => parseFlag(name, 'yes'),
          new RegExp(`${name}: must be 'true', 'false', '1' or '0'`),
        );
      });
    });
  }
});

describe('with both flags off, nothing changes', () => {
  it('every read still answers 401 without a cookie', async () => {
    const app = await buildApp();
    for (const route of READS) {
      assert.equal((await app.inject(route)).statusCode, 401, `${route.method} ${route.url}`);
    }
  });

  it('every read still answers 200 with a valid cookie', async () => {
    const app = await buildApp();
    for (const route of READS) {
      const response = await app.inject({ ...route, cookies: validCookie() });
      assert.equal(response.statusCode, 200, `${route.method} ${route.url}`);
    }
  });

  it('an expired cookie is still rejected', async () => {
    const app = await buildApp();
    // Issued far enough in the past that its own signed expiry has passed.
    const expired = createSessionValue(SECRET, Date.parse('2020-01-01T00:00:00Z'));
    const response = await app.inject({
      ...READS[0],
      cookies: { [SESSION_COOKIE]: expired },
    });
    assert.equal(response.statusCode, 401);
  });

  it('every write and the export still answer 401', async () => {
    const app = await buildApp();
    for (const route of [...CREATES, ...ALWAYS_CLOSED]) {
      assert.equal((await app.inject(route)).statusCode, 401, `${route.method} ${route.url}`);
    }
  });

  it('a bearer token still ingests, and still under its own source', async () => {
    const app = await buildApp();
    const { token } = mintToken(app.db, 'watch');

    const response = await app.inject({
      ...CREATES[1],
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);

    const source = app.db
      .prepare("SELECT source FROM observations WHERE local_date = '2026-09-02'")
      .get() as { source: string };
    assert.equal(source.source, 'watch');
  });
});

describe('SONDA_PUBLIC_READ opens the reads and only the reads', () => {
  it('the three reads answer without a cookie', async () => {
    const app = await buildApp({ read: true });
    for (const route of READS) {
      assert.equal((await app.inject(route)).statusCode, 200, `${route.method} ${route.url}`);
    }
  });

  it('the public reads return the real data, not an empty stub', async () => {
    const app = await buildApp({ read: true });

    const series = (await app.inject('/api/series')).json() as { series: Array<{ slug: string }> };
    assert.deepEqual(
      series.series.map((s) => s.slug),
      ['steps'],
    );

    const list = (await app.inject('/api/observations')).json() as {
      observations: Array<{ value: number }>;
    };
    assert.equal(list.observations.length, 1);
    assert.equal(list.observations[0]?.value, 1200);

    const stats = (await app.inject('/api/stats?series=steps&bucket=day')).json() as {
      buckets: Array<{ value: number }>;
    };
    assert.equal(stats.buckets[0]?.value, 1200);
  });

  it('reading in public does not let anyone write', async () => {
    const app = await buildApp({ read: true });
    for (const route of [...CREATES, ...ALWAYS_CLOSED]) {
      assert.equal((await app.inject(route)).statusCode, 401, `${route.method} ${route.url}`);
    }
  });

  it('a write left closed really did not write', async () => {
    const app = await buildApp({ read: true });
    await app.inject(CREATES[1]);

    const list = (await app.inject('/api/observations')).json() as { observations: unknown[] };
    assert.equal(list.observations.length, 1);
  });
});

describe('SONDA_PUBLIC_WRITE opens the two creating endpoints', () => {
  it('POST /api/series and POST /api/observations answer without credentials', async () => {
    const app = await buildApp({ write: true });
    assert.equal((await app.inject(CREATES[0])).statusCode, 201);
    assert.equal((await app.inject(CREATES[1])).statusCode, 200);
  });

  it("an anonymous write is stored under the 'public' source", async () => {
    const app = await buildApp({ write: true });
    await app.inject(CREATES[1]);

    const row = app.db
      .prepare("SELECT source FROM observations WHERE local_date = '2026-09-02'")
      .get() as { source: string };
    assert.equal(row.source, SOURCE_PUBLIC);
  });

  it('a real token still wins, so its rows keep their own source', async () => {
    const app = await buildApp({ write: true });
    const { token } = mintToken(app.db, 'watch');

    await app.inject({ ...CREATES[1], headers: { authorization: `Bearer ${token}` } });

    const row = app.db
      .prepare("SELECT source FROM observations WHERE local_date = '2026-09-02'")
      .get() as { source: string };
    assert.equal(row.source, 'watch');
  });

  it('writing in public does not open the reads', async () => {
    const app = await buildApp({ write: true });
    for (const route of READS) {
      assert.equal((await app.inject(route)).statusCode, 401, `${route.method} ${route.url}`);
    }
  });

  it('PATCH, DELETE and the export stay closed', async () => {
    const app = await buildApp({ write: true });
    for (const route of ALWAYS_CLOSED) {
      assert.equal((await app.inject(route)).statusCode, 401, `${route.method} ${route.url}`);
    }
  });

  it('an anonymous visitor cannot delete what is already there', async () => {
    const app = await buildApp({ read: true, write: true });
    assert.equal((await app.inject(ALWAYS_CLOSED[1])).statusCode, 401);

    const list = (await app.inject('/api/observations')).json() as { observations: unknown[] };
    assert.equal(list.observations.length, 1);
  });
});
