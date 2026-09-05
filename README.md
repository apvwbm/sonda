# Sonda

A self-hosted store and API for heterogeneous personal data: habits, metrics,
events. Manual entry works, but the point is **automatic ingest from services
you already run**.

Free, open source, self-hosted only. No cloud version, no pricing, no accounts
anywhere else.

> **Status:** pre-1.0. The API is implemented and tested, images are not
> published yet, and the Dockerfile has not been verified against a real build.
> Build from source for now.

---

## The thesis

Manual logging dies after three weeks. That is why this niche is full of
abandoned repositories: the author stopped using their own app.

If part of your series fill themselves, there is still data after you stop
writing down every coffee. So the centrepiece here is not the interface, it is
the ingest API.

And to avoid building the monster, Sonda **does not ship integrations**. It
ships an ingest API and a schema. Each integration is a twenty-line script,
yours or a contributor's. That is a clean boundary, a contribution surface that
never touches the core, and an honest API design problem.

---

## Live demo

<https://apvwbm.com/api/health>

Password: `demo`

The data is **entirely synthetic** and reseeded daily. None of it is real. A
public instance holding a real quantified life would be publishing that life,
which is exactly what this project is for avoiding.

```bash
curl https://apvwbm.com/api/health

curl -c cookies.txt -X POST https://apvwbm.com/api/auth/login \
  -H 'Content-Type: application/json' -d '{"password":"demo"}'

curl -b cookies.txt "https://apvwbm.com/api/stats?series=weight&bucket=week"
```

It runs with `SONDA_PUBLIC_READ=true`, so the reads above also work without
logging in at all:

```bash
curl "https://apvwbm.com/api/stats?series=weight&bucket=week"
```

