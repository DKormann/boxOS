import { pageHash, procHash, sha256 } from "./hash.ts";
import { analyzeProcCode, validateProcCode } from "./parser.ts";
import type { CodeKind, StateMutation, StateVisibility, StoredCode } from "./storage.ts";

type Start = {
  type: "start";
  hash: string;
  kind: CodeKind;
  code: string;
  input: unknown;
  caller: string;
  audience: string;
  authorization?: unknown;
};
type Authorization = Readonly<{
  account: string;
  audience: string;
  resource: string;
  capabilities: readonly string[];
  purpose: string;
  grantId: string;
}>;
type OperationResult = { ok: boolean; error?: string };
type TransactionStartResult = OperationResult & { type: "transaction-start-result"; id: number };
type ReducerResult = OperationResult & { type: "reducer-result"; requestId: number; reducer?: StoredCode };
type StateReadResult = OperationResult & {
  type: "state-read-result";
  requestId: number;
  found?: boolean;
  value?: unknown;
};
type CommitResult = OperationResult & { type: "commit-result"; id: number };
type PublishResult = OperationResult & { type: "publish-result"; id: number; result?: unknown };
type ParentMessage = Start | TransactionStartResult | ReducerResult | StateReadResult | CommitResult | PublishResult;

type Pending<T> = { resolve: (value: T) => void; reject: (error: Error) => void };
type CachedState = { found: boolean; value?: unknown };

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) =>
  (...values: unknown[]) => Promise<unknown>;
let nextId = 1;
const waitingStarts = new Map<number, Pending<void>>();
const waitingReducers = new Map<number, Pending<StoredCode>>();
const waitingState = new Map<number, Pending<CachedState>>();
const waitingCommits = new Map<number, Pending<void>>();
const waitingPublish = new Map<number, Pending<unknown>>();
let transactionOpen = false;
let activeCaller = "";
let activeAuthorization: Authorization | undefined;

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

function stateId(hash: string, visibility: StateVisibility, key: string): string {
  return `${hash}\0${visibility}\0${key}`;
}

function reducerContext(
  hash: string,
  caller: string,
  read: (visibility: StateVisibility, key: string) => Promise<CachedState>,
  mutations: Map<string, StateMutation>,
) {
  const key = (value: unknown): string => {
    if (typeof value !== "string" || value.length > 1024) throw new TypeError("State keys must be strings of at most 1024 characters");
    return value;
  };
  const slot = (visibility: StateVisibility) => Object.freeze({
    async get(value: unknown) {
      const found = await read(visibility, key(value));
      return found.found ? cloneJson(found.value) : undefined;
    },
    async has(value: unknown) {
      return (await read(visibility, key(value))).found;
    },
    set(value: unknown, next: unknown) {
      const name = key(value);
      mutations.set(stateId(hash, visibility, name), {
        hash, visibility, key: name, operation: "set", value: cloneJson(next, "State value"),
      });
    },
    delete(value: unknown) {
      const name = key(value);
      mutations.set(stateId(hash, visibility, name), { hash, visibility, key: name, operation: "delete" });
    },
  });
  const authorization = activeAuthorization?.resource === hash ? activeAuthorization : undefined;
  return Object.freeze({
    caller,
    authorization,
    sha256(value: unknown) {
      if (typeof value !== "string") throw new TypeError("sha256 expects a string");
      return sha256(value);
    },
    pageHash(value: unknown) {
      if (typeof value !== "string") throw new TypeError("pageHash expects a string");
      return pageHash(value);
    },
    state: Object.freeze({ private: slot("private"), public: slot("public") }),
  });
}

async function runReducer(
  reducer: StoredCode,
  input: unknown,
  caller: string,
  read: (visibility: StateVisibility, key: string) => Promise<CachedState>,
  mutations: Map<string, StateMutation>,
): Promise<unknown> {
  const fn = new AsyncFunction("ctx", "input", "JSON", "Math", "String", `"use strict";\n${reducer.code}`);
  return await fn(reducerContext(reducer.hash, caller, read, mutations), cloneJson(input, "Reducer input"), JSON_CAP, MATH_CAP, String);
}

