# Sonda — plan del proyecto

> Almacén y API de datos personales, self-hosted.
> **Actualizado:** 2026-09-05 · **Estado:** contrato cerrado, sin código todavía.
> **Nombre provisional.** "Sonda" es cambiable. Aparece solo en cuatro sitios: `name` de `package.json`, prefijo `SONDA_` de las variables de entorno, nombre del fichero `sonda.db` y nombre de la imagen Docker. Renombrarlo es un buscar-y-reemplazar.

---

## 1. Qué es

Un registro de datos personales heterogéneos —hábitos, métricas, eventos— con captura manual **e ingesta automática desde otros servicios**. Open source, gratis, exclusivamente self-hosted. Sin versión cloud, sin pricing, sin cuentas externas.

Doble objetivo: herramienta de uso diario propio y pieza de portfolio que demuestre backend.

**La tesis del proyecto:** el registro manual se muere a las tres semanas. Es la razón por la que el nicho está lleno de repos abandonados: el autor dejó de usar su propia app. Si parte de las series se llenan solas, sigue habiendo datos cuando dejas de apuntar el café. Por eso la pieza central no es la interfaz, es la ingesta.

**Frontera de diseño, para no construir el monstruo:** no se construyen integraciones, se construye **una API de ingesta y un esquema**. Cada integración es un script de veinte líneas, propio o de contributors. Da frontera limpia, superficie de contribución sin tocar el core, y un problema real de diseño de API.

---

## 2. Posicionamiento

**No es un habit tracker.** El nicho de "simple, self-hosted habit tracker" está saturado —Beaver, Loop/uhabits, Kanso, MyDailies, Ritual y treinta más dicen exactamente eso— y compite en simplicidad, así que la simplicidad no diferencia. El hueco vacío es el de "track anything": Nomie era la referencia y cerró en febrero de 2023; el fork `open-nomie` lleva años sin tocarse.

**Descartado a propósito, y dicho en el README:**

- **Rachas y streaks.** Son gamificación con otro nombre, el mecanismo de culpa de Duolingo. Incompatibles con no querer motivación artificial. Cortarlas y decirlo es diferenciación real.
- **"Git for your life" como eslogan.** La metáfora no se sostiene: git es versionado, diffs y ramas; esto es un log append-only con agregaciones.

---

## 3. Decisiones cerradas

No reabrir ninguna de estas. Están decididas con argumentos y el argumento va al README.

| Decisión | Por qué |
|---|---|
| **SQLite, no Postgres** | Single-user y tiene que ir en una Raspberry Pi. Un fichero es la base de datos, el backup y el export a la vez. Postgres aquí sería decisión de currículum, no de arquitectura |
| **Node 22 + TypeScript** | Es el stack que ya se conoce. ~80-100 MB de RAM, que en una Pi entra de sobra |
| **Fastify + better-sqlite3** | `better-sqlite3` es síncrono: para un solo usuario es lo más rápido y lo más simple de leer |
| **Un contenedor, no dos** | Sin passkeys no hace falta nginx de mismo-origen. El frontend compilado se sirve desde el propio servidor Fastify |
| **Auth simple** | Contraseña + cookie de sesión firmada para la interfaz, token bearer aparte para la ingesta. Funciona sobre HTTP plano en LAN, que es como se prueba una app self-hosted el primer día. Expuesta a internet, detrás del proxy inverso del usuario, y así dicho en el README |
| **Migraciones embebidas** | Ficheros SQL dentro del proyecto, ejecutados al arrancar, versionados con `PRAGMA user_version`. Nunca pedirle al usuario que lance un comando de migración |

---

## 4. El contrato

Esto es lo que hay que construir. Las columnas y los endpoints son el acuerdo: cambiarlos después de tener datos dentro cuesta una migración.

### 4.1 Modelo de datos

Un solo concepto, no tres. Un hábito es una serie booleana, una métrica una serie numérica, un evento una serie con duración y texto opcional. Mismo motor.

