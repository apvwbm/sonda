import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { beforeEach, describe, it } from 'node:test';
import {
  authenticateBearer,
  findTokenIdentity,
  hashToken,
  mintToken,
  parseBearer,
} from '../src/auth/token.ts';
import type { Db } from '../src/db/index.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { ingestObservations, IngestValidationError } from '../src/routes/observations.ts';

const TZ = 'Europe/Madrid';

/** Base temporal en memoria: se migra igual que la real y muere con el proceso. */
function baseTemporal(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  db.prepare(
    `INSERT INTO series (slug, name, value_type, unit, aggregation, created_at) VALUES
       ('cafe', 'Cafes', 'bool', NULL, 'count', '2026-01-01T00:00:00Z'),
       ('peso', 'Peso', 'number', 'kg', 'avg', '2026-01-01T00:00:00Z'),
       ('sueno', 'Sueno', 'duration', 'min', 'sum', '2026-01-01T00:00:00Z'),
       ('notas', 'Notas', 'text', NULL, 'last', '2026-01-01T00:00:00Z')`,
  ).run();

  return db;
}

type Observations = Parameters<typeof ingestObservations>[1]['observations'];

const ingesta = (db: Db, observations: Observations) =>
  ingestObservations(db, { source: 'pruebas', timeZone: TZ, observations });

const contar = (db: Db, sql = 'SELECT COUNT(*) n FROM observations') =>
  (db.prepare(sql).get() as { n: number }).n;

let db: Db;
beforeEach(() => {
  db = baseTemporal();
});

describe('idempotencia: reenviar es corregir, no duplicar', () => {
  const lote = [
    {
      series: 'cafe',
      occurred_at: '2026-09-05T08:12:00Z',
      value: 1,
      external_id: 'cafe-2026-09-05-1',
    },
    {
      series: 'peso',
      occurred_at: '2026-09-05T07:30:00Z',
      value: 74.2,
      external_id: 'peso-2026-09-05',
    },
  ];

  it('el mismo lote dos veces deja las mismas filas', () => {
    assert.deepEqual(ingesta(db, lote), {
      inserted: 2,
      updated: 0,
      series_desconocidas: [],
    });

    assert.deepEqual(ingesta(db, lote), {
      inserted: 0,
      updated: 2,
      series_desconocidas: [],
    });

    assert.equal(contar(db), 2);
  });

  it('el caso del plan: una fila nueva y una corregida en el mismo lote', () => {
    ingesta(db, [lote[0]!]);

    assert.deepEqual(ingesta(db, lote), {
      inserted: 1,
      updated: 1,
      series_desconocidas: [],
    });
    assert.equal(contar(db), 2);
  });

  it('reenviar 30 dias enteros no duplica nada', () => {
    const treintaDias = Array.from({ length: 30 }, (_, i) => ({
      series: 'cafe',
      occurred_at: `2026-09-${String(i + 1).padStart(2, '0')}T08:00:00Z`,
      value: 1,
      external_id: `cafe-dia-${i + 1}`,
    }));

    assert.equal(ingesta(db, treintaDias).inserted, 30);
    assert.equal(ingesta(db, treintaDias).updated, 30);
    assert.equal(ingesta(db, treintaDias).updated, 30);
    assert.equal(contar(db), 30);
  });

  it('en conflicto hace UPDATE, no IGNORE: el valor nuevo pisa al viejo', () => {
    ingesta(db, [
      { series: 'peso', occurred_at: '2026-09-05T07:30:00Z', value: 74.2, external_id: 'p1' },
    ]);
    ingesta(db, [
      { series: 'peso', occurred_at: '2026-09-05T07:30:00Z', value: 73.8, external_id: 'p1' },
    ]);

    const fila = db.prepare('SELECT value_num FROM observations WHERE external_id = ?').get('p1');
    assert.deepEqual(fila, { value_num: 73.8 });
    assert.equal(contar(db), 1);
  });

  it('una correccion no reescribe created_at, pero si occurred_at y local_date', () => {
    ingesta(db, [
      { series: 'cafe', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'c1' },
    ]);
    const antes = db
      .prepare('SELECT created_at FROM observations WHERE external_id = ?')
      .get('c1') as { created_at: string };

    ingesta(db, [
      { series: 'cafe', occurred_at: '2026-09-05T23:30:00Z', value: 0, external_id: 'c1' },
    ]);
    const despues = db
      .prepare(
        'SELECT created_at, occurred_at, local_date, value_num FROM observations WHERE external_id = ?',
      )
      .get('c1') as {
      created_at: string;
      occurred_at: string;
      local_date: string;
      value_num: number;
    };

    assert.equal(despues.created_at, antes.created_at);
    assert.equal(despues.occurred_at, '2026-09-05T23:30:00Z');
    assert.equal(despues.local_date, '2026-09-06');
    assert.equal(despues.value_num, 0);
  });

  it('el duplicado dentro del propio lote cuenta como update, no como dos filas', () => {
    const resultado = ingesta(db, [
      { series: 'cafe', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'repe' },
      { series: 'cafe', occurred_at: '2026-09-05T09:00:00Z', value: 0, external_id: 'repe' },
    ]);

    assert.deepEqual(resultado, { inserted: 1, updated: 1, series_desconocidas: [] });
    assert.equal(contar(db), 1);
  });

  it('el mismo external_id de otro source es otra fila: la unicidad es del par', () => {
    ingesta(db, [
      { series: 'cafe', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'x' },
    ]);
    ingestObservations(db, {
      source: 'otra-fuente',
      timeZone: TZ,
      observations: [
        { series: 'cafe', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'x' },
      ],
    });

    assert.equal(contar(db), 2);
  });
});

