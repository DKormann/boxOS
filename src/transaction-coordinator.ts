import {
  Storage,
  type StateMutation,
  type StateRead,
  type StateVisibility,
  type StoredCode,
} from "./storage.ts";

export type TransactionLimits = Readonly<{
  maximumReducers: number;
  maximumReads: number;
  maximumReadBytes: number;
  maximumMutations: number;
  maximumWriteBytes: number;
  maximumValueBytes: number;
}>;

type SessionRead = StateRead & { found: boolean; value?: unknown };
type Session = {
  reducers: Set<string>;
  reads: Map<string, SessionRead>;
  readBytes: number;
};

type MutationValidator = (mutation: StateMutation) => void;

/** Coordinates one invocation's optimistic transactions outside the worker. */
export class TransactionCoordinator {
  private readonly sessions = new Map<number, Session>();

  constructor(
    private readonly storage: Storage,
    private readonly caller: string,
    readonly limits: TransactionLimits,
    private readonly validateMutation: MutationValidator = () => {},
  ) {}

  begin(id: number): void {
    if (this.sessions.has(id)) throw new Error("Transaction already exists");
    this.sessions.set(id, { reducers: new Set(), reads: new Map(), readBytes: 0 });
  }

  loadReducer(id: number, hash: string): StoredCode {
    const session = this.session(id);
    const reducer = this.storage.get(hash);
    if (!reducer || reducer.kind !== "reducer") throw new Error(`Unknown reducer: ${hash}`);
    if (!session.reducers.has(hash) && session.reducers.size >= this.limits.maximumReducers) {
      throw new Error(`A transaction may invoke at most ${this.limits.maximumReducers} reducers`);
    }
    session.reducers.add(hash);
    return reducer;
  }

  read(id: number, hash: string, visibility: StateVisibility, key: string): { found: boolean; value?: unknown } {
    const session = this.session(id);
    if (!session.reducers.has(hash)) throw new Error("State read targets an unloaded reducer");
    if (visibility !== "private" && visibility !== "public") throw new TypeError("Invalid state visibility");
    if (typeof key !== "string" || key.length > 1024) throw new TypeError("Invalid state key");

    const address = stateAddress(hash, visibility, key);
    let read = session.reads.get(address);
    if (!read) {
      if (session.reads.size >= this.limits.maximumReads) {
        throw new Error(`A transaction may read at most ${this.limits.maximumReads} keys`);
      }
      const value = this.storage.readState(hash, visibility, key);
      const bytes = utf8Bytes(JSON.stringify({ key, value: value.value }));
      if (session.readBytes + bytes > this.limits.maximumReadBytes) {
        throw new Error("Transaction read set is too large");
      }
      read = { hash, visibility, key, ...value };
      session.reads.set(address, read);
      session.readBytes += bytes;
    }
    return read.found ? { found: true, value: read.value } : { found: false };
  }

  commit(id: number, value: unknown): { balance: number; charged: number; repaid: number } {
    const session = this.session(id);
    try {
      const mutations = this.checkedMutations(value, session.reducers);
      const reads = [...session.reads.values()].map(({ hash, visibility, key, version }) => ({
        hash, visibility, key, version,
      }));
      return this.storage.commitTransaction(this.caller, reads, mutations);
    } finally {
      this.sessions.delete(id);
    }
  }

  abort(id: number): void {
    this.sessions.delete(id);
  }

  clear(): void {
    this.sessions.clear();
  }

  private session(id: number): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("No active transaction");
    return session;
  }

  private checkedMutations(value: unknown, reducers: ReadonlySet<string>): StateMutation[] {
    if (!Array.isArray(value) || value.length > this.limits.maximumMutations) {
      throw new TypeError(`A transaction may contain at most ${this.limits.maximumMutations} state mutations`);
    }
    const encoded = JSON.stringify(value);
    if (utf8Bytes(encoded) > this.limits.maximumWriteBytes) throw new TypeError("Transaction write set is too large");

    const seen = new Set<string>();
    return value.map(item => {
      const candidate = record(item, "State mutation");
      if (typeof candidate.hash !== "string" || !reducers.has(candidate.hash)) {
        throw new TypeError("Mutation targets an unloaded reducer");
      }
      if (candidate.visibility !== "private" && candidate.visibility !== "public") {
        throw new TypeError("Invalid state visibility");
      }
      if (typeof candidate.key !== "string" || candidate.key.length > 1024) throw new TypeError("Invalid state key");
      const address = stateAddress(candidate.hash, candidate.visibility, candidate.key);
      if (seen.has(address)) throw new TypeError("Duplicate state mutation");
      seen.add(address);

      let mutation: StateMutation;
      if (candidate.operation === "delete") {
        mutation = {
          hash: candidate.hash,
          visibility: candidate.visibility,
          key: candidate.key,
          operation: "delete",
        };
      } else {
        if (candidate.operation !== "set") throw new TypeError("Invalid state operation");
        const serialized = JSON.stringify(candidate.value);
        if (serialized === undefined || utf8Bytes(serialized) > this.limits.maximumValueBytes) {
          throw new TypeError("Invalid or oversized state value");
        }
        mutation = {
          hash: candidate.hash,
          visibility: candidate.visibility,
          key: candidate.key,
          operation: "set",
          value: candidate.value,
        };
      }
      this.validateMutation(mutation);
      return mutation;
    });
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function stateAddress(hash: string, visibility: StateVisibility, key: string): string {
  return `${hash}\0${visibility}\0${key}`;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
