import { Database } from "bun:sqlite";
import { procHash } from "./hash.ts";
import { validateProcCode } from "./parser.ts";
import { entryBytes, MAX_STORAGE_BYTES, MAX_STORAGE_OPERATIONS, storageFuelCost } from "./resources.ts";

type Operation =
  | { type: "store"; key: string; value: string }
  | { type: "delete"; key: string };

type Invocation = {
  procHash: string;
  arg: string;
  databasePath: string;
  storageBytes: number;
  storageFuel: number;
  stateRoot: string;
};

type Proc = { $: "proc"; code: string };

type ProcContext = {
  store: (key: string, value: string) => void;
  load: (key: string) => string | undefined;
  delete: (key: string) => void;
  has: (key: string) => boolean;
  hash: (proc: Proc) => string;
  invoke: (procHash: string, arg: string) => unknown;
  validate: (code: string) => void;
} & ReturnType<typeof makeBuilder>;

function makeBuilder() {
  type Schema<T> = (value: unknown) => T;
  type Infer<S extends Schema<unknown>> = S extends Schema<infer T> ? T : never;

  const string: Schema<string> = value => {
    if (typeof value === "string") return value;
    throw new Error(`Expected string, got ${typeof value}`);
  };
  const number: Schema<number> = value => {
    if (typeof value === "number") return value;
    throw new Error(`Expected number, got ${typeof value}`);
  };
  const boolean: Schema<boolean> = value => {
    if (typeof value === "boolean") return value;
    throw new Error(`Expected boolean, got ${typeof value}`);
  };
  function record<T>(schema: Schema<T>): Schema<Record<string, T>> {
    return value => {
      if (typeof value !== "object" || value === null) throw new Error(`Expected object, got ${typeof value}`);
      const result: Record<string, T> = Object.create(null) as Record<string, T>;
      for (const key in value) result[key] = schema((value as Record<string, unknown>)[key]);
      return result;
    };
  }
  function struct<T extends Record<string, Schema<any>>>(schemas: T): Schema<{ [K in keyof T]: Infer<T[K]> }> {
    return value => {
      if (typeof value !== "object" || value === null) throw new Error(`Expected object, got ${typeof value}`);
      const result: Partial<{ [K in keyof T]: Infer<T[K]> }> = Object.create(null) as Partial<{ [K in keyof T]: Infer<T[K]> }>;
      for (const key in schemas) result[key] = schemas[key]!((value as Record<string, unknown>)[key]);
      return result as { [K in keyof T]: Infer<T[K]> };
    };
  }
  function constant<T extends string | number | boolean>(expected: T): Schema<T> {
    return value => {
      if (value === expected) return expected;
      throw new Error(`Expected ${expected}, got ${value}`);
    };
  }
  function union<T extends Schema<any>[]>(...schemas: T): Schema<Infer<T[number]>> {
    return value => {
      for (const schema of schemas) {
        try { return schema(value); } catch { /* try the next schema */ }
      }
      throw new Error("Value does not match any schema");
    };
  }
  return { string, number, boolean, record, struct, constant, union };
}

const PROC_JSON = Object.freeze({
  parse(value: unknown): unknown {
    if (typeof value !== "string") throw new TypeError("JSON.parse expects a string");
    return JSON.parse(value);
  },
  stringify(value: unknown): string | undefined {
    return JSON.stringify(value);
  },
});

function execute(code: string, ctx: ProcContext, arg: string): unknown {
  // JSON is an explicit, frozen capability rather than an ambient worker global.
  const func = new Function("ctx", "arg", "JSON", `"use strict";\n${code}`);
  return func(ctx, arg, PROC_JSON);
}

self.onmessage = (event: MessageEvent<Invocation>) => {
  const task = event.data;
  const database = new Database(task.databasePath, { readonly: true });
  const readValueStatement = database.query<{ value: string }>("SELECT value FROM storage WHERE key = ?");
  const pending = new Map<string, string | undefined>();
  const operations: Operation[] = [];
  const builder = makeBuilder();
  let usedStorageBytes = task.storageBytes;
  let storageFuel = task.storageFuel;
  let transactionError: string | undefined;

  function storageString(value: unknown, name: string): string {
    if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
    return value;
  }

  function readValue(key: string): string | undefined {
    if (pending.has(key)) return pending.get(key);
    return readValueStatement.get(key)?.value;
  }

  function fail(error: unknown): string {
    const message = String(error);
    transactionError ??= message;
    return message;
  }

  function invokeProcedure(hashValue: string, argValue: string): { ok: unknown } | { error: string } {
    try {
      const hash = storageString(hashValue, "Procedure hash");
      const arg = storageString(argValue, "Procedure argument");
      const code = readValueStatement.get(hash)?.value;
      if (code === undefined) throw new Error(`Unknown procedure: ${hash}`);

      const prefix = `${task.stateRoot}${hash}:`;
      const ctx: ProcContext = {
        ...builder,
        store(key, value) {
          if (operations.length >= MAX_STORAGE_OPERATIONS) throw new Error("Too many storage operations");
          const fullKey = prefix + storageString(key, "Storage key");
          const storedValue = storageString(value, "Stored value");
          const previous = readValue(fullKey);
          const nextBytes = usedStorageBytes - (previous === undefined ? 0 : entryBytes(fullKey, previous))
            + entryBytes(fullKey, storedValue);
          if (nextBytes > MAX_STORAGE_BYTES) throw new Error("Storage limit exceeded");

          const cost = storageFuelCost(fullKey, storedValue, usedStorageBytes);
          if (cost > storageFuel) throw new Error(`Storage write needs ${cost} fuel; ${storageFuel} remains`);
          storageFuel -= cost;
          self.postMessage({ fuelDelta: cost });
          usedStorageBytes = nextBytes;
          pending.set(fullKey, storedValue);
          operations.push({ type: "store", key: fullKey, value: storedValue });
        },
        load(key) { return readValue(prefix + storageString(key, "Storage key")); },
        delete(key) {
          const fullKey = prefix + storageString(key, "Storage key");
          const previous = readValue(fullKey);
          if (previous !== undefined) {
            if (operations.length >= MAX_STORAGE_OPERATIONS) throw new Error("Too many storage operations");
            const reward = storageFuelCost(fullKey, previous, usedStorageBytes);
            const previousFuel = storageFuel;
            usedStorageBytes -= entryBytes(fullKey, previous);
            storageFuel += reward;
            self.postMessage({ fuelDelta: previousFuel - storageFuel });
            pending.set(fullKey, undefined);
            operations.push({ type: "delete", key: fullKey });
          }
        },
        has(key) { return readValue(prefix + storageString(key, "Storage key")) !== undefined; },
        hash: proc => procHash(proc.code),
        invoke: invokeProcedure,
        validate: validateProcCode,
      };
      return { ok: execute(code, ctx, arg) };
    } catch (error) {
      return { error: fail(error) };
    }
  }

  let result: { ok: unknown } | { error: string } = invokeProcedure(task.procHash, task.arg);
  if (transactionError !== undefined) result = { error: transactionError };

  let resultJson: string;
  try {
    resultJson = JSON.stringify(result);
  } catch (error) {
    resultJson = JSON.stringify({ error: fail(error) });
  }

  database.close();
  const commit = transactionError === undefined;
  self.postMessage({ resultJson, operations: commit ? operations : [], commit });
};
