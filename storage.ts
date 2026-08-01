import { Database } from "bun:sqlite";
import { entryBytes, pageStorageBytes } from "./resources.ts";

export type StoredPage = {
  html: string;
  expiresAt: number;
};

export class PersistentStorage {
  private readonly database: Database;
  private readonly values = new Map<string, string>();
  private readonly pages = new Map<string, StoredPage>();
  private readonly upsert;
  private readonly remove;
  private readonly upsertPage;
  private readonly removePage;
  private bytes = 0;

  constructor(path: string) {
    this.database = new Database(path, { create: true });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.database.exec("CREATE TABLE IF NOT EXISTS pages (hash TEXT PRIMARY KEY, html TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    this.database.prepare("DELETE FROM pages WHERE expires_at <= ?").run(Date.now());

    const rows = this.database.query<{ key: string; value: string }>("SELECT key, value FROM storage").all();
    for (const row of rows) {
      this.values.set(row.key, row.value);
      this.bytes += entryBytes(row.key, row.value);
    }
    const pageRows = this.database.query<{ hash: string; html: string; expires_at: number }>(
      "SELECT hash, html, expires_at FROM pages",
    ).all();
    for (const row of pageRows) {
      const page = { html: row.html, expiresAt: row.expires_at };
      this.pages.set(row.hash, page);
      this.bytes += pageStorageBytes(row.hash, row.html);
    }

    this.upsert = this.database.prepare("INSERT INTO storage (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.remove = this.database.prepare("DELETE FROM storage WHERE key = ?");
    this.upsertPage = this.database.prepare(
      "INSERT INTO pages (hash, html, expires_at) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET expires_at = excluded.expires_at",
    );
    this.removePage = this.database.prepare("DELETE FROM pages WHERE hash = ?");
  }

  get byteLength(): number {
    return this.bytes;
  }

  get pageCount(): number {
    return this.pages.size;
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

  getPage(hash: string, now = Date.now()): StoredPage | undefined {
    const page = this.pages.get(hash);
    if (page === undefined) return undefined;
    if (page.expiresAt > now) return page;
    this.removePage.run(hash);
    this.pages.delete(hash);
    this.bytes -= pageStorageBytes(hash, page.html);
    return undefined;
  }

  setPage(hash: string, html: string, expiresAt: number): void {
    const previous = this.pages.get(hash);
    this.upsertPage.run(hash, html, expiresAt);
    if (previous !== undefined) this.bytes -= pageStorageBytes(hash, previous.html);
    this.pages.set(hash, { html, expiresAt });
    this.bytes += pageStorageBytes(hash, html);
  }

  purgeExpiredPages(now = Date.now()): void {
    const expired = [...this.pages].filter(([, page]) => page.expiresAt <= now);
    if (expired.length === 0) return;
    const transaction = this.database.transaction(() => {
      for (const [hash] of expired) this.removePage.run(hash);
    });
    transaction();
    for (const [hash, page] of expired) {
      this.pages.delete(hash);
      this.bytes -= pageStorageBytes(hash, page.html);
    }
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
