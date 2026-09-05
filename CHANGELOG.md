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

[Unreleased]: https://github.com/apvwbm/sonda/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/apvwbm/sonda/releases/tag/v0.1.0
