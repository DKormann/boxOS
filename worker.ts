import { pageHash, sha256 } from "./hash.ts";
import type { CodeKind, StateSnapshot, StoredCode } from "./storage.ts";

type Start = { type: "start"; hash: string; kind: CodeKind; code: string; input: unknown; caller: string };
type TransactionData = { type: "transaction-data"; id: number; reducers: StoredCode[]; state: StateSnapshot };
type CommitResult = { type: "commit-result"; id: number; ok: boolean; error?: string };
type ParentMessage = Start | TransactionData | CommitResult;

type Transaction = {
  id: number;
  resolve: (value: TransactionData) => void;
  reject: (error: Error) => void;
};

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) =>
  (...values: unknown[]) => Promise<unknown>;
let nextId = 1;
const waitingData = new Map<number, Transaction>();
const waitingCommit = new Map<number, Transaction>();
let transactionOpen = false;
let activeCaller = "";

function message(value: unknown): void {
  postMessage(value);
}

function cloneJson<T>(value: T, label = "value"): T {
  if (value === undefined) throw new TypeError(`${label} must be JSON serializable`);
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error();
    return JSON.parse(encoded) as T;
  } catch {
    throw new TypeError(`${label} must be JSON serializable`);
  }
}

function reducerContext(hash: string, state: StateSnapshot, caller: string) {
  const owned = state[hash] ??= {
    private: Object.create(null) as Record<string, unknown>,
    public: Object.create(null) as Record<string, unknown>,
  };
  const key = (value: unknown): string => {
    if (typeof value !== "string" || value.length > 1024) throw new TypeError("State keys must be strings of at most 1024 characters");
    return value;
  };
  const slot = (values: Record<string, unknown>) => Object.freeze({
    get(value: unknown) {
      const name = key(value);
      return Object.hasOwn(values, name) ? cloneJson(values[name]) : undefined;
    },
    has(value: unknown) { return Object.hasOwn(values, key(value)); },
    set(value: unknown, next: unknown) { values[key(value)] = cloneJson(next, "State value"); },
    delete(value: unknown) { delete values[key(value)]; },
  });
  return Object.freeze({
    caller,
    sha256(value: unknown) {
      if (typeof value !== "string") throw new TypeError("sha256 expects a string");
      return sha256(value);
    },
    pageHash(value: unknown) {
      if (typeof value !== "string") throw new TypeError("pageHash expects a string");
      return pageHash(value);
    },
    state: Object.freeze({ private: slot(owned.private), public: slot(owned.public) }),
  });
}

function runReducer(reducer: StoredCode, input: unknown, state: StateSnapshot, caller: string): unknown {
  const fn = new Function("ctx", "input", "JSON", "Math", "String", `"use strict";\n${reducer.code}`);
  return fn(reducerContext(reducer.hash, state, caller), cloneJson(input, "Reducer input"), JSON_CAP, MATH_CAP, String);
}

async function transaction(callback: unknown): Promise<unknown> {
  if (typeof callback !== "function") throw new TypeError("transaction expects a function");
  if (transactionOpen) throw new Error("Nested transactions are not allowed");
  transactionOpen = true;
  const id = nextId++;
  try {
    const data = await new Promise<TransactionData>((resolve, reject) => {
      waitingData.set(id, { id, resolve, reject });
      message({ type: "transaction-start", id });
    });
    const reducers = new Map(data.reducers.map(reducer => [reducer.hash, reducer]));
    const tx: { invoke(hash: unknown, input: unknown): unknown } = Object.freeze({
      invoke(hash: unknown, input: unknown) {
        if (typeof hash !== "string") throw new TypeError("Reducer hash must be a string");
        const reducer = reducers.get(hash);
        if (!reducer) throw new Error(`Unknown reducer: ${hash}`);
        return cloneJson(runReducer(reducer, input, data.state, activeCaller), "Reducer result");
      },
    });
    const result = cloneJson(await (callback as (transaction: { invoke(hash: unknown, input: unknown): unknown }) => unknown)(tx), "Transaction result");
    await new Promise<TransactionData>((resolve, reject) => {
      waitingCommit.set(id, { id, resolve, reject });
      message({ type: "transaction-commit", id, state: data.state });
    });
    return result;
  } catch (error) {
    message({ type: "transaction-abort", id });
    throw error;
  } finally {
    transactionOpen = false;
  }
}

const JSON_CAP = Object.freeze({ parse: JSON.parse, stringify: JSON.stringify });
const MATH_CAP = Object.freeze({
  abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round, trunc: Math.trunc,
  min: Math.min, max: Math.max, pow: Math.pow, sqrt: Math.sqrt,
});

async function safeFetch(resource: unknown, options?: unknown): Promise<unknown> {
  if (typeof resource !== "string") throw new TypeError("fetch URL must be a string");
  const response = await fetch(resource, cloneJson(options ?? {}, "fetch options") as RequestInit);
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  response.headers.forEach((value, name) => { headers[name] = value; });
  return { status: response.status, ok: response.ok, headers, body: await response.text() };
}

async function run(start: Start): Promise<void> {
  try {
    activeCaller = start.caller;
    let result: unknown;
    if (start.kind === "reducer") {
      result = await transaction((tx: { invoke(hash: unknown, input: unknown): unknown }) => tx.invoke(start.hash, start.input));
    } else {
      const ctx = Object.freeze({ caller: start.caller, transaction, fetch: safeFetch });
      const fn = new AsyncFunction("ctx", "input", "JSON", "Math", "String", `"use strict";\n${start.code}`);
      result = await fn(ctx, cloneJson(start.input, "Procedure input"), JSON_CAP, MATH_CAP, String);
    }
    message({ type: "result", result: cloneJson(result, "Result") });
  } catch (error) {
    message({ type: "error", error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
}

onmessage = (event: MessageEvent<ParentMessage>) => {
  const data = event.data;
  if (data.type === "start") void run(data);
  else if (data.type === "transaction-data") {
    const pending = waitingData.get(data.id);
    if (pending) { waitingData.delete(data.id); pending.resolve(data); }
  } else if (data.type === "commit-result") {
    const pending = waitingCommit.get(data.id);
    if (pending) {
      waitingCommit.delete(data.id);
      if (data.ok) pending.resolve({ type: "transaction-data", id: data.id, reducers: [], state: {} });
      else pending.reject(new Error(data.error ?? "Transaction commit failed"));
    }
  }
};
