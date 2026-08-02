import { Database } from "bun:sqlite";
import { procHash } from "./hash.ts";
import { validateProcCode } from "./parser.ts";
import {
  MAX_STORAGE_BYTES,
  MAX_STORAGE_OPERATIONS,
  stateStorageBytes,
  storageFuelCost,
} from "./resources.ts";
import type { StateOperation, StateRead } from "./storage.ts";

type Invocation = {
  procHash: string;
  arg: string;
  databasePath: string;
  storageBytes: number;
  storageFuel: number;
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
  stringify(value: unknown): string | undefined { return JSON.stringify(value); },
});
const PROC_STRING = Object.freeze((value?: unknown): string => String(value));
const PROC_MATH = Object.freeze({
  E: Math.E, LN2: Math.LN2, LN10: Math.LN10, LOG2E: Math.LOG2E, LOG10E: Math.LOG10E,
  PI: Math.PI, SQRT1_2: Math.SQRT1_2, SQRT2: Math.SQRT2,
  abs: (value: number) => Math.abs(value), ceil: (value: number) => Math.ceil(value),
  floor: (value: number) => Math.floor(value), round: (value: number) => Math.round(value),
  trunc: (value: number) => Math.trunc(value), min: (...values: number[]) => Math.min(...values),
  max: (...values: number[]) => Math.max(...values), pow: (value: number, exponent: number) => Math.pow(value, exponent),
  sqrt: (value: number) => Math.sqrt(value), cbrt: (value: number) => Math.cbrt(value),
  hypot: (...values: number[]) => Math.hypot(...values), exp: (value: number) => Math.exp(value),
  log: (value: number) => Math.log(value), log2: (value: number) => Math.log2(value),
  log10: (value: number) => Math.log10(value), sin: (value: number) => Math.sin(value),
  cos: (value: number) => Math.cos(value), tan: (value: number) => Math.tan(value),
  asin: (value: number) => Math.asin(value), acos: (value: number) => Math.acos(value),
  atan: (value: number) => Math.atan(value), atan2: (y: number, x: number) => Math.atan2(y, x),
});

function execute(code: string, ctx: ProcContext, arg: string): unknown {
  const func = new Function("ctx", "arg", "JSON", "Math", "String", `"use strict";\n${code}`);
  return func(ctx, arg, PROC_JSON, PROC_MATH, PROC_STRING);
}

self.onmessage = (event: MessageEvent<Invocation>) => {
  const task = event.data;
  const database = new Database(task.databasePath, { readonly: true });
  const procedureStatement = database.query<{ code: string }>("SELECT code FROM procedures WHERE hash = ?");
  const stateStatement = database.query<{ value: string | null; version: number }>(
    "SELECT value, version FROM state WHERE procedure_hash = ? AND key = ?",
  );
  const pending = new Map<string, string | undefined>();
  const reads = new Map<string, StateRead>();
  const operations: StateOperation[] = [];
  const builder = makeBuilder();
  let usedStorageBytes = task.storageBytes;
  let storageFuel = task.storageFuel;
  let transactionError: string | undefined;

  function checkedString(value: unknown, name: string): string {
    if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
    return value;
  }
  function stateId(procedureHash: string, key: string): string {
    return `${procedureHash}\u0000${key}`;
  }
  function readState(procedureHash: string, key: string): string | undefined {
    const id = stateId(procedureHash, key);
    if (pending.has(id)) return pending.get(id);
    const row = stateStatement.get(procedureHash, key);
    if (!reads.has(id)) reads.set(id, { procedureHash, key, version: row?.version ?? null });
    return row?.value ?? undefined;
  }
  function fail(error: unknown): string {
    const message = String(error);
    transactionError ??= message;
    return message;
  }

  function invokeProcedure(hashValue: string, argValue: string): { ok: unknown } | { error: string } {
    try {
      const hash = checkedString(hashValue, "Procedure hash");
      const arg = checkedString(argValue, "Procedure argument");
      const code = procedureStatement.get(hash)?.code;
      if (code === undefined) throw new Error(`Unknown procedure: ${hash}`);
      const ctx: ProcContext = {
        ...builder,
        store(keyValue, value) {
          if (operations.length >= MAX_STORAGE_OPERATIONS) throw new Error("Too many storage operations");
          const key = checkedString(keyValue, "Storage key");
          const storedValue = checkedString(value, "Stored value");
          const previous = readState(hash, key);
          const nextBytes = usedStorageBytes
            - (previous === undefined ? 0 : stateStorageBytes(hash, key, previous))
            + stateStorageBytes(hash, key, storedValue);
          if (nextBytes > MAX_STORAGE_BYTES) throw new Error("Storage limit exceeded");
          const cost = storageFuelCost(`${hash}:${key}`, storedValue, usedStorageBytes);
          if (cost > storageFuel) throw new Error(`Storage write needs ${cost} fuel; ${storageFuel} remains`);
          storageFuel -= cost;
          self.postMessage({ fuelDelta: cost });
          usedStorageBytes = nextBytes;
          pending.set(stateId(hash, key), storedValue);
          operations.push({ type: "store", procedureHash: hash, key, value: storedValue });
        },
        load(keyValue) { return readState(hash, checkedString(keyValue, "Storage key")); },
        delete(keyValue) {
          const key = checkedString(keyValue, "Storage key");
          const previous = readState(hash, key);
          if (previous !== undefined) {
            if (operations.length >= MAX_STORAGE_OPERATIONS) throw new Error("Too many storage operations");
            usedStorageBytes -= stateStorageBytes(hash, key, previous);
            // Speculative deletion credit may fund writes, but never extends runtime.
            storageFuel += storageFuelCost(`${hash}:${key}`, previous, usedStorageBytes);
            pending.set(stateId(hash, key), undefined);
            operations.push({ type: "delete", procedureHash: hash, key });
          }
        },
        has(keyValue) { return readState(hash, checkedString(keyValue, "Storage key")) !== undefined; },
        hash: proc => procHash(proc.code), invoke: invokeProcedure, validate: validateProcCode,
      };
      return { ok: execute(code, ctx, arg) };
    } catch (error) {
      return { error: fail(error) };
    }
  }

  let result: { ok: unknown } | { error: string } = invokeProcedure(task.procHash, task.arg);
  if (transactionError !== undefined) result = { error: transactionError };
  let resultJson: string;
  try { resultJson = JSON.stringify(result); }
  catch (error) { resultJson = JSON.stringify({ error: fail(error) }); }
  database.close();
  const commit = transactionError === undefined;
  self.postMessage({
    resultJson,
    reads: [...reads.values()],
    operations: commit ? operations : [],
    commit,
  });
};
