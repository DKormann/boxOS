import { validateProcCode } from "./parser.ts";

type Operation =
  | { type: "store"; key: string; value: string }
  | { type: "delete"; key: string };

type Invocation = {
  procHash: string;
  arg: string;
  storage: [string, string][];
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
      const result: Record<string, T> = {};
      for (const key in value) result[key] = schema((value as Record<string, unknown>)[key]);
      return result;
    };
  }
  function struct<T extends Record<string, Schema<any>>>(schemas: T): Schema<{ [K in keyof T]: Infer<T[K]> }> {
    return value => {
      if (typeof value !== "object" || value === null) throw new Error(`Expected object, got ${typeof value}`);
      const result: Partial<{ [K in keyof T]: Infer<T[K]> }> = {};
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

function procHash(proc: Proc): string {
  return Bun.hash.adler32(proc.code).toString(16);
}

function invoke(code: string, ctx: ProcContext, arg: string): { ok: unknown } | { error: string } {
  try {
    // Strict mode removes legacy/sloppy behavior from otherwise valid procedure code.
    const func = new Function("ctx", "arg", `"use strict";\n${code}`);
    return { ok: func(ctx, arg) };
  } catch (error) {
    return { error: String(error) };
  }
}

self.onmessage = (event: MessageEvent<Invocation>) => {
  const task = event.data;
  const storage = new Map(task.storage);
  const operations: Operation[] = [];
  const builder = makeBuilder();

  function invokeByHash(hash: string, arg: string): { ok: unknown } | { error: string } {
    const code = storage.get(hash);
    if (code === undefined) return { error: `Unknown procedure: ${hash}` };

    const prefix = `${hash}:`;
    const ctx: ProcContext = {
      ...builder,
      store(key, value) {
        const fullKey = prefix + key;
        storage.set(fullKey, value);
        operations.push({ type: "store", key: fullKey, value });
      },
      load(key) { return storage.get(prefix + key); },
      delete(key) {
        const fullKey = prefix + key;
        storage.delete(fullKey);
        operations.push({ type: "delete", key: fullKey });
      },
      has(key) { return storage.has(prefix + key); },
      hash: procHash,
      invoke: invokeByHash,
      validate: validateProcCode,
    };
    return invoke(code, ctx, arg);
  }

  const result = invokeByHash(task.procHash, task.arg);
  try {
    // Serialize in the worker so arbitrary return values never cross the worker boundary.
    self.postMessage({ resultJson: JSON.stringify(result), operations });
  } catch (error) {
    self.postMessage({ resultJson: JSON.stringify({ error: String(error) }), operations });
  }
};
