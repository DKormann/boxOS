import { Database } from "bun:sqlite"

export const DATABASE_VERSION = 1

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS accounts (
  pubkey TEXT PRIMARY KEY,
  fuel INTEGER NOT NULL CHECK (fuel >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  bytes BLOB NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS boxes (
  id TEXT PRIMARY KEY,
  definition TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS box_methods (
  box_id TEXT NOT NULL REFERENCES boxes(id),
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (box_id, name)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS box_state (
  box_id TEXT NOT NULL REFERENCES boxes(id),
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (box_id, visibility, key)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  blob_id TEXT NOT NULL REFERENCES blobs(id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  box_id TEXT NOT NULL REFERENCES boxes(id),
  account TEXT NOT NULL REFERENCES accounts(pubkey),
  client_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('method', 'callback')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS effects (
  id TEXT PRIMARY KEY,
  origin_turn_id TEXT NOT NULL REFERENCES turns(id),
  origin_box_id TEXT NOT NULL REFERENCES boxes(id),
  kind TEXT NOT NULL,
  arguments TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'succeeded', 'failed')),
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS effect_callbacks (
  effect_id TEXT NOT NULL REFERENCES effects(id),
  role TEXT NOT NULL CHECK (role IN ('success', 'failure')),
  source TEXT NOT NULL,
  context TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'queued', 'completed', 'discarded')),
  callback_turn_id TEXT REFERENCES turns(id),
  PRIMARY KEY (effect_id, role)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS turns_by_box_status ON turns(box_id, status, created_at);
CREATE INDEX IF NOT EXISTS effects_by_status ON effects(status, created_at);
`

export function openDatabase(filename: string): Database {
  const database = new Database(filename, { create: true, strict: true })
  database.exec(SCHEMA)

  const row = database.query<{ version: number }>(
    "SELECT version FROM schema_meta LIMIT 1",
  ).get()
  if (row == null) {
    database.query("INSERT INTO schema_meta (version) VALUES (?)").run(DATABASE_VERSION)
  } else if (row.version != DATABASE_VERSION) {
    database.close()
    throw new Error(`Unsupported database version ${row.version}; expected ${DATABASE_VERSION}`)
  }

  return database
}