```sql
CREATE TABLE series (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,          -- 'cafe', 'peso', 'sueno'
  name         TEXT NOT NULL,
  value_type   TEXT NOT NULL CHECK (value_type IN ('bool','number','duration','text')),
  unit         TEXT,                          -- 'kg', 'min', NULL
  aggregation  TEXT NOT NULL CHECK (aggregation IN ('sum','avg','last','count')),
  created_at   TEXT NOT NULL,                 -- ISO 8601 UTC
  archived_at  TEXT
);

CREATE TABLE observations (
  id           INTEGER PRIMARY KEY,
  series_id    INTEGER NOT NULL REFERENCES series(id),
  occurred_at  TEXT NOT NULL,                 -- instante ISO 8601 UTC
  local_date   TEXT NOT NULL,                 -- 'YYYY-MM-DD', calculado en el servidor
  value_num    REAL,                          -- bool como 0/1, número, duración en segundos
  value_text   TEXT,
  source       TEXT NOT NULL,                 -- 'manual', 'opengym', 'jellyfin'
  external_id  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (source, external_id)
);

CREATE INDEX idx_obs_series_date ON observations (series_id, local_date);

CREATE TABLE tokens (
  id           INTEGER PRIMARY KEY,
  source       TEXT NOT NULL UNIQUE,          -- el token queda atado a un 'source'
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
```

**Las tres decisiones que separan esto de un CRUD cualquiera.** Van al README:

**`local_date` aparte de `occurred_at`.** "¿He leído hoy?" es una pregunta de fecha local, no de instante UTC. Guardando solo UTC, quien se acuesta a las 2 de la mañana ve sus datos en el día equivocado y salen bugs de zona horaria para siempre. **Lo calcula el servidor al insertar**, a partir de `occurred_at` y de la variable `SONDA_TZ`. El cliente nunca lo manda.

**Constraint único `(source, external_id)`.** Es lo que hace la ingesta **idempotente**: un script puede reenviar los últimos 30 días sin duplicar nada. La decisión más valiosa del proyecto y cuesta una línea de migración. En conflicto se hace `UPDATE`, no se ignora, para que corregir un dato sea reenviarlo.

**`external_id` también en lo manual.** Una entrada manual sin `external_id` no se puede corregir por el mismo camino que las automáticas. El servidor le genera un UUID si no viene.

### 4.2 Endpoints

Prefijo `/api`. Todas las respuestas en JSON. Errores con `{ "error": "mensaje" }` y el código HTTP que toque.

**Autenticación:** cookie de sesión firmada para todo lo de la interfaz; `Authorization: Bearer <token>` para la ingesta. **El `source` no viaja en el payload: sale del token.** Así un script no puede escribir en nombre de otra fuente y el cliente no tiene que acordarse de mandarlo.

| Método | Ruta | Auth | Qué hace |
|---|---|---|---|
| `GET` | `/api/health` | ninguna | `{ "status": "ok", "version": "0.1.0" }` |
| `POST` | `/api/auth/login` | ninguna | Recibe `{ password }`, deja la cookie de sesión |
| `POST` | `/api/auth/logout` | cookie | Invalida la cookie |
| `GET` | `/api/series` | cookie o bearer | Lista de series, en `{ "series": [...] }` |
| `POST` | `/api/series` | cookie | Crea una serie |
| `PATCH` | `/api/series/:id` | cookie | Renombra o archiva |
| `POST` | `/api/observations` | cookie o bearer | **Ingesta por lotes, idempotente** |
| `GET` | `/api/observations` | cookie | Filtra por `series`, `from`, `to`. **Paginado por cursor** con `limit` y `cursor` |
| `DELETE` | `/api/observations/:id` | cookie | Borra una |
| `GET` | `/api/stats` | cookie | **Agregación por bucket de fecha local** |
| `GET` | `/api/export` | cookie | Devuelve el `.db` entero, generado con `VACUUM INTO` |

**Ingesta.** `POST /api/observations`, lote de hasta 1000:

```json
{
  "observations": [
    { "series": "cafe",  "occurred_at": "2026-09-05T08:12:00Z", "value": 1,
      "external_id": "cafe-2026-09-05-1" },
    { "series": "peso",  "occurred_at": "2026-09-05T07:30:00Z", "value": 74.2,
      "external_id": "peso-2026-09-05" }
  ]
}
```

Respuesta: `{ "inserted": 1, "updated": 1, "series_desconocidas": [] }`. Todo el lote en una transacción. Una serie que no existe no revienta el lote: se reporta y el resto entra.

**Paginación.** `GET /api/observations?series=peso&from=2026-01-01&to=2026-09-05&limit=200`

Devuelve `{ "observations": [...], "next_cursor": "..." }`, ordenado del más reciente al más antiguo. `next_cursor` es `null` en la última página; para pedir la siguiente se reenvía tal cual en `&cursor=`. `limit` por defecto 200, máximo 1000.

Es paginación por cursor y no por `OFFSET` a propósito: con `OFFSET`, una observación que entra mientras se está paginando desplaza las páginas siguientes y hace que se repitan o se salten filas. El cursor codifica la última posición leída del orden `(occurred_at, id)`, que es total y estable.

`from` y `to` recortan por `local_date`, igual que en `/api/stats`: preguntar «del 1 al 5 de septiembre» es una pregunta de días locales, y así los dos endpoints responden sobre el mismo rango.

**Consulta agregada.** `GET /api/stats?series=peso&bucket=week&from=2026-01-01&to=2026-09-05`

`bucket` es `day`, `week` o `month`, y agrupa por `local_date`, no por UTC. La función de agregación sale del campo `aggregation` de la serie. Respuesta:

```json
{
  "series": "peso",
  "aggregation": "avg",
  "unit": "kg",
  "buckets": [ { "date": "2026-08-31", "value": 74.4, "count": 5 } ]
}
```

Este endpoint es la parte más interesante técnicamente y la que se enseña en el portfolio. La ingesta es un `INSERT`; esto es agrupar por fecha local con SQL.

### 4.3 Variables de entorno

Con defaults que funcionan sin tocar nada.

| Variable | Default | Para qué |
|---|---|---|
| `SONDA_PORT` | `8080` | Escape hatch de puerto: el 8080 está ocupado en medio mundo |
| `SONDA_DATA_DIR` | `/data` | Un solo directorio con todo. En desarrollo, `./data` |
| `SONDA_TZ` | `Europe/Madrid` | Zona con la que se calcula `local_date` |
| `SONDA_PASSWORD` | — | Contraseña de la interfaz. Obligatoria |
| `SONDA_SESSION_SECRET` | — | Firma de la cookie. Se genera sola si falta y se guarda en `SONDA_DATA_DIR` |

---

## 5. Estructura del repo

```
sonda/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── Dockerfile
├── README.md
├── docs/
│   └── plan.md                 ← este fichero
├── src/
│   ├── index.ts                arranque: config → migraciones → servidor
│   ├── config.ts               lee y valida el entorno
│   ├── db/
│   │   ├── index.ts            conexión y PRAGMAs
│   │   ├── migrate.ts          runner por PRAGMA user_version
│   │   └── migrations/
│   │       └── 001_init.sql
│   ├── auth/
│   │   ├── session.ts          cookie firmada
│   │   └── token.ts            bearer → source
│   ├── routes/
│   │   ├── health.ts
│   │   ├── auth.ts
│   │   ├── series.ts
│   │   ├── observations.ts
│   │   ├── stats.ts
│   │   └── export.ts
│   └── lib/
│       ├── localdate.ts        occurred_at + TZ → YYYY-MM-DD
│       └── schemas.ts          validación con zod
├── scripts/
│   ├── mint-token.ts           crea un token de ingesta para un source
│   └── seed.ts                 datos falsos para desarrollo
├── test/
│   ├── localdate.test.ts
│   ├── idempotency.test.ts
│   └── stats.test.ts
└── web/                        vacío por ahora; Fastify sirve web/dist si existe
```

