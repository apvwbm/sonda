# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) as described in
[Versioning](README.md#versioning-and-releases).

Every release states the **schema version** it leaves the database at, which is
what `PRAGMA user_version` reports. Migrations run automatically on start, and a
release never rolls one back: downgrading past a schema version means restoring
a backup.

## [Unreleased]

Nothing yet.

## [0.2.0] - 2026-09-05

Schema version: **1** (unchanged).

### Added

- `SONDA_PUBLIC_READ`, off by default. With it on, `GET /api/series`,
  `GET /api/observations` and `GET /api/stats` answer without a session cookie.
- `SONDA_PUBLIC_WRITE`, off by default. With it on, `POST /api/series` and
  `POST /api/observations` accept requests without a credential, and anonymous
  rows are stored under the source `public`.
- A boxed warning at startup whenever either flag is on.
- `web/`: a one-page interface in Astro with Tailwind v4, static output to
  `web/dist`, served by Fastify on the same origin. Lists the series, plots
  `/api/stats` as a hand-written SVG bar chart with series and bucket
  selectors, records an observation through `POST /api/observations`, and signs
  in with a password field that posts to `/api/auth/login`. No adapter, no
  client router, no CDN, no chart library, and no session state in the browser:
  the `HttpOnly` cookie is the whole session.
- A Dockerfile stage that builds `web/` and copies `web/dist` into the image.
- `deploy/sonda-seed.service` and `deploy/sonda-seed.timer`: a nightly 04:00
  reseed with `--reset` that restarts `sonda.service` afterwards.

Both flags exist for throwaway demo instances. Neither opens `PATCH`, `DELETE`
or `GET /api/export`, which keep their guard under every configuration.

## [0.1.1] - 2026-09-05

Version bump only, to put the tagging on a proper footing. No code changes.

## [0.1.0] - 2026-09-05

Schema version: **1** (runs `001_init.sql`).

First working version. Pre-1.0, so the API may still change between minor
releases.

### Added

- `GET /api/health`, unauthenticated, reporting the running version.
- Password login with a signed session cookie, and per-IP backoff after
  repeated failures.
- Bearer tokens for ingest, stored as SHA-256 digests and bound to one `source`.
- Series CRUD: `GET`, `POST` and `PATCH /api/series`.
- Idempotent batch ingest at `POST /api/observations`, upserting on
  `(source, external_id)`, with the whole batch in one transaction.
- `local_date` computed server-side from `occurred_at` and `SONDA_TZ`.
- `GET /api/observations` with `series`, `from` and `to` filters and cursor
  pagination, plus `DELETE /api/observations/:id`.
- `GET /api/stats` aggregating by `day`, `week` or `month` buckets over local
  dates, entirely in SQL.
- `GET /api/export`, a consistent database copy via `VACUUM INTO`.
- Static serving of `web/dist` when the directory exists.
- `dist/cli.js token` for minting ingest tokens inside a container.
- `scripts/seed.ts`, with `--reset`, for development and demo data.
- Dockerfile and `.dockerignore`. **Not yet verified**: no Docker build has been
  run against them.

[Unreleased]: https://github.com/apvwbm/sonda/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/apvwbm/sonda/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/apvwbm/sonda/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/apvwbm/sonda/releases/tag/v0.1.0
