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