**PRAGMAs al abrir la base:** `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`, `synchronous = NORMAL`.

**Tests con `node:test`**, el runner que trae Node. No hace falta framework.

---

## 6. Cómo se prueba en local

Nada de esto toca el homelab. Todo en el portátil.

```bash
node --version                   # tiene que ser 22 o superior
npm install
cp .env.example .env             # editar SONDA_PASSWORD
npm run dev                      # arranca con --watch y la base en ./data/sonda.db
```

**Que arranca y migra:**
```bash
curl localhost:8080/api/health
sqlite3 data/sonda.db ".tables"          # series, observations, tokens
sqlite3 data/sonda.db "PRAGMA user_version;"
```

**Empezar de cero en cualquier momento:** `rm -rf data/` y volver a arrancar. Es la ventaja de que la base sea un fichero.

**Datos falsos para tener algo que consultar:**
```bash
npm run seed                     # crea unas series y ~90 días de observaciones
```

**La prueba que importa, la idempotencia.** Mandar dos veces lo mismo y que solo haya una fila:
```bash
npm run token -- --source pruebas          # imprime el token una sola vez
TOKEN=el_token_de_arriba

curl -X POST localhost:8080/api/observations \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"observations":[{"series":"cafe","occurred_at":"2026-09-05T08:12:00Z","value":1,"external_id":"prueba-1"}]}'

# repetir el mismo comando: debe responder updated:1, inserted:0
sqlite3 data/sonda.db "SELECT COUNT(*) FROM observations WHERE external_id='prueba-1';"   # 1
```

**La prueba de la fecha local.** Con `SONDA_TZ=Europe/Madrid`, una observación a las `2026-09-05T23:30:00Z` tiene que caer en `local_date = 2026-09-06`, porque en Madrid ya es día 6. Es un test unitario de `localdate.ts`, no hace falta servidor.

**Consulta agregada:**
```bash
curl "localhost:8080/api/stats?series=peso&bucket=week&from=2026-06-01&to=2026-09-05"
```

**Tests:**
```bash
npm test                         # base temporal, se borra al terminar
```

**Docker, solo al final y también en local:**
```bash
docker build -t sonda:dev .
docker run --rm -p 8080:8080 -v ./data:/data -e SONDA_PASSWORD=prueba sonda:dev
```
Si eso responde en `localhost:8080/api/health`, está listo para pensar en el homelab. Antes no.

---

## 7. Orden de trabajo

Una fase por sesión. No pasar a la siguiente sin que la anterior funcione.

1. **Esqueleto.** `package.json`, TypeScript, Fastify arrancando, `GET /api/health` respondiendo, `.env.example`, `.gitignore`. Nada más.
2. **Base de datos y migraciones.** Conexión con PRAGMAs, runner por `user_version`, `001_init.sql` con las tres tablas. Al arrancar dos veces seguidas no debe pasar nada raro.
3. **`localdate.ts` con sus tests.** Función pura, se prueba sola, y es la que más silenciosamente puede estar mal.
4. **Series.** `GET`, `POST`, `PATCH`. Con validación de zod.
5. **Ingesta.** `POST /api/observations` por lotes, en transacción, con el upsert por `(source, external_id)`. Tokens y `scripts/mint-token.ts`. Test de idempotencia.
6. **Auth de interfaz.** Login por contraseña y cookie firmada. Cerrar el resto de endpoints.
7. **Consulta.** `GET /api/observations` y `GET /api/stats` con los tres buckets. Test contra datos del seed.
8. **Export.** `GET /api/export` con `VACUUM INTO`.
9. **Docker.** Multi-stage sobre `node:22-alpine`, probado en local.
10. **Primera fuente real del homelab.** Un script en cron en la VM 100 que reenvíe los últimos 30 días. openGym es el mejor primer candidato: ya tiene servidor MCP de solo lectura sobre el log de entrenamiento. Otras candidatas: Immich, Jellyfin, stack arr.
11. **Captura manual.** Contra el mismo endpoint con el token de `source=manual`, desde un atajo del móvil. La interfaz decente viene después, y es trabajo de UI, no de arquitectura.