Anything you create there disappears at the next reseed. How that instance is
configured is in [Demo instances](#demo-instances).

---

## Quick start

```bash
git clone https://github.com/apvwbm/sonda
cd sonda
npm install
cp .env.example .env          # set SONDA_PASSWORD
npm run seed                  # optional: ~90 days of fake data
npm run dev
```

Then `curl localhost:8080/api/health`.

Requires Node 22.18 or newer. There is no build step in development: Node strips
the TypeScript types natively.

Once images are published, the intended one-liner is:

```bash
docker run -d -p 8080:8080 -v ./data:/data -e SONDA_PASSWORD=xxx ghcr.io/apvwbm/sonda
```

---

## What this deliberately is not

**Not a habit tracker.** That niche is saturated and competes on simplicity, so
simplicity is not a differentiator. The empty space is "track anything": Nomie
was the reference and shut down in February 2023.

**No streaks.** Streaks are gamification wearing a different hat, the same guilt
mechanism Duolingo runs on. They are incompatible with not wanting artificial
motivation, and cutting them is a real difference rather than a missing feature.

**No reminders or notifications.** That is the single feature that would turn
this into the habit tracker it is trying not to be.

**Not "git for your life".** The metaphor does not hold: git is versioning,
diffs and branches. This is an append-only log with aggregations.

Also out of scope: multi-user, passkeys, goals, any view that judges you, AI,
and integrations inside the core.

---

## The data model

One concept, not three. A habit is a boolean series, a metric is a numeric
series, an event is a series with a duration and optional text. Same engine.

```sql
CREATE TABLE series (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  value_type   TEXT NOT NULL CHECK (value_type IN ('bool','number','duration','text')),
  unit         TEXT,
  aggregation  TEXT NOT NULL CHECK (aggregation IN ('sum','avg','last','count')),
  created_at   TEXT NOT NULL,
  archived_at  TEXT
);

CREATE TABLE observations (
  id           INTEGER PRIMARY KEY,
  series_id    INTEGER NOT NULL REFERENCES series(id),
  occurred_at  TEXT NOT NULL,   -- ISO 8601 UTC instant
  local_date   TEXT NOT NULL,   -- 'YYYY-MM-DD', computed server-side
  value_num    REAL,            -- bool as 0/1, number, duration in seconds
  value_text   TEXT,
  source       TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (source, external_id)
);
```

Not every aggregation fits every type, and the per-column `CHECK` constraints
cannot express that. `POST /api/series` rejects the combinations that would
produce nothing but nulls:

| `value_type` | allowed `aggregation` |
|---|---|
| `bool` | `sum`, `count`, `last` |
| `number` | all four |
| `duration` | all four |
| `text` | `count`, `last` |

### The three decisions that matter

**`local_date` separate from `occurred_at`.** "Did I read today?" is a question
about a local date, not a UTC instant. Storing only UTC means anyone who goes to
bed at 2am sees their data on the wrong day, forever. The server computes
`local_date` on insert from `occurred_at` and `SONDA_TZ`. **The client never
sends it**, and one that tries has it ignored.

**The `UNIQUE (source, external_id)` constraint.** This is what makes ingest
**idempotent**: a script can resend the last thirty days without duplicating
anything. It is the most valuable decision in the project and it costs one line
of schema. On conflict the row is **updated, not ignored**, so correcting a data
point is just resending it.

**`external_id` on manual entries too.** A manual entry without one cannot be
corrected through the same path as an automatic one. The server generates a UUID
when the client omits it — at the cost that such an entry is no longer
idempotent, which is why ingest scripts should always send their own.

---

## API

Everything is under `/api` and answers JSON. Errors are
`{ "error": "message" }` with the appropriate status code.

Two ways in: a **signed session cookie** for the interface, and
`Authorization: Bearer <token>` for ingest. **The `source` never travels in the
payload — it comes from the token.** A script therefore cannot write on behalf
of another source, and it does not have to remember to say who it is.

| Method | Path | Auth | What it does |
|---|---|---|---|
| `GET` | `/api/health` | none | `{ "status": "ok", "version": "0.1.0" }` |
| `POST` | `/api/auth/login` | none | Takes `{ password }`, sets the session cookie |
| `POST` | `/api/auth/logout` | cookie | Clears the cookie |
| `GET` | `/api/series` | cookie or bearer | `{ "series": [...] }` |
| `POST` | `/api/series` | cookie | Creates a series |
| `PATCH` | `/api/series/:id` | cookie | Renames or archives |
| `POST` | `/api/observations` | cookie or bearer | Idempotent batch ingest |
| `GET` | `/api/observations` | cookie | Filters and cursor pagination |
| `DELETE` | `/api/observations/:id` | cookie | Deletes one |
| `GET` | `/api/stats` | cookie | Aggregation by local-date bucket |
| `GET` | `/api/export` | cookie | The whole `.db`, via `VACUUM INTO` |

The `Auth` column describes a normal instance. A demo instance can relax the
reads and the two `POST`s with `SONDA_PUBLIC_READ` and `SONDA_PUBLIC_WRITE`;
`PATCH`, `DELETE` and `/api/export` are never relaxed. See
[Demo instances](#demo-instances).

Listing series accepts a bearer token because an ingest script needs to know
which slugs exist before it sends anything. Ingest accepts a cookie too, and
anything arriving that way is attributed to the `manual` source: manual capture
is just another ingest source, not a separate mechanism.

### Ingest

`POST /api/observations`, batches of up to 1000:

```json
{
  "observations": [
    { "series": "coffee", "occurred_at": "2026-09-05T08:12:00Z", "value": 1,
      "external_id": "coffee-2026-09-05-1" },
    { "series": "weight", "occurred_at": "2026-09-05T07:30:00Z", "value": 74.2,
      "external_id": "weight-2026-09-05" }
  ]
}
```

Answers `{ "inserted": 1, "updated": 1, "series_desconocidas": [] }`.

The whole batch runs in one transaction. A series that does not exist **does not
blow up the batch**: its slug is reported back in `series_desconocidas` and
everything else lands. That is the only non-fatal exception — anything else,
such as sending a string to a numeric series, returns 400 and rolls the batch
back whole.

`occurred_at` must carry an explicit zone designator. `2026-09-05T10:00:00` is
rejected, because `Date` would read it as the server's local time, which is the
exact class of bug `local_date` exists to prevent.

### Aggregated queries

```
GET /api/stats?series=weight&bucket=week&from=2026-01-01&to=2026-09-05
```

```json
{
  "series": "weight",
  "aggregation": "avg",
  "unit": "kg",
  "buckets": [ { "date": "2026-08-31", "value": 74.4, "count": 5 } ]
}
```

`bucket` is `day`, `week` or `month`, and grouping happens on `local_date`, not
on UTC. **Weeks start on Monday**, so the bucket date is always a Monday.

The aggregation function comes from the series' own `aggregation` column, not
from the request. A bucket with no observations **does not appear** — no gaps
are filled and no zeroes are invented.

All of it happens in SQLite; JavaScript only assembles the query.

### Pagination

```
GET /api/observations?series=weight&from=2026-01-01&to=2026-09-05&limit=200
```

Returns `{ "observations": [...], "next_cursor": "..." }`, newest first.
`next_cursor` is `null` on the last page; otherwise send it back verbatim as
`&cursor=`. `limit` defaults to 200 and caps at 1000.

This is cursor pagination rather than `OFFSET` on purpose. With `OFFSET`, a row
inserted while you are paginating shifts every later page and rows get repeated
or skipped. The cursor encodes the last position read in the `(occurred_at, id)`
order, which is total and stable.

`from` and `to` filter on `local_date` here too, so both endpoints answer over
the same range.

---

## Writing an ingest source

There is no plugin system. An integration is a script that does one POST.

```bash
#!/usr/bin/env bash
# Sends yesterday's step count. Safe to re-run: the external_id makes the write
# idempotent, so a cron that retries never duplicates a row.
set -euo pipefail

: "${SONDA_URL:=http://localhost:8080}"
: "${SONDA_TOKEN:?set SONDA_TOKEN to an ingest token}"

day=$(date -u -d yesterday +%F)
steps=$(cat "$HOME/steps/$day.txt")

curl -fsS -X POST "$SONDA_URL/api/observations" \
  -H "Authorization: Bearer $SONDA_TOKEN" \
  -H 'Content-Type: application/json' \
  --data @- <<JSON
{"observations": [
  {"series": "steps", "occurred_at": "${day}T23:00:00Z",
   "value": ${steps}, "external_id": "steps-${day}"}
]}
JSON
```

Mint the token first:

```bash
npm run token -- --source steps            # from a checkout
docker exec sonda node dist/cli.js token --source steps    # inside a container
```

The token is printed **once**. Only its SHA-256 digest is stored, so a lost
token can only be replaced with `--rotate`, never recovered.

Because the write is idempotent, the robust shape for any source is "resend the
last N days on every run". Backfills, retries and fixed upstream data all
converge to the same rows.

---

## Web interface

One page, in [`web/`](web/), served by Fastify from `web/dist` on the same origin
as the API. Same origin means no CORS, no base URL to configure and no second
container.

It does four things:

- lists the series with their value type, unit and aggregation;
- plots `/api/stats` as a bar chart, with a series selector and a `day` / `week`
  / `month` bucket selector;
- records an observation into the selected series with `POST /api/observations`;
- signs in. A `401` from any request replaces the page with a password field
  that posts to `/api/auth/login`; getting it right reloads the data;
- shows what the API said when it refuses. A `400` appears next to the form with
  the server's own message, and a wrong password (or the login backoff's `429`)
  appears under the password field.

**There is no session handling in the browser.** Signing in sets the `HttpOnly`
cookie and the page keeps nothing: no token in `localStorage`, no "remember me",
no logged-in flag to fall out of sync with the server. The only thing the page
knows about auth is what the last response said, which is why a `401` from any
request is enough to show the password field again.

**Astro with Tailwind v4, static output, and that is the whole stack.** No
adapter, no client router, no CDN, no chart library. The chart is hand-written
SVG, which for bars is a `<rect>` per bucket and some arithmetic — a dependency
would be more code to read, not less.

Two details it gets right rather than approximately:

- **Bucket dates are never parsed into a `Date`.** `new Date('2026-09-04')` is
  UTC midnight, which renders as the 3rd anywhere west of Greenwich. The server
  already decided which local day a row belongs to; re-deriving it in the
  browser is only a chance to disagree with it.
- **A bucket that aggregated to exactly zero draws no bar**, while a very small
  value still draws one pixel. Same principle as the API not inventing empty
  buckets: zero is a result, and it should not look like a near miss.

A text series aggregated with `last` returns strings, not numbers. Those are
listed rather than plotted, because bars would imply an order they do not have.

### Building it

```bash
cd web
npm ci
npm run build     # -> web/dist
npm run dev       # Astro dev server, for working on the page itself
npm run check     # typechecks the page, including the script
```

`web/dist` is not committed. Fastify serves it when the directory exists and
logs `API only` when it does not, so the API runs perfectly well without ever
building the page. The Docker image builds it in its own stage.

---

## Configuration

Everything is read from the environment at start, never baked into the image, so
the same image works on any port.

| Variable | Default | Purpose |
|---|---|---|
| `SONDA_PORT` | `8080` | Listening port |
| `SONDA_DATA_DIR` | `/data` | The one directory holding everything. `./data` in development |
| `SONDA_TZ` | `Europe/Madrid` | Zone used to compute `local_date` |
| `SONDA_PASSWORD` | — | Interface password. **Required** |
| `SONDA_SESSION_SECRET` | — | Cookie signing key. Generated and stored in `SONDA_DATA_DIR` when unset |
| `SONDA_PUBLIC_READ` | `false` | **Demo instances only.** Opens the three read endpoints to anyone. See [Demo instances](#demo-instances) |
| `SONDA_PUBLIC_WRITE` | `false` | **Demo instances only.** Opens `POST /api/series` and `POST /api/observations` to anyone |

An invalid value stops the server at startup with a readable message rather than
failing later. An unknown `SONDA_TZ` is rejected on the spot. The two booleans
accept `true`, `false`, `1` or `0` and nothing else: a `SONDA_PUBLIC_READ=yes`
stops the server instead of being read as truthy, because the failure mode of
guessing here is publishing the data.

---

## Demo instances

A demo instance is a **throwaway** instance holding data nobody minds publishing:
the synthetic set from `scripts/seed.ts`, wiped and rebuilt every night. Two
flags exist for that case and no other.

| Flag | What it opens |
|---|---|
| `SONDA_PUBLIC_READ` | `GET /api/series`, `GET /api/observations`, `GET /api/stats` answer without a cookie |
| `SONDA_PUBLIC_WRITE` | `POST /api/series` and `POST /api/observations` accept requests without a credential |

**Neither flag opens `PATCH`, `DELETE` or `GET /api/export`.** Those keep their
guard whatever the environment says, so the worst an anonymous visitor can do to
a fully public instance is add rows: never rewrite one, never delete one, and
never walk off with the database file.

Anonymous writes are stored under the source `public`, so they stay
distinguishable from everything else and a sweep is one statement:

```sql
DELETE FROM observations WHERE source = 'public';
```

A real credential still wins. A token ingesting into a public instance keeps
being attributed to its own source rather than being flattened to `public`.

Both flags are off unless set, and both accept only `true`, `false`, `1` or `0`.
With either on, the server prints a boxed warning immediately before the
listening line, so an instance left open by accident shows up in the first
screen of `journalctl`.

> **Do not turn either flag on where the data is real.** `SONDA_PUBLIC_READ`
> publishes it. `SONDA_PUBLIC_WRITE` also turns the instance into an open
> mailbox: anyone who can reach the port can fill the database, and nothing
> rate-limits them. The reason it is tolerable on the demo is that everything
> there is thrown away at 04:00 every night.

### The nightly reseed

[`deploy/sonda-seed.service`](deploy/sonda-seed.service) and
[`deploy/sonda-seed.timer`](deploy/sonda-seed.timer) run the seed with `--reset`
at 04:00 local time and restart `sonda.service` afterwards. Every path in them
is an example; adjust `User`, `WorkingDirectory`, `EnvironmentFile` and
`ReadWritePaths` to your install.

```bash
sudo cp deploy/sonda-seed.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sonda-seed.timer

sudo systemctl start sonda-seed.service   # run it once by hand first
systemctl list-timers sonda-seed.timer
journalctl -u sonda-seed.service -n 50
```

`--reset` deletes **every series and every observation** before recreating the
synthetic set. Ingest tokens survive it. The timer is `Persistent=true`, so a
machine that was off at 04:00 reseeds on its next boot rather than serving stale
data for a day.

The seed runs from a checkout, not from the image: `scripts/` is deliberately
excluded from the Docker build, and so is `deploy/`.

---

## Backups and keeping the data safe

**The whole database is one file.** It is the database, the backup and the
export at the same time. Everything lives under `SONDA_DATA_DIR`, so a backup is
a tar of one directory.

**Never copy a live SQLite database with `cp`.** It can catch the file
half-written, and with WAL it also misses everything not yet checkpointed. The
result is a backup that looks fine until the day you need it. Use `VACUUM INTO`,
which is what `GET /api/export` does:

```bash
curl -b cookies.txt -o sonda-backup.db http://localhost:8080/api/export
```

For an automated backup, run it outside the process instead:

```bash
sqlite3 ~/docker/sonda/data/sonda.db "VACUUM INTO '/backups/sonda-$(date +%F).db'"
```

**Do not put the database on a network filesystem.** Not NFS, not SMB, not
virtiofs. File locking is not reliable there and it will corrupt the database.
Keep it on local disk and back the copy up elsewhere.

### `GET /api/export` blocks the server while it runs

`better-sqlite3` is synchronous, which is exactly why it was chosen: for a
single user it is the fastest and the simplest thing to read. The price is that
`VACUUM INTO` **blocks Node's event loop for the whole copy**. No other request
is served while an export is being generated.

On a small database that is milliseconds. On hundreds of megabytes on a
Raspberry Pi it can be several seconds, and a container health check may fail if
it lands in that window.

This is not a bug to fix with a worker thread, which would bring back exactly
the complexity that choosing synchronous SQLite avoids. It is a property of a
single-user service. In practice: do not put `/api/export` on a one-minute cron.
Use the `sqlite3 ... VACUUM INTO` line above for scheduled backups and keep the
endpoint for downloading by hand.

---

## Security

The threat model is a single-user service on a home network.

**Password plus signed cookie**, with a separate bearer token for ingest. The
cookie is `HttpOnly` and `SameSite=Lax`, and **`Secure` is deliberately off** so
it works over plain HTTP on a LAN, which is how a self-hosted app gets tried on
day one. Exposed to the internet, it belongs behind your own reverse proxy
terminating TLS.

**Ingest tokens are stored hashed.** Whoever walks away with the `.db` does not
walk away with the tokens.

**Login has a per-IP backoff.** The first four failures are free, because
mistyping a password is normal. From the fifth, the wait doubles each time up to
five minutes, and a blocked request is rejected before the password is even
looked at, so the block is not an oracle. It is in memory, so a restart clears
it — it is a brake, not a WAF.

**Two flags can open an instance up**, and only for demo use:
`SONDA_PUBLIC_READ` and `SONDA_PUBLIC_WRITE`. Both are off unless set, both
refuse to be set to anything but `true`/`false`/`1`/`0`, and neither one ever
opens `PATCH`, `DELETE` or `/api/export`. See [Demo instances](#demo-instances).

### Logout does not revoke server-side

The session is a signed cookie carrying its own expiry, with no sessions table.
`POST /api/auth/logout` clears the browser's cookie, which covers the normal
case. A cookie already copied out of the browser would keep working until it
expires, 30 days after it was issued.

To end **every** session at once, change `SONDA_SESSION_SECRET`, or delete
`session-secret` from `SONDA_DATA_DIR` and restart. Every cookie ever issued
stops verifying immediately.

---

## Architecture decisions

| Decision | Why |
|---|---|
| **SQLite, not Postgres** | Single user, and it has to run on a Raspberry Pi. One file is the database, the backup and the export at once. Postgres here would be a résumé decision, not an architectural one |
| **Node 22 + TypeScript** | Around 80-100 MB of RAM, which fits a Pi comfortably |
| **Fastify + better-sqlite3** | Synchronous access is both the fastest and the simplest to read for one user |
| **One container, not two** | Without passkeys there is no need for a same-origin nginx. The compiled frontend is served by Fastify itself |
| **Simple auth** | Works over plain HTTP on a LAN, behind your reverse proxy on the internet |
| **Embedded migrations** | SQL files inside the project, run at startup, versioned with `PRAGMA user_version`. The user is never asked to run a migration command |

The signal of backend work here is the schema, the idempotency and the local-zone
aggregation — not the name of the engine.

---

## Known limits

- **`unit` cannot be changed after a series is created**, along with `slug` and
  `value_type`. Renaming `kg` to `lb` converts nothing: it silently
  reinterprets every observation already stored and makes `/api/stats` average
  two different scales. If you picked the wrong unit, create a new series and
  resend the converted data — resending is safe.
- **Logout does not revoke server-side**, as described above.
- **`GET /api/export` blocks the event loop**, as described above.
- **Single user.** There is no user table and no plan for one.
- **An entry without `external_id` is not idempotent.** The generated UUID is
  different every time, so ingest scripts should always send their own.

---

## Development

```bash
npm run dev        # watch mode, database in ./data
npm test           # typecheck, then the full suite
npm run typecheck  # types only, including tests
npm run build      # compile to dist/ and copy the migrations
npm start          # run the compiled build
npm run seed       # ~90 days of reproducible fake data
npm run token      # mint an ingest token
```

`web/` is a separate npm project with its own lockfile, so the frontend's
dependencies never enter the server's tree. See [Web interface](#web-interface).

Tests use `node:test`, the runner Node already ships. No framework, and the
database is in memory, so the suite leaves nothing behind.

Start over at any time with `rm -rf data`. That is the advantage of the database
being a single file.

`npm run seed -- --reset` deletes every series and observation and recreates the
seed, leaving tokens alone. That is what a demo instance runs on a timer: the
90-day window follows the calendar and whatever visitors created gets cleared.
The systemd units that do it live in [`deploy/`](deploy/).

### Migrations

SQL files in `src/db/migrations`, named `NNN_name.sql`, applied at startup in
order. Each runs in its own transaction together with its `user_version` bump,
so there is no half-migrated state. Numbering must be contiguous, which catches
two branches both calling theirs `002`.

**An applied migration is never edited.** Databases in the wild have already run
it and will not run it again. Corrections go in a new file.

Starting a database that reports a schema version newer than the binary knows
refuses to start rather than guessing.

---

## Versioning and releases

Semantic Versioning, with the API **and the schema** both part of the contract:

- **MAJOR** — a breaking HTTP API change, or a migration that drops or
  reinterprets stored data.
- **MINOR** — new endpoints, new optional fields, additive migrations.
- **PATCH** — fixes that change neither the API nor the schema.

While the version is `0.x`, a **minor bump may still break the API**. `1.0.0`
ships when the contract is frozen.

The app version and the schema version are independent. The app version lives in
`package.json` and is what `GET /api/health` reports; the schema version is
`PRAGMA user_version`. [CHANGELOG.md](CHANGELOG.md) maps one to the other, and
every release states which migrations it runs.

```bash
npm version patch        # or minor / major: bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

`npm version` runs the test suite first and refuses to tag if it fails. Because
`/api/health` reads the version straight from `package.json`, the reported
version cannot drift from the tag.

Published images are tagged `vX.Y.Z`, `X.Y` and `latest`. **Pin a version**, and
read the changelog before upgrading to see which migration will run.

---

## License

Not chosen yet. Until a `LICENSE` file exists, default copyright applies and
this is not yet open source in the legal sense.
