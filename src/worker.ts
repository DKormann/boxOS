import { pageHash, procHash, sha256 } from "./hash.ts";
import { analyzeProcCode, validateProcCode } from "./parser.ts";
import type { CodeKind, StateSnapshot, StoredCode } from "./storage.ts";

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
type TransactionData = { type: "transaction-data"; id: number; reducers: StoredCode[]; state: StateSnapshot };
type CommitResult = { type: "commit-result"; id: number; ok: boolean; error?: string };
type PublishResult = { type: "publish-result"; id: number; ok: boolean; result?: unknown; error?: string };
type ParentMessage = Start | TransactionData | CommitResult | PublishResult;

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
const waitingPublish = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
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

function checkedCode(kind: unknown, code: unknown): { kind: CodeKind; code: string; hash: string } {
  if (kind !== "reducer" && kind !== "procedure") throw new TypeError("kind must be 'reducer' or 'procedure'");
  if (typeof code !== "string") throw new TypeError("code must be a string");
  validateProcCode(code, ["ctx", "input", "JSON", "Math", "String"], kind === "procedure");
  return { kind, code, hash: procHash(code) };
}

function validateCode(kind: unknown, code: unknown): unknown {
  const valid = checkedCode(kind, code);
  const analysis = analyzeProcCode(
    valid.code,
    ["ctx", "input", "JSON", "Math", "String"],
    valid.kind === "procedure",
  );
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
      result = await transaction((tx: { invoke(hash: unknown, input: unknown): unknown }) => tx.invoke(start.hash, start.input));
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
  } else if (data.type === "publish-result") {
    const pending = waitingPublish.get(data.id);
    if (pending) {
      waitingPublish.delete(data.id);
      if (data.ok) pending.resolve(data.result);
      else pending.reject(new Error(data.error ?? "Publication failed"));
    }
  }
};
