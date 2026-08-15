import { Database } from "bun:sqlite"

export const DATABASE_VERSION = 3

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS accounts (
  pubkey TEXT PRIMARY KEY,
  fuel INTEGER NOT NULL CHECK (fuel >= 0),
  last_top_up_at INTEGER NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream'
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

CREATE TABLE IF NOT EXISTS startup_deployments (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('blob', 'box', 'page')),
  id TEXT NOT NULL,
  deployed_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS client_operations (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES accounts(pubkey),
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS client_messages (
  id TEXT PRIMARY KEY,
  sender_account TEXT NOT NULL REFERENCES accounts(pubkey),
  receiver_client_id TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS client_messages_by_receiver
  ON client_messages(receiver_client_id, status, created_at);

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
    "SELECT version FROM schema_meta WHERE id = 1",
  ).get()
  if (row == null) {
    database.query("INSERT OR IGNORE INTO schema_meta (id, version) VALUES (1, ?)").run(DATABASE_VERSION)
  } else if (row.version == 1 || row.version == 2) {
    database.transaction(() => {
      if (row.version == 1) {
        database.exec("ALTER TABLE accounts ADD COLUMN last_top_up_at INTEGER NOT NULL DEFAULT 0")
      }
      database.exec(`
        ALTER TABLE blobs ADD COLUMN content_type TEXT NOT NULL DEFAULT 'application/octet-stream';
        ALTER TABLE startup_deployments RENAME TO startup_deployments_v2;
        CREATE TABLE startup_deployments (
          name TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('blob', 'box', 'page')),
          id TEXT NOT NULL,
          deployed_at INTEGER NOT NULL
        ) STRICT, WITHOUT ROWID;
        INSERT INTO startup_deployments SELECT * FROM startup_deployments_v2;
        DROP TABLE startup_deployments_v2;
      `)
      database.query("UPDATE schema_meta SET version = ? WHERE id = 1").run(DATABASE_VERSION)
    })()
  } else if (row.version != DATABASE_VERSION) {
    database.close()
    throw new Error(`Unsupported database version ${row.version}; expected ${DATABASE_VERSION}`)
  }

  return database
}
