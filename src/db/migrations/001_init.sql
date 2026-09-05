CREATE TABLE series (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,          -- 'coffee', 'weight', 'sleep'
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
  occurred_at  TEXT NOT NULL,                 -- ISO 8601 UTC instant
  local_date   TEXT NOT NULL,                 -- 'YYYY-MM-DD', computed server-side
  value_num    REAL,                          -- bool as 0/1, number, duration in seconds
  value_text   TEXT,
  source       TEXT NOT NULL,                 -- 'manual', 'opengym', 'jellyfin'
  external_id  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (source, external_id)
);

CREATE INDEX idx_obs_series_date ON observations (series_id, local_date);

CREATE TABLE tokens (
  id           INTEGER PRIMARY KEY,
  source       TEXT NOT NULL UNIQUE,          -- a token is bound to one 'source'
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
