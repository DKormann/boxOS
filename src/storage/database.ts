import { Database } from "bun:sqlite"

export const DATABASE_VERSION = 4

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
) STRICT;

CREATE TABLE accounts (
  pubkey TEXT PRIMARY KEY,
  fuel INTEGER NOT NULL CHECK (fuel >= 0),
  last_top_up_at INTEGER NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;

CREATE TABLE blobs (
  id TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream'
) STRICT, WITHOUT ROWID;

CREATE TABLE boxes (
  id TEXT PRIMARY KEY,
  definition TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE box_methods (
  box_id TEXT NOT NULL REFERENCES boxes(id),
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (box_id, name)
) STRICT, WITHOUT ROWID;

CREATE TABLE box_state (
  box_id TEXT NOT NULL REFERENCES boxes(id),
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (box_id, visibility, key)
) STRICT, WITHOUT ROWID;

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  blob_id TEXT NOT NULL REFERENCES blobs(id)
) STRICT, WITHOUT ROWID;

CREATE TABLE startup_deployments (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('blob', 'box', 'page')),
  id TEXT NOT NULL,
  deployed_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE client_operations (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES accounts(pubkey),
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  origin_box_id TEXT NOT NULL REFERENCES boxes(id),
  account TEXT NOT NULL REFERENCES accounts(pubkey),
  client_id TEXT,
  root_task_id TEXT NOT NULL REFERENCES tasks(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fulfilled', 'rejected')),
  result TEXT,
  error TEXT,
  adopted_task_id TEXT REFERENCES tasks(id),
  created_at INTEGER NOT NULL,
  settled_at INTEGER
) STRICT, WITHOUT ROWID;

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  box_id TEXT NOT NULL REFERENCES boxes(id),
  account TEXT NOT NULL REFERENCES accounts(pubkey),
  client_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('method', 'continuation')),
  completion_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT, WITHOUT ROWID;

CREATE TABLE effects (
  id TEXT PRIMARY KEY REFERENCES tasks(id),
  origin_turn_id TEXT NOT NULL REFERENCES turns(id),
  kind TEXT NOT NULL,
  arguments TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'completed')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT, WITHOUT ROWID;

CREATE TABLE task_continuations (
  result_task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  source_task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL CHECK (role IN ('success', 'failure')),
  source TEXT NOT NULL,
  context TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'queued', 'completed')),
  callback_turn_id TEXT REFERENCES turns(id),
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX turns_by_box_status ON turns(box_id, status, created_at);
CREATE INDEX effects_by_status ON effects(status, created_at);
CREATE INDEX tasks_by_adoption ON tasks(adopted_task_id, status);
CREATE INDEX continuations_by_source ON task_continuations(source_task_id, status);
`

export function openDatabase(filename: string): Database {
  const database = new Database(filename, { create: true, strict: true })
  const hasSchema = database.query(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'",
  ).get() != null
  const row = hasSchema
    ? database.query<{ version: number }>("SELECT version FROM schema_meta WHERE id = 1").get()
    : null
  if (row != null) {
    if (row.version != DATABASE_VERSION) {
      database.close()
      throw new Error(`Unsupported database version ${row.version}; expected ${DATABASE_VERSION}`)
    }
    return database
  }

  // A database is either entirely current or rejected. BoxOS intentionally has
  // no compatibility schema or migration path.
  database.exec(SCHEMA)
  database.query("INSERT INTO schema_meta (id, version) VALUES (1, ?)").run(DATABASE_VERSION)
  return database
}
