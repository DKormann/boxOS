import { Database } from "bun:sqlite";

export const INITIAL_USER_FUEL = 2_000_000;
export const STORAGE_FUEL_PER_BYTE = 8;

export type CodeKind = "reducer" | "procedure";
export type StoredCode = { hash: string; kind: CodeKind; code: string };
export type StateVisibility = "private" | "public";
export type StateRead = { hash: string; visibility: StateVisibility; key: string; version: number };
export type StateMutation =
  | { hash: string; visibility: StateVisibility; key: string; operation: "set"; value: unknown }
  | { hash: string; visibility: StateVisibility; key: string; operation: "delete" };

export class InsufficientFuelError extends Error {
  constructor(readonly balance: number, readonly required: number) {
    super(`Insufficient fuel: ${required} required, ${balance} available`);
    this.name = "InsufficientFuelError";
  }
}

export class TransactionConflictError extends Error {
  constructor(readonly hash: string, readonly visibility: StateVisibility, readonly key: string) {
    super(`Transaction conflict while reading ${hash}/${visibility}/${key}`);
    this.name = "TransactionConflictError";
  }
}

/** Durable code, accounts, and versioned reducer state. */
export class Storage {
  private readonly db: Database;

  constructor(path = "boxos.sqlite") {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS code (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, source TEXT NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, fuel INTEGER NOT NULL)");
    this.db.exec(`CREATE TABLE IF NOT EXISTS reducer_state (
      reducer_hash TEXT NOT NULL, visibility TEXT NOT NULL, key TEXT NOT NULL,
      value TEXT NOT NULL, locked_fuel INTEGER NOT NULL,
      PRIMARY KEY (reducer_hash, visibility, key)
    )`);
    // Versions survive deletion, so a transaction which observed a missing key
    // conflicts if another transaction creates and deletes that key before commit.
    this.db.exec(`CREATE TABLE IF NOT EXISTS state_versions (
      reducer_hash TEXT NOT NULL, visibility TEXT NOT NULL, key TEXT NOT NULL,
      version INTEGER NOT NULL,
      PRIMARY KEY (reducer_hash, visibility, key)
    )`);
    this.db.exec(`INSERT OR IGNORE INTO state_versions (reducer_hash, visibility, key, version)
      SELECT reducer_hash, visibility, key, 1 FROM reducer_state`);
  }

  close(): void {
    this.db.close();
  }

  putSystemCode(hash: string, kind: CodeKind, code: string): void {
    const found = this.get(hash);
    if (found) {
      if (found.kind !== kind || found.code !== code) throw new Error("SHA-256 collision or code kind mismatch");
      return;
    }
    this.db.prepare("INSERT INTO code (hash, kind, source) VALUES (?, ?, ?)").run(hash, kind, code);
  }

  registerCode(user: string, hash: string, kind: CodeKind, code: string): { created: boolean; cost: number; balance: number } {
    return this.db.transaction(() => {
      this.ensureUser(user);
      const found = this.get(hash);
      if (found) {
        if (found.kind !== kind || found.code !== code) throw new Error("SHA-256 collision or code kind mismatch");
        return { created: false, cost: 0, balance: this.balance(user) };
      }
      const cost = utf8Bytes(code) * STORAGE_FUEL_PER_BYTE;
      this.debit(user, cost);
      this.db.prepare("INSERT INTO code (hash, kind, source) VALUES (?, ?, ?)").run(hash, kind, code);
      return { created: true, cost, balance: this.balance(user) };
    })();
  }

  get(hash: string): StoredCode | undefined {
    const row = this.db.query<{ hash: string; kind: string; source: string }>(
      "SELECT hash, kind, source FROM code WHERE hash = ?",
    ).get(hash);
    return row ? { hash: row.hash, kind: row.kind as CodeKind, code: row.source } : undefined;
  }

  account(user: string): number {
    this.ensureUser(user);
    return this.balance(user);
  }

  balance(user: string): number {
    return this.db.query<{ fuel: number }>("SELECT fuel FROM users WHERE id = ?").get(user)?.fuel ?? 0;
  }

  reserveFuel(user: string, amount: number): number {
    return this.db.transaction(() => {
      this.ensureUser(user);
      this.debit(user, amount);
      return this.balance(user);
    })();
  }

  creditFuel(user: string, amount: number): number {
    this.ensureUser(user);
    this.db.prepare("UPDATE users SET fuel = fuel + ? WHERE id = ?").run(amount, user);
    return this.balance(user);
  }

  putSystemPublicValue(hash: string, key: string, value: unknown): void {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("State must be JSON serializable");
    const existing = this.db.query<{ value: string }>(
      "SELECT value FROM reducer_state WHERE reducer_hash = ? AND visibility = 'public' AND key = ?",
    ).get(hash, key);
    if (existing) {
      if (existing.value !== encoded) throw new Error(`Public state collision: ${hash}/${key}`);
      return;
    }
    this.db.transaction(() => {
      this.db.prepare(
        "INSERT INTO reducer_state (reducer_hash, visibility, key, value, locked_fuel) VALUES (?, 'public', ?, ?, 0)",
      ).run(hash, key, encoded);
      this.db.prepare(
        `INSERT INTO state_versions (reducer_hash, visibility, key, version) VALUES (?, 'public', ?, 1)
         ON CONFLICT(reducer_hash, visibility, key) DO UPDATE SET version = version + 1`,
      ).run(hash, key);
    })();
  }

