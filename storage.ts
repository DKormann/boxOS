import { Database } from "bun:sqlite";

export const INITIAL_USER_FUEL = 2_000_000;
export const STORAGE_FUEL_PER_BYTE = 8;

export type CodeKind = "reducer" | "procedure";
export type StoredCode = { hash: string; kind: CodeKind; code: string };
export type StateVisibility = "private" | "public";
export type ReducerState = Record<StateVisibility, Record<string, unknown>>;
export type StateSnapshot = Record<string, ReducerState>;

export class InsufficientFuelError extends Error {
  constructor(readonly balance: number, readonly required: number) {
    super(`Insufficient fuel: ${required} required, ${balance} available`);
    this.name = "InsufficientFuelError";
  }
}

/** Durable code, accounts, and reducer state. */
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

  allReducers(): StoredCode[] {
    return this.db.query<{ hash: string; source: string }>(
      "SELECT hash, source FROM code WHERE kind = 'reducer'",
    ).all().map(row => ({ hash: row.hash, kind: "reducer", code: row.source }));
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

  publicValue(hash: string, key: string): unknown | undefined {
    const row = this.db.query<{ value: string }>(
      "SELECT value FROM reducer_state WHERE reducer_hash = ? AND visibility = 'public' AND key = ?",
    ).get(hash, key);
    return row ? JSON.parse(row.value) : undefined;
  }

  snapshot(): StateSnapshot {
    const state: StateSnapshot = Object.create(null) as StateSnapshot;
    for (const row of this.db.query<{ reducer_hash: string; visibility: StateVisibility; key: string; value: string }>(
      "SELECT reducer_hash, visibility, key, value FROM reducer_state",
    ).all()) {
      const reducer = state[row.reducer_hash] ??= emptyReducerState();
      reducer[row.visibility][row.key] = JSON.parse(row.value);
    }
    return state;
  }

  commitState(user: string, state: StateSnapshot): { balance: number; charged: number; repaid: number } {
    return this.db.transaction(() => {
      this.ensureUser(user);
      const oldRows = this.db.query<{
        reducer_hash: string; visibility: StateVisibility; key: string; value: string; locked_fuel: number;
      }>("SELECT reducer_hash, visibility, key, value, locked_fuel FROM reducer_state").all();
      const old = new Map(oldRows.map(row => [stateId(row.reducer_hash, row.visibility, row.key), row]));
      const next: Array<{ hash: string; visibility: StateVisibility; key: string; value: string; locked: number }> = [];
      let charged = 0;
      let repaid = 0;

      for (const hash of Object.keys(state)) {
        for (const visibility of ["private", "public"] as const) {
          for (const key of Object.keys(state[hash]![visibility])) {
            const value = JSON.stringify(state[hash]![visibility][key]);
            if (value === undefined) throw new TypeError("State must be JSON serializable");
            const id = stateId(hash, visibility, key);
            const previous = old.get(id);
            old.delete(id);
            if (previous?.value === value) {
              next.push({ hash, visibility, key, value, locked: previous.locked_fuel });
            } else {
              if (previous) repaid += previous.locked_fuel;
              const locked = (utf8Bytes(key) + utf8Bytes(value)) * STORAGE_FUEL_PER_BYTE;
              charged += locked;
              next.push({ hash, visibility, key, value, locked });
            }
          }
        }
      }
      for (const removed of old.values()) repaid += removed.locked_fuel;

      const balance = this.balance(user);
      const required = Math.max(0, charged - repaid);
      if (balance < required) throw new InsufficientFuelError(balance, required);

      this.db.prepare("DELETE FROM reducer_state").run();
      const insert = this.db.prepare(
        "INSERT INTO reducer_state (reducer_hash, visibility, key, value, locked_fuel) VALUES (?, ?, ?, ?, ?)",
      );
      for (const item of next) insert.run(item.hash, item.visibility, item.key, item.value, item.locked);
      this.db.prepare("UPDATE users SET fuel = fuel + ? WHERE id = ?").run(repaid - charged, user);
      return { balance: this.balance(user), charged, repaid };
    })();
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
function emptyReducerState(): ReducerState {
  return {
    private: Object.create(null) as Record<string, unknown>,
    public: Object.create(null) as Record<string, unknown>,
  };
}