describe('external_id generado', () => {
  it('sin external_id el servidor pone un UUID', () => {
    ingesta(db, [{ series: 'cafe', occurred_at: '2026-09-05T08:00:00Z', value: 1 }]);

    const fila = db.prepare('SELECT external_id FROM observations').get() as {
      external_id: string;
    };
    assert.match(
      fila.external_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('sin external_id NO es idempotente: cada envio es una observacion nueva', () => {
    // Es la consecuencia de dejarlo opcional, y por eso el plan pide mandarlo
    // siempre desde los scripts de ingesta.
    const obs = [{ series: 'cafe', occurred_at: '2026-09-05T08:00:00Z', value: 1 }];
    ingesta(db, obs);
    ingesta(db, obs);

    assert.equal(contar(db), 2);
  });
});

describe('local_date lo calcula el servidor', () => {
  it('usa la zona del servidor, no UTC', () => {
    ingesta(db, [
      { series: 'cafe', occurred_at: '2026-09-05T23:30:00Z', value: 1, external_id: 'tarde' },
    ]);

    assert.deepEqual(db.prepare('SELECT local_date FROM observations').get(), {
      local_date: '2026-09-06',
    });
  });

  it('ignora el local_date que mande el cliente', () => {
    ingesta(db, [
      {
        series: 'cafe',
        occurred_at: '2026-09-05T23:30:00Z',
        value: 1,
        external_id: 'mentira',
        local_date: '1999-01-01',
      } as never,
    ]);

    assert.deepEqual(db.prepare('SELECT local_date FROM observations').get(), {
      local_date: '2026-09-06',
    });
  });

  it('la misma hora UTC cae el mismo dia a un lado y otro del cambio de hora', () => {
    ingesta(db, [
      { series: 'cafe', occurred_at: '2026-10-24T22:30:00Z', value: 1, external_id: 'a' },
      { series: 'cafe', occurred_at: '2026-10-25T22:30:00Z', value: 1, external_id: 'b' },
    ]);

    const dias = db
      .prepare('SELECT local_date FROM observations ORDER BY external_id')
      .all()
      .map((f) => (f as { local_date: string }).local_date);
    assert.deepEqual(dias, ['2026-10-25', '2026-10-25']);
  });
});

describe('el source sale del token, nunca del payload', () => {
  it('un source en el cuerpo se descarta', () => {
    ingestObservations(db, {
      source: 'pruebas',
      timeZone: TZ,
      observations: [
        {
          series: 'cafe',
          occurred_at: '2026-09-05T08:00:00Z',
          value: 1,
          external_id: 'x',
          source: 'opengym',
        } as never,
      ],
    });

    assert.deepEqual(db.prepare('SELECT source FROM observations').get(), { source: 'pruebas' });
  });
});

describe('series desconocidas: se reportan y el resto entra', () => {
  it('no revienta el lote', () => {
    const resultado = ingesta(db, [
      { series: 'cafe', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'a' },
      { series: 'inventada', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'b' },
      { series: 'peso', occurred_at: '2026-09-05T07:00:00Z', value: 74, external_id: 'c' },
    ]);

    assert.deepEqual(resultado, {
      inserted: 2,
      updated: 0,
      series_desconocidas: ['inventada'],
    });
    assert.equal(contar(db), 2);
  });

  it('cada slug desconocido se reporta una sola vez y ordenado', () => {
    const resultado = ingesta(db, [
      { series: 'zeta', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'a' },
      { series: 'alfa', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'b' },
      { series: 'zeta', occurred_at: '2026-09-05T09:00:00Z', value: 1, external_id: 'c' },
    ]);

    assert.deepEqual(resultado, {
      inserted: 0,
      updated: 0,
      series_desconocidas: ['alfa', 'zeta'],
    });
    assert.equal(contar(db), 0);
  });
});

describe('el value se guarda segun el value_type de la serie', () => {
  it('bool acepta booleanos y 0/1, y guarda 0/1 en value_num', () => {
    ingesta(db, [
      { series: 'cafe', occurred_at: '2026-09-05T08:00:00Z', value: true, external_id: 'a' },
      { series: 'cafe', occurred_at: '2026-09-05T09:00:00Z', value: false, external_id: 'b' },
      { series: 'cafe', occurred_at: '2026-09-05T10:00:00Z', value: 1, external_id: 'c' },
    ]);

    const valores = db
      .prepare('SELECT value_num FROM observations ORDER BY external_id')
      .all()
      .map((f) => (f as { value_num: number }).value_num);
    assert.deepEqual(valores, [1, 0, 1]);
  });

  it('text va a value_text y deja value_num a null', () => {
    ingesta(db, [
      { series: 'notas', occurred_at: '2026-09-05T08:00:00Z', value: 'buen dia', external_id: 'n' },
    ]);

    assert.deepEqual(db.prepare('SELECT value_num, value_text FROM observations').get(), {
      value_num: null,
      value_text: 'buen dia',
    });
  });

  it('un tipo que no cuadra aborta el lote entero', () => {
    assert.throws(
      () =>
        ingesta(db, [
          { series: 'cafe', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'a' },
          { series: 'peso', occurred_at: '2026-09-05T08:00:00Z', value: 'gordo', external_id: 'b' },
        ]),
      IngestValidationError,
    );

    // La transaccion revierte tambien la observacion buena que iba delante.
    assert.equal(contar(db), 0);
  });

  it('rechaza duraciones negativas', () => {
    assert.throws(
      () =>
        ingesta(db, [
          { series: 'sueno', occurred_at: '2026-09-05T08:00:00Z', value: -60, external_id: 'a' },
        ]),
      IngestValidationError,
    );
  });
});

describe('la transaccion envuelve el lote entero', () => {
  it('un fallo a mitad no deja nada escrito', () => {
    ingesta(db, [
      { series: 'cafe', occurred_at: '2026-09-05T08:00:00Z', value: 1, external_id: 'previo' },
    ]);

    assert.throws(() =>
      ingesta(db, [
        { series: 'cafe', occurred_at: '2026-09-06T08:00:00Z', value: 1, external_id: 'nuevo' },
        { series: 'notas', occurred_at: '2026-09-06T08:00:00Z', value: 999, external_id: 'malo' },
      ]),
    );

    // Solo sobrevive lo de la transaccion anterior.
    assert.equal(contar(db), 1);
    assert.equal(
      contar(db, "SELECT COUNT(*) n FROM observations WHERE external_id = 'nuevo'"),
      0,
    );
  });

  it('un lote vacio no hace nada y responde ceros', () => {
    assert.deepEqual(ingesta(db, []), { inserted: 0, updated: 0, series_desconocidas: [] });
  });
});

describe('tokens', () => {
  it('en la base solo queda el hash, nunca el token', () => {
    const { token } = mintToken(db, 'opengym');
    const fila = db.prepare('SELECT token_hash FROM tokens WHERE source = ?').get('opengym') as {
      token_hash: string;
    };

    assert.notEqual(fila.token_hash, token);
    assert.equal(fila.token_hash, hashToken(token));
    assert.match(fila.token_hash, /^[0-9a-f]{64}$/);
  });

  it('el token devuelve su source', () => {
    const { token } = mintToken(db, 'opengym');
    assert.equal(findTokenIdentity(db, token)?.source, 'opengym');
  });

  it('cada source tiene su token y no se cruzan', () => {
    const a = mintToken(db, 'opengym');
    const b = mintToken(db, 'jellyfin');

    assert.equal(findTokenIdentity(db, a.token)?.source, 'opengym');
    assert.equal(findTokenIdentity(db, b.token)?.source, 'jellyfin');
  });

  it('un token inventado no autentica', () => {
    mintToken(db, 'opengym');
    for (const malo of ['', 'x', 'a'.repeat(43)]) {
      assert.equal(findTokenIdentity(db, malo), null, JSON.stringify(malo));
    }
  });

  it('no deja dos tokens para el mismo source sin --rotate', () => {
    mintToken(db, 'opengym');
    assert.throws(() => mintToken(db, 'opengym'), /--rotate/);
  });

  it('rotar invalida el anterior', () => {
    const viejo = mintToken(db, 'opengym');
    const nuevo = mintToken(db, 'opengym', true);

    assert.equal(findTokenIdentity(db, viejo.token), null);
    assert.equal(findTokenIdentity(db, nuevo.token)?.source, 'opengym');
    assert.equal(contar(db, 'SELECT COUNT(*) n FROM tokens'), 1);
  });

  it('parseBearer acepta el esquema en cualquier caja y rechaza el resto', () => {
    assert.equal(parseBearer('Bearer abc'), 'abc');
    assert.equal(parseBearer('bearer abc'), 'abc');
    assert.equal(parseBearer('  Bearer   abc  '), 'abc');
    for (const malo of [undefined, '', 'abc', 'Basic abc', 'Bearer', 'Bearer a b']) {
      assert.equal(parseBearer(malo), null, JSON.stringify(malo));
    }
  });

  it('authenticateBearer actualiza last_used_at', () => {
    const { token } = mintToken(db, 'opengym');
    assert.deepEqual(db.prepare('SELECT last_used_at FROM tokens').get(), { last_used_at: null });

    assert.equal(authenticateBearer(db, `Bearer ${token}`)?.source, 'opengym');

    const despues = db.prepare('SELECT last_used_at FROM tokens').get() as {
      last_used_at: string;
    };
    assert.match(despues.last_used_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('sin cabecera no autentica y no toca last_used_at', () => {
    mintToken(db, 'opengym');
    assert.equal(authenticateBearer(db, undefined), null);
    assert.deepEqual(db.prepare('SELECT last_used_at FROM tokens').get(), { last_used_at: null });
  });
});
