/**
 * Datos falsos para tener algo que consultar en desarrollo.
 *
 *   npm run seed
 *
 * Entra por ingestObservations, la misma función que la API, con external_id
 * derivado del día: correrlo dos veces no duplica nada, solo actualiza. Y los
 * valores salen de un generador con semilla fija, así que dos máquinas
 * distintas ven exactamente los mismos números.
 */
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/db/index.ts';
import { runMigrations } from '../src/db/migrate.ts';
import type { ObservationInput } from '../src/lib/schemas.ts';
import { ingestObservations } from '../src/routes/observations.ts';

const DIAS = 90;
const SOURCE = 'seed';

const SERIES = [
  { slug: 'cafe', name: 'Cafes', value_type: 'bool', unit: null, aggregation: 'count' },
  { slug: 'peso', name: 'Peso', value_type: 'number', unit: 'kg', aggregation: 'avg' },
  { slug: 'pasos', name: 'Pasos', value_type: 'number', unit: 'pasos', aggregation: 'sum' },
  { slug: 'sueno', name: 'Sueno', value_type: 'duration', unit: 'min', aggregation: 'avg' },
  { slug: 'animo', name: 'Animo', value_type: 'text', unit: null, aggregation: 'last' },
] as const;

const ANIMOS = ['mal', 'regular', 'bien', 'muy bien'];

/** mulberry32: pseudoaleatorio con semilla, para que el seed sea reproducible. */
function generador(semilla: number): () => number {
  let estado = semilla;
  return () => {
    estado = (estado + 0x6d2b79f5) | 0;
    let t = Math.imul(estado ^ (estado >>> 15), 1 | estado);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const azar = generador(20260905);
const entre = (min: number, max: number) => min + azar() * (max - min);
const entero = (min: number, max: number) => Math.floor(entre(min, max + 1));

function main(): void {
  const config = loadConfig();
  const db = openDatabase(config);
  runMigrations(db);

  const crear = db.prepare(
    `INSERT INTO series (slug, name, value_type, unit, aggregation, created_at)
     VALUES (@slug, @name, @value_type, @unit, @aggregation, @created_at)
     ON CONFLICT (slug) DO NOTHING`,
  );
  for (const serie of SERIES) {
    crear.run({ ...serie, created_at: new Date().toISOString() });
  }

  const observations: ObservationInput[] = [];
  const hoy = new Date();
  let peso = 76.5;

  for (let atras = DIAS - 1; atras >= 0; atras -= 1) {
    const dia = new Date(hoy);
    dia.setUTCDate(dia.getUTCDate() - atras);
    const fecha = dia.toISOString().slice(0, 10);
    const a = (hora: number, minuto = 0) =>
      `${fecha}T${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}:00Z`;

    // Cafes: entre cero y tres al día, cada uno su propia observación.
    for (let n = 0; n < entero(0, 3); n += 1) {
      observations.push({
        series: 'cafe',
        occurred_at: a(8 + n * 3, entero(0, 59)),
        value: true,
        external_id: `cafe-${fecha}-${n}`,
      });
    }

    // Peso: paseo aleatorio con tendencia suave a la baja, y algunos días sin pesarse.
    peso = Math.max(70, peso + entre(-0.35, 0.3));
    if (azar() > 0.2) {
      observations.push({
        series: 'peso',
        occurred_at: a(7, entero(0, 45)),
        value: Number(peso.toFixed(1)),
        external_id: `peso-${fecha}`,
      });
    }

    // Pasos: dos parciales al día, para que 'sum' tenga algo que sumar.
    for (const [n, hora] of [14, 22].entries()) {
      observations.push({
        series: 'pasos',
        occurred_at: a(hora, entero(0, 59)),
        value: entero(1500, 7000),
        external_id: `pasos-${fecha}-${n}`,
      });
    }

    // Sueno: en segundos, que es lo que guarda la columna.
    observations.push({
      series: 'sueno',
      occurred_at: a(7, 30),
      value: entero(5 * 3600, 9 * 3600),
      external_id: `sueno-${fecha}`,
    });

    // Animo: no todos los días, para que haya buckets vacíos de verdad.
    if (azar() > 0.35) {
      observations.push({
        series: 'animo',
        occurred_at: a(22, entero(0, 59)),
        value: ANIMOS[entero(0, ANIMOS.length - 1)]!,
        external_id: `animo-${fecha}`,
      });
    }
  }

  // ingestObservations impone el tope de 1000 por lote en la API; aquí se
  // trocea igual para no inventarse un camino distinto al de producción.
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < observations.length; i += 1000) {
    const resultado = ingestObservations(db, {
      source: SOURCE,
      timeZone: config.SONDA_TZ,
      observations: observations.slice(i, i + 1000),
    });
    inserted += resultado.inserted;
    updated += resultado.updated;
  }

  db.close();

  console.log(`series:       ${SERIES.map((s) => s.slug).join(', ')}`);
  console.log(`dias:         ${DIAS}`);
  console.log(`observaciones: ${inserted} nuevas, ${updated} actualizadas`);
  console.log(`\nVuelve a lanzarlo y no duplicara nada: los external_id son fijos.`);
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