async function transaction(callback: unknown): Promise<unknown> {
  if (typeof callback !== "function") throw new TypeError("transaction expects a function");
  if (transactionOpen) throw new Error("Nested transactions are not allowed");
  transactionOpen = true;
  const id = nextId++;
  const reducers = new Map<string, StoredCode>();
  const reducerLoads = new Map<string, Promise<StoredCode>>();
  const state = new Map<string, CachedState>();
  const stateLoads = new Map<string, Promise<CachedState>>();
  const mutations = new Map<string, StateMutation>();
  let invocationTail = Promise.resolve();
  try {
    await new Promise<void>((resolve, reject) => {
      waitingStarts.set(id, { resolve, reject });
      message({ type: "transaction-start", id });
    });

    const loadReducer = (hash: string): Promise<StoredCode> => {
      const loaded = reducers.get(hash);
      if (loaded) return Promise.resolve(loaded);
      const pending = reducerLoads.get(hash);
      if (pending) return pending;
      const requestId = nextId++;
      const promise = new Promise<StoredCode>((resolve, reject) => {
        waitingReducers.set(requestId, { resolve, reject });
        message({ type: "reducer-load", id, requestId, hash });
      }).then(reducer => {
        reducers.set(hash, reducer);
        reducerLoads.delete(hash);
        return reducer;
      });
      reducerLoads.set(hash, promise);
      return promise;
    };

    const read = (hash: string, visibility: StateVisibility, key: string): Promise<CachedState> => {
      const address = stateId(hash, visibility, key);
      const mutation = mutations.get(address);
      if (mutation) return Promise.resolve(mutation.operation === "set"
        ? { found: true, value: cloneJson(mutation.value) }
        : { found: false });
      const cached = state.get(address);
      if (cached) return Promise.resolve(cloneJson(cached));
      const pending = stateLoads.get(address);
      if (pending) return pending;
      const requestId = nextId++;
      const promise = new Promise<CachedState>((resolve, reject) => {
        waitingState.set(requestId, { resolve, reject });
        message({ type: "state-read", id, requestId, hash, visibility, key });
      }).then(value => {
        const cachedValue = cloneJson(value);
        state.set(address, cachedValue);
        stateLoads.delete(address);
        return cloneJson(cachedValue);
      });
      stateLoads.set(address, promise);
      return promise;
    };

    const tx: { invoke(hash: unknown, input: unknown): Promise<unknown> } = Object.freeze({
      invoke(hash: unknown, input: unknown) {
        if (typeof hash !== "string") return Promise.reject(new TypeError("Reducer hash must be a string"));
        // Reducer calls within one transaction are deliberately ordered. Separate
        // transactions still run on separate workers in parallel, while local
        // ordering keeps transaction behavior deterministic.
        const invocation = invocationTail.then(async () => {
          const reducer = await loadReducer(hash);
          return cloneJson(await runReducer(
            reducer,
            input,
            activeCaller,
            (visibility, key) => read(hash, visibility, key),
            mutations,
          ), "Reducer result");
        });
        invocationTail = invocation.then(() => undefined, () => undefined);
        return invocation;
      },
    });
    const result = cloneJson(await (callback as (transaction: typeof tx) => unknown)(tx), "Transaction result");
    await invocationTail;
    await new Promise<void>((resolve, reject) => {
      waitingCommits.set(id, { resolve, reject });
      message({ type: "transaction-commit", id, mutations: [...mutations.values()] });
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

function checkedCode(kind: unknown, code: unknown): { kind: CodeKind; code: string; hash: string } {
  if (kind !== "reducer" && kind !== "procedure") throw new TypeError("kind must be 'reducer' or 'procedure'");
  if (typeof code !== "string") throw new TypeError("code must be a string");
  validateProcCode(code, ["ctx", "input", "JSON", "Math", "String"], true);
  return { kind, code, hash: procHash(code) };
}

function validateCode(kind: unknown, code: unknown): unknown {
  const valid = checkedCode(kind, code);
  const analysis = analyzeProcCode(valid.code, ["ctx", "input", "JSON", "Math", "String"], true);
  return { kind: valid.kind, hash: valid.hash, references: analysis.references };
}

async function publishCode(kind: unknown, code: unknown): Promise<unknown> {
  const valid = checkedCode(kind, code);
  const id = nextId++;
  return await new Promise((resolve, reject) => {
    waitingPublish.set(id, { resolve, reject });
    message({ type: "publish", id, kind: valid.kind, code: valid.code });
  });
}

function base64UrlBytes(value: unknown, name: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError(`${name} must be Base64URL`);
  const encoded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(encoded + "=".repeat((4 - encoded.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function verifySignature(publicKey: unknown, messageValue: unknown, signatureValue: unknown): Promise<boolean> {
  if (typeof messageValue !== "string") throw new TypeError("Signed message must be a string");
  const keyBytes = base64UrlBytes(publicKey, "Public key");
  const signature = base64UrlBytes(signatureValue, "Signature");
  if (keyBytes.byteLength !== 32 || signature.byteLength !== 64) return false;
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode(messageValue));
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Authorization must be JSON serializable");
  return encoded;
}

async function authenticate(value: unknown, audience: string): Promise<Authorization | undefined> {
  if (value == null) return undefined;
  const envelope = record(value, "Authorization");
  const grant = record(envelope.grant, "Authorization grant");
  if (typeof envelope.publicKey !== "string" || typeof envelope.message !== "string" || typeof envelope.signature !== "string") {
    throw new TypeError("Invalid authorization envelope");
  }
  if (envelope.message !== canonicalJson(grant)) throw new TypeError("Authorization message is not canonical");
  if (grant.version !== 2 || grant.domain !== "boxos-capability" || typeof grant.account !== "string"
    || typeof grant.audience !== "string" || typeof grant.resource !== "string"
    || typeof grant.purpose !== "string" || typeof grant.grantId !== "string" || !Array.isArray(grant.capabilities)) {
    throw new TypeError("Invalid capability grant");
  }
  if (grant.account !== sha256(envelope.publicKey) || grant.audience !== audience || !/^[a-f0-9]{64}$/.test(grant.resource)
    || grant.purpose.length > 500 || grant.grantId.length < 1 || grant.grantId.length > 200
    || grant.capabilities.length < 1 || grant.capabilities.length > 20) {
    throw new TypeError("Invalid capability grant");
  }
  const capabilities: string[] = [];
  for (const capability of grant.capabilities) {
    if (typeof capability !== "string" || capability.length < 1 || capability.length > 200) throw new TypeError("Invalid capability grant");
    capabilities.push(capability);
  }
  const normalized = [...new Set(capabilities)].sort();
  if (JSON.stringify(capabilities) !== JSON.stringify(normalized)) throw new TypeError("Capabilities must be sorted and unique");
  if (!await verifySignature(envelope.publicKey, envelope.message, envelope.signature)) throw new TypeError("Invalid authorization signature");
  return Object.freeze({
    account: grant.account,
    audience: grant.audience,
    resource: grant.resource,
    capabilities: Object.freeze(capabilities),
    purpose: grant.purpose,
    grantId: grant.grantId,
  });
}

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
    activeAuthorization = await authenticate(start.authorization, start.audience);
    let result: unknown;
    if (start.kind === "reducer") {
      result = await transaction((tx: { invoke(hash: unknown, input: unknown): Promise<unknown> }) => tx.invoke(start.hash, start.input));
    } else {
      const ctx = Object.freeze({
        caller: start.caller,
        authorization: activeAuthorization,
        transaction,
        fetch: safeFetch,
        validate: validateCode,
        publish: publishCode,
        verify: verifySignature,
      });
      const fn = new AsyncFunction("ctx", "input", "JSON", "Math", "String", `"use strict";\n${start.code}`);
      result = await fn(ctx, cloneJson(start.input, "Procedure input"), JSON_CAP, MATH_CAP, String);
    }
    message({ type: "result", result: cloneJson(result, "Result") });
  } catch (error) {
    message({ type: "error", error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
}

function settle<T>(pending: Pending<T> | undefined, data: OperationResult, value: T): void {
  if (!pending) return;
  if (data.ok) pending.resolve(value);
  else pending.reject(new Error(data.error ?? "Worker operation failed"));
}

onmessage = (event: MessageEvent<ParentMessage>) => {
  const data = event.data;
  if (data.type === "start") void run(data);
  else if (data.type === "transaction-start-result") {
    const pending = waitingStarts.get(data.id);
    waitingStarts.delete(data.id);
    settle(pending, data, undefined);
  } else if (data.type === "reducer-result") {
    const pending = waitingReducers.get(data.requestId);
    waitingReducers.delete(data.requestId);
    if (data.ok && !data.reducer) pending?.reject(new Error("Reducer response was empty"));
    else settle(pending, data, data.reducer!);
  } else if (data.type === "state-read-result") {
    const pending = waitingState.get(data.requestId);
    waitingState.delete(data.requestId);
    settle(pending, data, data.found ? { found: true, value: data.value } : { found: false });
  } else if (data.type === "commit-result") {
    const pending = waitingCommits.get(data.id);
    waitingCommits.delete(data.id);
    settle(pending, data, undefined);
  } else if (data.type === "publish-result") {
    const pending = waitingPublish.get(data.id);
    waitingPublish.delete(data.id);
    settle(pending, data, data.result);
  }
};