**La captura manual no es una rama alternativa a la ingesta: es una fuente de ingesta más.** Con el API bien hecho, un atajo de iOS ya es captura manual funcionando.

---

## 8. Lo que NO se construye

Multiusuario, passkeys, recordatorios y notificaciones (es la feature que lo convierte en el habit tracker que no se quiere), objetivos, rachas, gamificación en cualquier forma, cualquier vista que juzgue, IA, y integraciones dentro del core.

---

## 9. Trampas a documentar desde el día uno

- **No copiar un SQLite vivo con `cp`.** `VACUUM INTO` o la API de backup, o sale un fichero a medio escribir. Por eso `GET /api/export`.
- **SQLite no va en un recurso de red.** Ni NFS, ni SMB, ni virtiofs: el bloqueo de ficheros no es fiable y corrompe la base. Si no está en el README, llega el issue el primer mes.
- **Publicar versiones ancladas**, tags `vX.Y.Z` y CHANGELOG que diga qué migración corre cada versión. No solo `latest`.
- **Imágenes amd64 y arm64.** Sin el build de arm64, media del público (Pi, NAS) no puede instalar.
- **Todo en `./data`, un solo bind mount.** Backup = `tar` de una carpeta.
- **Config renderizada al arrancar** desde variables de entorno, no en el build: permite cambiar puertos sobre una imagen prefabricada sin recompilar.

Objetivo de la primera línea del README:

```bash
docker run -d -p 8080:8080 -v ./data:/data -e SONDA_PASSWORD=xxx ghcr.io/USUARIO/sonda
```

---

## 10. Enlace con el homelab

Cubre el pendiente **"API desplegada en la VM 200"**: repo público y endpoint en vivo, que es lo que falta para demostrar backend.

**Dos instancias, no una:**

- **La real, en la VM 100.** Es donde están las fuentes (openGym, Immich, Jellyfin). Privada, por Tailscale.
- **La de demo, en la VM 200.** Con **datos sintéticos** que se resiembran solos. Mandar las observaciones reales a una máquina pública sería publicar la propia vida cuantificada.

Con esa separación, el flujo cross-VM sobra: la VM 200 no necesita nada de la VM 100. Si algún día hiciera falta, la regla es que **la VM 100 hace `POST` con token hacia fuera, nunca abrir la regla hacia dentro**.

**Al desplegar en la VM 100:**

- Comprobar el puerto de verdad antes de darlo por libre: `ss -tlnp | grep -E ':8087'`. A mano quedaban libres 8087-8089.
- **El `.db` va en el disco de la VM** (`~/docker/sonda/data`), nunca en `/mnt/datos`, misma regla que Postgres y que el `./db` de OnlyOffice.
- **Backup:** una línea en `/root/backup.sh` antes de la fase 5, igual que openGym. La copia sí va a `/mnt/datos/backups`, que es lo que rclone sube:
  ```bash
  sqlite3 ~/docker/sonda/data/sonda.db "VACUUM INTO '/mnt/datos/backups/sonda-$(date +%F).db'"
  ```
- Anclar la imagen por digest, como el resto del stack.

Sobre el "con Postgres" que decía el pendiente: la señal de backend son el esquema, la idempotencia y la agregación en zona local, no el nombre del motor. SQLite se queda, y defenderlo con argumentos dice más en una entrevista que meter Postgres por reflejo.

---

## 11. Referencias

- **Nomie / open-nomie** — lo más cercano al concepto, y está muerto. Estudiar por qué.
- **ledger / hledger / beancount / jrnl** — linaje de texto plano.
- **Beaver, Loop/uhabits, Kanso, Ritual, MyDailies, AnyHabit, Neohabit** — el nicho saturado. Mirar qué features los hincharon.
- **Habitica** — el anti-ejemplo explícito.
- **Exist.io** — personal analytics como SaaS. Qué resuelve que los self-hosted no.