  publicValue(hash: string, key: string): unknown | undefined {
    const row = this.db.query<{ value: string }>(
      "SELECT value FROM reducer_state WHERE reducer_hash = ? AND visibility = 'public' AND key = ?",
    ).get(hash, key);
    return row ? JSON.parse(row.value) : undefined;
  }

  readState(hash: string, visibility: StateVisibility, key: string): { found: boolean; value?: unknown; version: number } {
    const row = this.db.query<{ value: string }>(
      "SELECT value FROM reducer_state WHERE reducer_hash = ? AND visibility = ? AND key = ?",
    ).get(hash, visibility, key);
    const version = this.stateVersion(hash, visibility, key);
    return row ? { found: true, value: JSON.parse(row.value), version } : { found: false, version };
  }

  /**
   * Atomically validate an optimistic read set and apply a compact write set.
   * Unrelated keys are never loaded or rewritten, so independent transactions
   * can execute in parallel and only serialize for their short SQLite commit.
   */
  commitTransaction(
    user: string,
    reads: readonly StateRead[],
    mutations: readonly StateMutation[],
  ): { balance: number; charged: number; repaid: number } {
    return this.db.transaction(() => {
      this.ensureUser(user);
      for (const read of reads) {
        if (this.stateVersion(read.hash, read.visibility, read.key) !== read.version) {
          throw new TransactionConflictError(read.hash, read.visibility, read.key);
        }
      }

      const seen = new Set<string>();
      const changes: Array<{
        mutation: StateMutation;
        previous?: { value: string; locked_fuel: number };
        value?: string;
        locked: number;
        version: number;
      }> = [];
      let charged = 0;
      let repaid = 0;

      for (const mutation of mutations) {
        const id = stateId(mutation.hash, mutation.visibility, mutation.key);
        if (seen.has(id)) throw new TypeError("Duplicate state mutation");
        seen.add(id);
        const previous = this.db.query<{ value: string; locked_fuel: number }>(
          "SELECT value, locked_fuel FROM reducer_state WHERE reducer_hash = ? AND visibility = ? AND key = ?",
        ).get(mutation.hash, mutation.visibility, mutation.key) ?? undefined;
        const version = this.stateVersion(mutation.hash, mutation.visibility, mutation.key);

        if (mutation.operation === "delete") {
          if (!previous) continue;
          repaid += previous.locked_fuel;
          changes.push({ mutation, previous, locked: 0, version });
          continue;
        }

        const value = JSON.stringify(mutation.value);
        if (value === undefined) throw new TypeError("State must be JSON serializable");
        if (previous?.value === value) continue;
        if (previous) repaid += previous.locked_fuel;
        const locked = (utf8Bytes(mutation.key) + utf8Bytes(value)) * STORAGE_FUEL_PER_BYTE;
        charged += locked;
        changes.push({ mutation, previous, value, locked, version });
      }

      const balance = this.balance(user);
      const required = Math.max(0, charged - repaid);
      if (balance < required) throw new InsufficientFuelError(balance, required);

      for (const change of changes) {
        const mutation = change.mutation;
        if (mutation.operation === "delete") {
          this.db.prepare(
            "DELETE FROM reducer_state WHERE reducer_hash = ? AND visibility = ? AND key = ?",
          ).run(mutation.hash, mutation.visibility, mutation.key);
        } else {
          this.db.prepare(`INSERT INTO reducer_state
            (reducer_hash, visibility, key, value, locked_fuel) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(reducer_hash, visibility, key) DO UPDATE SET value = excluded.value, locked_fuel = excluded.locked_fuel`)
            .run(mutation.hash, mutation.visibility, mutation.key, change.value!, change.locked);
        }
        this.db.prepare(`INSERT INTO state_versions (reducer_hash, visibility, key, version) VALUES (?, ?, ?, ?)
          ON CONFLICT(reducer_hash, visibility, key) DO UPDATE SET version = excluded.version`)
          .run(mutation.hash, mutation.visibility, mutation.key, change.version + 1);
      }
      this.db.prepare("UPDATE users SET fuel = fuel + ? WHERE id = ?").run(repaid - charged, user);
      return { balance: this.balance(user), charged, repaid };
    })();
  }

  private stateVersion(hash: string, visibility: StateVisibility, key: string): number {
    return this.db.query<{ version: number }>(
      "SELECT version FROM state_versions WHERE reducer_hash = ? AND visibility = ? AND key = ?",
    ).get(hash, visibility, key)?.version ?? 0;
  }

  private ensureUser(user: string): void {
    this.db.prepare("INSERT INTO users (id, fuel) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
      .run(user, INITIAL_USER_FUEL);
  }

  private debit(user: string, amount: number): void {
    const balance = this.balance(user);
    if (balance < amount) throw new InsufficientFuelError(balance, amount);
    this.db.prepare("UPDATE users SET fuel = fuel - ? WHERE id = ?").run(amount, user);
  }
}

function stateId(hash: string, visibility: StateVisibility, key: string): string {
  return `${hash}\0${visibility}\0${key}`;
}
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
