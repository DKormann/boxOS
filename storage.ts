import { Database } from "bun:sqlite";
import { entryBytes } from "./resources.ts";

export class PersistentStorage {
  private readonly database: Database;
  private readonly values = new Map<string, string>();
  private readonly upsert;
  private readonly remove;
  private bytes = 0;

  constructor(path: string) {
    this.database = new Database(path, { create: true });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

    const rows = this.database.query<{ key: string; value: string }>("SELECT key, value FROM storage").all();
    for (const row of rows) {
      this.values.set(row.key, row.value);
      this.bytes += entryBytes(row.key, row.value);
    }

    this.upsert = this.database.prepare("INSERT INTO storage (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.remove = this.database.prepare("DELETE FROM storage WHERE key = ?");
  }

  get byteLength(): number {
    return this.bytes;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  get(key: string): string | undefined {
    return this.values.get(key);
  }

  entries(): IterableIterator<[string, string]> {
    return this.values.entries();
  }

  set(key: string, value: string): void {
    const previous = this.values.get(key);
    this.upsert.run(key, value);
    if (previous !== undefined) this.bytes -= entryBytes(key, previous);
    this.values.set(key, value);
    this.bytes += entryBytes(key, value);
  }

  apply(changes: ReadonlyMap<string, string | undefined>): void {
    const transaction = this.database.transaction(() => {
      for (const [key, value] of changes) {
        if (value === undefined) this.remove.run(key);
        else this.upsert.run(key, value);
      }
    });
    transaction();

    for (const [key, value] of changes) {
      const previous = this.values.get(key);
      if (previous !== undefined) this.bytes -= entryBytes(key, previous);
      if (value === undefined) {
        this.values.delete(key);
      } else {
        this.values.set(key, value);
        this.bytes += entryBytes(key, value);
      }
    }
  }
}
