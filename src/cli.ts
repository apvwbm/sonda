/**
 * Administrative commands that have to exist inside the container.
 *
 *   node dist/cli.js token --source opengym [--rotate]
 *
 * This lives in src/ rather than scripts/ precisely so it compiles into dist/
 * and ships in the image. Without it, minting a token in production would mean
 * editing the database by hand, because the table only stores the hash.
 */
import { mintToken } from './auth/token.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/index.ts';
import { runMigrations } from './db/migrate.ts';
import { sourceSchema } from './lib/schemas.ts';

const USAGE = `Usage:
  node dist/cli.js token --source <name> [--rotate]

Commands:
  token    Create the ingest token for a source and print it exactly once.
           --rotate replaces an existing token; the old one stops working.`;

function valueOf(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;

  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function tokenCommand(argv: string[]): void {
  const source = valueOf(argv, '--source');
  if (source === undefined) {
    throw new Error(`Missing --source.\n\n${USAGE}`);
  }

  const parsed = sourceSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid source: ${parsed.error.issues[0]?.message ?? 'rejected'}`);
  }

  const db = openDatabase(loadConfig());
  runMigrations(db);

  const minted = mintToken(db, parsed.data, argv.includes('--rotate'));
  db.close();

  console.log(`\nsource: ${minted.source}`);
  console.log(`token:  ${minted.token}\n`);
  console.log('Store it now: only the hash is kept and it cannot be read back.');
  if (minted.rotated) {
    console.log('The previous token for this source has stopped working.');
  }
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;

  switch (command) {
    case 'token':
      tokenCommand(rest);
      return;
    case undefined:
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    default:
      throw new Error(`Unknown command: '${command}'.\n\n${USAGE}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
