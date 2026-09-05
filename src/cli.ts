/**
 * Utilidades de administración que tienen que existir dentro del contenedor.
 *
 *   node dist/cli.js token --source opengym [--rotate]
 *
 * Vive en src/ y no en scripts/ precisamente para que compile a dist/ y viaje
 * en la imagen de Docker: sin esto, acuñar un token en producción obligaría a
 * abrir la base a mano, porque la tabla solo guarda el hash.
 */
import { mintToken } from './auth/token.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/index.ts';
import { runMigrations } from './db/migrate.ts';
import { sourceSchema } from './lib/schemas.ts';

const USO = `Uso:
  node dist/cli.js token --source <nombre> [--rotate]

Subcomandos:
  token    Crea el token de ingesta de un source y lo imprime una sola vez.
           --rotate reemplaza el token existente; el anterior deja de valer.`;

function valorDe(argv: string[], bandera: string): string | undefined {
  const indice = argv.indexOf(bandera);
  if (indice === -1) return undefined;

  const valor = argv[indice + 1];
  return valor === undefined || valor.startsWith('--') ? undefined : valor;
}

function comandoToken(argv: string[]): void {
  const source = valorDe(argv, '--source');
  if (source === undefined) {
    throw new Error(`Falta --source.\n\n${USO}`);
  }

  const parsed = sourceSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`source inválido: ${parsed.error.issues[0]?.message ?? 'no vale'}`);
  }

  const db = openDatabase(loadConfig());
  runMigrations(db);

  const minted = mintToken(db, parsed.data, argv.includes('--rotate'));
  db.close();

  console.log(`\nsource: ${minted.source}`);
  console.log(`token:  ${minted.token}\n`);
  console.log('Guárdalo ahora: en la base solo queda el hash y no se puede volver a leer.');
  if (minted.rotated) {
    console.log('El token anterior de este source ha dejado de funcionar.');
  }
}

function main(argv: string[]): void {
  const [subcomando, ...resto] = argv;

  switch (subcomando) {
    case 'token':
      comandoToken(resto);
      return;
    case undefined:
    case '--help':
    case '-h':
      console.log(USO);
      return;
    default:
      throw new Error(`Subcomando desconocido: '${subcomando}'.\n\n${USO}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
