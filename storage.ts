import { Database } from "bun:sqlite";
import {
  MAX_STORAGE_BYTES,
  pageStorageBytes,
  procedureStorageBytes,
  stateStorageBytes,
  storageFuelCost,
} from "./resources.ts";

export type StateRead = {
  procedureHash: string;
  key: string;
  version: number | null;
};

export type StateOperation =
  | { type: "store"; procedureHash: string; key: string; value: string }
  | { type: "delete"; procedureHash: string; key: string };

export type StoredPage = { html: string; expiresAt: number };

export class TransactionConflictError extends Error {
  constructor() {
    super("State changed while the transaction was executing");
    this.name = "TransactionConflictError";
  }
}

export class InsufficientBalanceError extends Error {
  constructor(readonly balance: number, readonly required: number) {
    super(`Insufficient balance: ${required} fuel required, ${balance} available`);
    this.name = "InsufficientBalanceError";
  }
}

export class PersistentStorage {
  private readonly database: Database;
  private bytes = 0;

  constructor(path: string) {
    this.database = new Database(path, { create: true });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("CREATE TABLE IF NOT EXISTS procedures (hash TEXT PRIMARY KEY, code TEXT NOT NULL)");
    this.database.exec(`CREATE TABLE IF NOT EXISTS state (
      procedure_hash TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      version INTEGER NOT NULL,
      PRIMARY KEY (procedure_hash, key)
    )`);
    this.database.exec("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, balance INTEGER NOT NULL)");
    this.database.exec("CREATE TABLE IF NOT EXISTS pages (hash TEXT PRIMARY KEY, html TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    this.database.prepare("DELETE FROM pages WHERE expires_at <= ?").run(Date.now());

    for (const row of this.database.query<{ hash: string; code: string }>("SELECT hash, code FROM procedures").all()) {
      this.bytes += procedureStorageBytes(row.hash, row.code);
    }
    for (const row of this.database.query<{ procedure_hash: string; key: string; value: string | null }>(
      "SELECT procedure_hash, key, value FROM state",
    ).all()) {
      if (row.value !== null) this.bytes += stateStorageBytes(row.procedure_hash, row.key, row.value);
    }
    for (const row of this.database.query<{ hash: string; html: string }>("SELECT hash, html FROM pages").all()) {
      this.bytes += pageStorageBytes(row.hash, row.html);
    }
  }

  get byteLength(): number {
    return this.bytes;
  }

  get pageCount(): number {
    return this.database.query<{ count: number }>("SELECT COUNT(*) AS count FROM pages").get()?.count ?? 0;
  }

  balance(userId: string): number {
    return this.database.query<{ balance: number }>("SELECT balance FROM users WHERE id = ?").get(userId)?.balance ?? 0;
  }

  fund(userId: string, amount: number): number {
    const transaction = this.database.transaction(() => {
      this.ensureUser(userId);
      this.database.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").run(amount, userId);
      return this.balance(userId);
    });
    return transaction();
  }

  reserveFuel(userId: string, amount: number): number {
    const transaction = this.database.transaction(() => {
      const balance = this.balance(userId);
      if (balance < amount) throw new InsufficientBalanceError(balance, amount);
      this.database.prepare("UPDATE users SET balance = balance - ? WHERE id = ?").run(amount, userId);
      return balance - amount;
    });
    return transaction();
  }

  hasProcedure(hash: string): boolean {
    return this.database.query<{ found: number }>("SELECT 1 AS found FROM procedures WHERE hash = ?").get(hash) !== null;
  }

  getProcedure(hash: string): string | undefined {
    return this.database.query<{ code: string }>("SELECT code FROM procedures WHERE hash = ?").get(hash)?.code;
  }

  registerProcedure(userId: string, hash: string, code: string): { cost: number; balance: number; created: boolean } {
    const transaction = this.database.transaction(() => {
      if (this.hasProcedure(hash)) return { cost: 0, balance: this.balance(userId), created: false };
      const cost = storageFuelCost(`proc:${hash}`, code, this.bytes);
      const balance = this.balance(userId);
      if (balance < cost) throw new InsufficientBalanceError(balance, cost);
      const nextBytes = this.bytes + procedureStorageBytes(hash, code);
      if (nextBytes > MAX_STORAGE_BYTES) throw new Error("Storage limit exceeded");
      this.database.prepare("UPDATE users SET balance = balance - ? WHERE id = ?").run(cost, userId);
      this.database.prepare("INSERT INTO procedures (hash, code) VALUES (?, ?)").run(hash, code);
      this.bytes = nextBytes;
      return { cost, balance: balance - cost, created: true };
    });
    return transaction();
  }

  commitInvocation(
    userId: string,
    reads: readonly StateRead[],
    operations: readonly StateOperation[],
    refund: number,
  ): { balance: number; deletionReward: number } {
    let nextBytes = this.bytes;
    let deletionReward = 0;
    const transaction = this.database.transaction(() => {
      const readStatement = this.database.query<{ value: string | null; version: number }>(
        "SELECT value, version FROM state WHERE procedure_hash = ? AND key = ?",
      );
      for (const read of reads) {
        const current = readStatement.get(read.procedureHash, read.key);
        const currentVersion = current?.version ?? null;
        if (currentVersion !== read.version) throw new TransactionConflictError();
      }

      const finalOperations = new Map<string, StateOperation>();
      for (const operation of operations) {
        finalOperations.set(`${operation.procedureHash}\u0000${operation.key}`, operation);
      }

      for (const operation of finalOperations.values()) {
        const current = readStatement.get(operation.procedureHash, operation.key);
        if (current?.value !== null && current?.value !== undefined) {
          nextBytes -= stateStorageBytes(operation.procedureHash, operation.key, current.value);
        }
        if (operation.type === "store") {
          nextBytes += stateStorageBytes(operation.procedureHash, operation.key, operation.value);
        } else if (current?.value !== null && current?.value !== undefined) {
          deletionReward += storageFuelCost(
            `${operation.procedureHash}:${operation.key}`,
            current.value,
            this.bytes,
          );
        }
      }
      if (nextBytes > MAX_STORAGE_BYTES) throw new Error("Storage limit exceeded");

      const store = this.database.prepare(`INSERT INTO state (procedure_hash, key, value, version)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(procedure_hash, key) DO UPDATE SET value = excluded.value, version = state.version + 1`);
      const remove = this.database.prepare(`INSERT INTO state (procedure_hash, key, value, version)
        VALUES (?, ?, NULL, 1)
        ON CONFLICT(procedure_hash, key) DO UPDATE SET value = NULL, version = state.version + 1`);
      for (const operation of finalOperations.values()) {
        if (operation.type === "store") store.run(operation.procedureHash, operation.key, operation.value);
        else remove.run(operation.procedureHash, operation.key);
      }

      this.ensureUser(userId);
      this.database.prepare("UPDATE users SET balance = balance + ? WHERE id = ?")
        .run(refund + deletionReward, userId);
      return this.balance(userId);
    });
    const balance = transaction();
    this.bytes = nextBytes;
    return { balance, deletionReward };
  }

  getPage(hash: string, now = Date.now()): StoredPage | undefined {
    const page = this.database.query<{ html: string; expires_at: number }>(
      "SELECT html, expires_at FROM pages WHERE hash = ?",
    ).get(hash);
    if (page === null) return undefined;
    if (page.expires_at > now) return { html: page.html, expiresAt: page.expires_at };
    this.database.prepare("DELETE FROM pages WHERE hash = ?").run(hash);
    this.bytes -= pageStorageBytes(hash, page.html);
    return undefined;
  }

  publishPage(
    userId: string,
    hash: string,
    html: string,
    cost: number,
    leaseMs: number,
  ): { expiresAt: number; balance: number } {
    let nextBytes = this.bytes;
    const transaction = this.database.transaction(() => {
      const existing = this.database.query<{ html: string; expires_at: number }>(
        "SELECT html, expires_at FROM pages WHERE hash = ?",
      ).get(hash);
      if (existing !== null && existing.html !== html) throw new Error("Page hash collision; existing content was not changed");
      const balance = this.balance(userId);
      if (balance < cost) throw new InsufficientBalanceError(balance, cost);
      if (existing === null) nextBytes += pageStorageBytes(hash, html);
      if (nextBytes > MAX_STORAGE_BYTES) throw new Error("Storage limit exceeded");
      const expiresAt = Math.max(Date.now(), existing?.expires_at ?? Date.now()) + leaseMs;
      this.database.prepare("UPDATE users SET balance = balance - ? WHERE id = ?").run(cost, userId);
      this.database.prepare(`INSERT INTO pages (hash, html, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(hash) DO UPDATE SET expires_at = excluded.expires_at`).run(hash, html, expiresAt);
      return { expiresAt, balance: balance - cost };
    });
    const result = transaction();
    this.bytes = nextBytes;
    return result;
  }

  purgeExpiredPages(now = Date.now()): void {
    const expired = this.database.query<{ hash: string; html: string }>(
      "SELECT hash, html FROM pages WHERE expires_at <= ?",
    ).all(now);
    if (expired.length === 0) return;
    this.database.prepare("DELETE FROM pages WHERE expires_at <= ?").run(now);
    for (const page of expired) this.bytes -= pageStorageBytes(page.hash, page.html);
  }

  private ensureUser(userId: string): void {
    this.database.prepare("INSERT INTO users (id, balance) VALUES (?, 0) ON CONFLICT(id) DO NOTHING").run(userId);
  }
}
