import { COUNTER_REDUCER_CODE, COUNTER_REDUCER_HASH } from "./counter.ts";
import { procHash, sha256 } from "./hash.ts";
import { PAGE_MAX_BYTES, PAGE_REDUCER_CODE, PAGE_REDUCER_HASH } from "./page.ts";
import { ProcSyntaxError, validateProcCode } from "./parser.ts";
import {
  INITIAL_USER_FUEL,
  InsufficientFuelError,
  STORAGE_FUEL_PER_BYTE,
  Storage,
  type CodeKind,
  type StateSnapshot,
} from "./storage.ts";

const HOST = Bun.env.HOST ?? "127.0.0.1";
const PORT = Number(Bun.env.PORT ?? 4000);
const DATABASE = Bun.env.BOXOS_DB_PATH ?? "boxos.sqlite";
const DEFAULT_FUEL = 1_000;
const MAX_FUEL = 10_000;
const MAX_CODE_BYTES = 128 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_STATE_VALUE_BYTES = 256 * 1024;
const storage = new Storage(DATABASE);
const reducerNames = ["ctx", "input", "JSON", "Math", "String"];
validateProcCode(PAGE_REDUCER_CODE, reducerNames);
validateProcCode(COUNTER_REDUCER_CODE, reducerNames);
storage.putSystemCode(PAGE_REDUCER_HASH, "reducer", PAGE_REDUCER_CODE);
storage.putSystemCode(COUNTER_REDUCER_HASH, "reducer", COUNTER_REDUCER_CODE);
const proposalText = await Bun.file(new URL("./proposal.md", import.meta.url)).text();
const clientJavaScript = await Bun.file(new URL("./client.js", import.meta.url)).text();
const pitchHtml = await Bun.file(new URL("./pitch.html", import.meta.url)).text();
const exampleHtml = await Bun.file(new URL("./example.html", import.meta.url)).text();
const docsHtml = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BOXOS proposal</title>
<main><h1>BOXOS</h1><p><a href="/client.js">Example JavaScript client</a></p><pre>${escapeHtml(proposalText)}</pre></main>`;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: CORS });
}
function failure(error: unknown, status = 400): Response {
  if (error instanceof InsufficientFuelError) {
    return json({ error: error.message, code: "insufficient_fuel", balance: error.balance, required: error.required }, 402);
  }
  return json({ error: error instanceof Error ? error.message : String(error) }, status);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected a JSON object");
  return value as Record<string, unknown>;
}
async function body(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new Error("Request body is too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("Request body is too large");
  return object(JSON.parse(text));
}
function codeKind(value: unknown): CodeKind {
  if (value !== "reducer" && value !== "procedure") throw new TypeError("kind must be 'reducer' or 'procedure'");
  return value;
}
function checkHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new TypeError("Invalid SHA-256 hash");
}
function callerId(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new TypeError("A 256-bit bearer identity is required");
  return sha256(match[1]!);
}

async function register(request: Request, fixedKind?: CodeKind): Promise<Response> {
  try {
    const caller = callerId(request);
    const value = await body(request);
    const kind = fixedKind ?? codeKind(value.kind);
    if (typeof value.code !== "string") throw new TypeError("code must be a string");
    if (new TextEncoder().encode(value.code).byteLength > MAX_CODE_BYTES) throw new Error("Code is too large");
    const names = ["ctx", "input", "JSON", "Math", "String"];
    validateProcCode(value.code, names, kind === "procedure");
    const hash = procHash(value.code);
    const registration = storage.registerCode(caller, hash, kind, value.code);
    return json({ hash, kind, ...registration }, registration.created ? 201 : 200);
  } catch (error) {
    const status = error instanceof ProcSyntaxError ? 422 : error instanceof TypeError && error.message.includes("bearer") ? 401 : 400;
    return failure(error, status);
  }
}

let transactionTail = Promise.resolve();
async function lock(): Promise<() => void> {
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  const before = transactionTail;
  transactionTail = transactionTail.then(() => turn);
  await before;
  return release;
}

type Lease = { release: () => void };
type WorkerRequest =
  | { type: "transaction-start"; id: number }
  | { type: "transaction-commit"; id: number; state: StateSnapshot }
  | { type: "transaction-abort"; id: number }
  | { type: "result"; result: unknown }
  | { type: "error"; error: string };

function pageIdFromHostname(hostname: string): string | undefined {
  const label = hostname.split(".")[0];
  return label && /^[a-z2-7]{16}$/.test(label) && hostname.includes(".") ? label : undefined;
}

function servePage(request: Request, url: URL, pageId: string): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
  if (url.pathname !== "/") return new Response("Page Not Found", { status: 404 });
  const value = storage.publicValue(PAGE_REDUCER_HASH, pageId);
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > PAGE_MAX_BYTES) {
    return new Response("Page Not Found", { status: 404 });
  }
  const headers = {
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=31536000, immutable",
    "content-type": "text/html; charset=utf-8",
    "etag": `"${pageId}"`,
    "x-content-type-options": "nosniff",
  };
  if (request.headers.get("if-none-match") === headers.etag) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : value, { headers });
}

function validState(state: unknown): state is StateSnapshot {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  try {
    const encoded = JSON.stringify(state);
    if (new TextEncoder().encode(encoded).byteLength > MAX_STATE_BYTES) return false;
    const reducers = new Set(storage.allReducers().map(item => item.hash));
    return Object.entries(state).every(([hash, value]) => {
      if (!reducers.has(hash) || !value || typeof value !== "object" || Array.isArray(value)) return false;
      const slots = value as Record<string, unknown>;
      return ["private", "public"].every(name => {
        const slot = slots[name];
        if (!slot || typeof slot !== "object" || Array.isArray(slot)) return false;
        return Object.values(slot).every(item => {
          if (hash === PAGE_REDUCER_HASH && name === "public" && typeof item === "string") {
            return new TextEncoder().encode(item).byteLength <= PAGE_MAX_BYTES;
          }
          const serialized = JSON.stringify(item);
          return serialized !== undefined && new TextEncoder().encode(serialized).byteLength <= MAX_STATE_VALUE_BYTES;
        });
      });
    });
  } catch { return false; }
}

async function invoke(hash: string, input: unknown, fuel: number, caller: string): Promise<Response> {
  const code = storage.get(hash);
  if (!code) return failure(`Unknown code: ${hash}`, 404);
  try { storage.reserveFuel(caller, fuel); } catch (error) { return failure(error); }
  const started = performance.now();
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { smol: true });
  } catch (error) {
    return json({ error: String(error), fuel: { reserved: fuel, used: fuel, refunded: 0 }, balance: storage.balance(caller) }, 500);
  }
  const leases = new Map<number, Lease>();
  let storageCharged = 0;
  let storageRepaid = 0;

  return await new Promise<Response>(resolve => {
    let done = false;
    const finish = (response: Response): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      for (const lease of leases.values()) lease.release();
      leases.clear();
      resolve(response);
    };
    const failedFuel = () => ({ reserved: fuel, used: fuel, refunded: 0 });
    const timer = setTimeout(() => finish(json({
      error: "Fuel exhausted", fuel: failedFuel(), balance: storage.balance(caller),
    }, 408)), fuel);

    worker.onerror = event => finish(json({
      error: `Worker failed: ${event.message}`, fuel: failedFuel(), balance: storage.balance(caller),
    }, 500));
    worker.onmessage = event => {
      const message = event.data as WorkerRequest;
      if (message.type === "transaction-start") {
        void lock().then(release => {
          if (done) { release(); return; }
          leases.set(message.id, { release });
          worker.postMessage({
            type: "transaction-data", id: message.id,
            reducers: storage.allReducers(), state: storage.snapshot(),
          });
        });
      } else if (message.type === "transaction-commit") {
        const lease = leases.get(message.id);
        if (!lease) { worker.postMessage({ type: "commit-result", id: message.id, ok: false, error: "No active transaction" }); return; }
        try {
          if (!validState(message.state)) throw new Error("Invalid or oversized reducer state");
          const settlement = storage.commitState(caller, message.state);
          storageCharged += settlement.charged;
          storageRepaid += settlement.repaid;
          worker.postMessage({ type: "commit-result", id: message.id, ok: true });
        } catch (error) {
          worker.postMessage({ type: "commit-result", id: message.id, ok: false, error: String(error) });
        } finally {
          leases.delete(message.id);
          lease.release();
        }
      } else if (message.type === "transaction-abort") {
        const lease = leases.get(message.id);
        if (lease) { leases.delete(message.id); lease.release(); }
      } else if (message.type === "result") {
        const used = Math.min(fuel, Math.max(1, Math.ceil(performance.now() - started)));
        const refunded = fuel - used;
        const balance = storage.creditFuel(caller, refunded);
        finish(json({
          ok: message.result,
          fuel: { reserved: fuel, used, refunded, storageCharged, storageRepaid },
          balance,
        }));
      } else if (message.type === "error") {
        finish(json({ error: message.error, fuel: failedFuel(), balance: storage.balance(caller) }, 422));
      }
    };
    worker.postMessage({ type: "start", hash, kind: code.kind, code: code.code, input, caller });
  });
}

Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    const pageId = pageIdFromHostname(url.hostname);
    if (pageId) return servePage(request, url, pageId);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") return new Response("OK");
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
      return new Response(request.method === "HEAD" ? null : pitchHtml, {
        headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" },
      });
    }
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/example") {
      return new Response(request.method === "HEAD" ? null : exampleHtml, {
        headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" },
      });
    }
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/docs") {
      return new Response(request.method === "HEAD" ? null : docsHtml, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; base-uri 'none'",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/client.js") {
      return new Response(request.method === "HEAD" ? null : clientJavaScript, {
        headers: {
          ...CORS,
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=300",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (request.method === "GET" && url.pathname === "/account") {
      try {
        const user = callerId(request);
        return json({ user, balance: storage.account(user) });
      } catch (error) { return failure(error, 401); }
    }
    if (request.method === "GET" && url.pathname === "/stats") {
      return json({
        fuel: { initialUserFuel: INITIAL_USER_FUEL, runtimeFuelPerMillisecond: 1, maximumInvocation: MAX_FUEL },
        storage: { fuelPerByte: STORAGE_FUEL_PER_BYTE, maximumValueBytes: MAX_STATE_VALUE_BYTES },
        pages: { reducer: PAGE_REDUCER_HASH, maximumBytes: PAGE_MAX_BYTES },
      });
    }
    if (request.method === "GET" && url.pathname === "/page") {
      const urlTemplate = `${url.protocol}//{id}.${url.host}/`;
      return json({ reducer: PAGE_REDUCER_HASH, maximumBytes: PAGE_MAX_BYTES, urlTemplate });
    }
    if (request.method === "POST" && url.pathname === "/code") return register(request);
    if (request.method === "POST" && url.pathname === "/reducers") return register(request, "reducer");
    if (request.method === "POST" && url.pathname === "/procedures") return register(request, "procedure");
    if (request.method === "GET" && url.pathname.startsWith("/code/")) {
      const hash = url.pathname.slice(6);
      try { checkHash(hash); } catch (error) { return failure(error); }
      const found = storage.get(hash);
      return found ? json(found) : failure(`Unknown code: ${hash}`, 404);
    }
    if (request.method === "GET" && url.pathname.startsWith("/state/")) {
      try {
        const path = url.pathname.slice(7);
        const separator = path.indexOf("/");
        if (separator < 0) throw new TypeError("Expected /state/:reducerHash/:key");
        const hash = path.slice(0, separator);
        const key = decodeURIComponent(path.slice(separator + 1));
        checkHash(hash);
        if (key.length > 1024) throw new TypeError("State key is too long");
        const value = storage.publicValue(hash, key);
        return value === undefined ? failure("Public state not found", 404) : json({ hash, key, value });
      } catch (error) { return failure(error); }
    }
    if (request.method === "POST" && (url.pathname === "/invoke" || url.pathname.startsWith("/invoke/"))) {
      try {
        const value = await body(request);
        const hash = url.pathname === "/invoke" ? value.hash : url.pathname.slice(8);
        if (typeof hash !== "string") throw new TypeError("hash must be a string");
        checkHash(hash);
        const fuel = value.fuel ?? DEFAULT_FUEL;
        if (!Number.isInteger(fuel) || (fuel as number) < 1 || (fuel as number) > MAX_FUEL) {
          throw new TypeError(`fuel must be an integer from 1 to ${MAX_FUEL}`);
        }
        let caller: string;
        try { caller = callerId(request); } catch (error) { return failure(error, 401); }
        return invoke(hash, value.input ?? null, fuel as number, caller);
      } catch (error) { return failure(error); }
    }
    return failure("Not found", 404);
  },
});

console.log(`BOXOS listening on http://${HOST}:${PORT}`);
