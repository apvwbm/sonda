/**
 * Fake data, so there is something to query while developing.
 *
 *   npm run seed             brings the seed's own data up to date
 *   npm run seed -- --reset  wipes series and observations, then recreates them
 *
 * Everything goes in through ingestObservations, the same function the API
 * uses, with external_ids derived from the day. Running it twice inserts
 * nothing new. Values come from a seeded generator, so two machines produce
 * exactly the same numbers.
 *
 * This script is deliberately kept out of the Docker image.
 */
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/db/index.ts';
import { runMigrations } from '../src/db/migrate.ts';
import type { ObservationInput } from '../src/lib/schemas.ts';
import { MAX_BATCH } from '../src/lib/schemas.ts';
import { ingestObservations } from '../src/routes/observations.ts';

const DAYS = 90;
const SOURCE = 'seed';

const SERIES = [
  { slug: 'coffee', name: 'Coffees', value_type: 'bool', unit: null, aggregation: 'count' },
  { slug: 'weight', name: 'Weight', value_type: 'number', unit: 'kg', aggregation: 'avg' },
  { slug: 'steps', name: 'Steps', value_type: 'number', unit: 'steps', aggregation: 'sum' },
  { slug: 'sleep', name: 'Sleep', value_type: 'duration', unit: 'min', aggregation: 'avg' },
  { slug: 'mood', name: 'Mood', value_type: 'text', unit: null, aggregation: 'last' },
] as const;

const MOODS = ['bad', 'so-so', 'good', 'great'];

/** mulberry32: seeded PRNG, so the generated data is reproducible. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = generator(20260905);
const between = (min: number, max: number) => min + random() * (max - min);
const integer = (min: number, max: number) => Math.floor(between(min, max + 1));

function main(): void {
  const reset = process.argv.includes('--reset');
  const config = loadConfig();
  const db = openDatabase(config);
  runMigrations(db);

  /*
   * --reset leaves the database holding the seed and nothing else, which is
   * what reseeding a public demo from a timer needs: the 90-day window moves
   * with the calendar, and whatever visitors created is cleared out too.
   *
   * Tokens are left alone: they belong to the operator, not to the demo data.
   */
  if (reset) {
    db.transaction(() => {
      db.prepare('DELETE FROM observations').run();
      db.prepare('DELETE FROM series').run();
    })();
  }

  const createSeries = db.prepare(
    `INSERT INTO series (slug, name, value_type, unit, aggregation, created_at)
     VALUES (@slug, @name, @value_type, @unit, @aggregation, @created_at)
     ON CONFLICT (slug) DO NOTHING`,
  );
  for (const series of SERIES) {
    createSeries.run({ ...series, created_at: new Date().toISOString() });
  }

  const observations: ObservationInput[] = [];
  const today = new Date();
  let weight = 76.5;

  for (let back = DAYS - 1; back >= 0; back -= 1) {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() - back);
    const date = day.toISOString().slice(0, 10);
    const at = (hour: number, minute = 0) =>
      `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;

    for (let n = 0; n < integer(0, 3); n += 1) {
      observations.push({
        series: 'coffee',
        occurred_at: at(8 + n * 3, integer(0, 59)),
        value: true,
        external_id: `coffee-${date}-${n}`,
      });
    }

    // A random walk with a mild downward drift, and some days with no weigh-in.
    weight = Math.max(70, weight + between(-0.35, 0.3));
    if (random() > 0.2) {
      observations.push({
        series: 'weight',
        occurred_at: at(7, integer(0, 45)),
        value: Number(weight.toFixed(1)),
        external_id: `weight-${date}`,
      });
    }

    // Two partial readings a day, so 'sum' has something to add up.
    for (const [n, hour] of [14, 22].entries()) {
      observations.push({
        series: 'steps',
        occurred_at: at(hour, integer(0, 59)),
        value: integer(1500, 7000),
        external_id: `steps-${date}-${n}`,
      });
    }

    observations.push({
      series: 'sleep',
      occurred_at: at(7, 30),
      // In seconds, which is what the column stores.
      value: integer(5 * 3600, 9 * 3600),
      external_id: `sleep-${date}`,
    });

    // Not every day, so that empty buckets genuinely occur.
    if (random() > 0.35) {
      observations.push({
        series: 'mood',
        occurred_at: at(22, integer(0, 59)),
        value: MOODS[integer(0, MOODS.length - 1)]!,
        external_id: `mood-${date}`,
      });
    }
  }

  // Chunked the same way the API caps a batch, rather than inventing a second
  // path that production never takes.
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < observations.length; i += MAX_BATCH) {
    const result = ingestObservations(db, {
      source: SOURCE,
      timeZone: config.SONDA_TZ,
      observations: observations.slice(i, i + MAX_BATCH),
    });
    inserted += result.inserted;
    updated += result.updated;
  }

  db.close();

  console.log(`mode:         ${reset ? 'reset (previous data was deleted)' : 'incremental'}`);
  console.log(`series:       ${SERIES.map((s) => s.slug).join(', ')}`);
  console.log(`days:         ${DAYS}`);
  console.log(`observations: ${inserted} inserted, ${updated} updated`);
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
