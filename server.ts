import { fullPageHash, pageHash, procHash, sha256 } from "./hash.ts";
import { validateProcCode } from "./parser.ts";
import { MAX_STORAGE_BYTES, MAX_STORAGE_OPERATIONS, MAX_WORKERS, storagePressureMultiplier, WORKER_BASE_FUEL } from "./resources.ts";
import {
  InsufficientBalanceError,
  PersistentStorage,
  TransactionConflictError,
  type StateOperation,
  type StateRead,
} from "./storage.ts";

const PORT = Number(Bun.env.PORT ?? "4000");
const MAX_INVOCATION_FUEL = 100;
const MAX_FUND_AMOUNT = 10_000;
const POW_BASE_BITS = Number(Bun.env.POW_BASE_BITS ?? "8");
const CHALLENGE_TTL_MS = 60_000;
const MAX_CHALLENGES = 10_000;
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_PAGE_BYTES = 32 * 1024;
const PAGE_COST = 3_200;
const PAGE_LEASE_MS = 7 * 24 * 60 * 60 * 1000;
const PAGES_BASE_DOMAIN = Bun.env.PAGES_BASE_DOMAIN ?? "pages.boxos.org";
const PAGES_SCHEME = Bun.env.PAGES_SCHEME ?? "https";
const EXAMPLE_HTML = await Bun.file(new URL("./example.html", import.meta.url)).text();
const EXAMPLE_PAGE_HASH = pageHash(EXAMPLE_HTML);
const EXAMPLE_LEGACY_PAGE_HASH = fullPageHash(EXAMPLE_HTML);
const DOCS_FILE = Bun.file(new URL("./docs.html", import.meta.url));
const CLIENT_FILE = Bun.file(new URL("./client.js", import.meta.url));
const DATABASE_PATH = Bun.env.BOXOS_DB_PATH ?? "boxos.sqlite";

type WorkerMessage =
  | { fuelDelta: number }
  | {
      resultJson: string;
      reads: StateRead[];
      operations: StateOperation[];
      commit: boolean;
    };

const storage = new PersistentStorage(DATABASE_PATH);
const challenges = new Map<string, number>();
let activeWorkers = 0;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new TypeError(`Expected '${key}' to be a string`);
  return value;
}

function requireInteger(record: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`Expected '${key}' to be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function userId(req: Request): string {
  const authorization = req.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (match === null) throw new Error("A 256-bit bearer identity is required");
  return sha256(match[1]!);
}

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) throw new Error("Request body is too large");
  const body = await req.text();
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) throw new Error("Request body is too large");
  return requireObject(JSON.parse(body));
}

function leadingZeroBits(hex: string): number {
  let count = 0;
  for (const character of hex) {
    const nibble = Number.parseInt(character, 16);
    if (nibble === 0) { count += 4; continue; }
    if (nibble < 2) count += 3;
    else if (nibble < 4) count += 2;
    else if (nibble < 8) count += 1;
    break;
  }
  return count;
}

function verifyProofOfWork(request: Record<string, unknown>, amount: number, commitment: string): void {
  const challenge = requireString(request, "challenge");
  const nonce = request.nonce;
  if (!Number.isSafeInteger(nonce) || (nonce as number) < 0) throw new TypeError("Expected a non-negative safe-integer nonce");
  const expiresAt = challenges.get(challenge);
  challenges.delete(challenge);
  if (expiresAt === undefined || expiresAt < Date.now()) throw new Error("Invalid or expired challenge");
  const difficulty = POW_BASE_BITS + Math.ceil(Math.log2(amount));
  const digest = sha256(JSON.stringify([challenge, amount, commitment, nonce]));
  if (leadingZeroBits(digest) < difficulty) throw new Error("Invalid proof of work");
}

function issueChallenge(): Response {
  const now = Date.now();
  for (const [challenge, expiresAt] of challenges) {
    if (expiresAt >= now) break;
    challenges.delete(challenge);
  }
  while (challenges.size >= MAX_CHALLENGES) {
    const oldest = challenges.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    challenges.delete(oldest);
  }
  const challenge = crypto.randomUUID();
  const expiresAt = now + CHALLENGE_TTL_MS;
  challenges.set(challenge, expiresAt);
  return json({ challenge, expiresAt, baseDifficultyBits: POW_BASE_BITS, maxFundAmount: MAX_FUND_AMOUNT });
}

function balanceError(error: unknown): Response {
  if (error instanceof InsufficientBalanceError) {
    return json({ error: error.message, code: "insufficient_balance", balance: error.balance, required: error.required }, 402);
  }
  return json({ error: errorMessage(error) }, 400);
}

async function invokeOptimistically(procedureHash: string, arg: string, fuel: number, user: string): Promise<unknown> {
  if (!storage.hasProcedure(procedureHash)) return { error: `Unknown procedure: ${procedureHash}`, code: "unknown_procedure" };
  const startedAt = Date.now();
  let balance: number;
  try { balance = storage.reserveFuel(user, fuel); }
  catch (error) {
    if (error instanceof InsufficientBalanceError) {
      return { error: error.message, code: "insufficient_balance", balance: error.balance, required: fuel };
    }
    return { error: errorMessage(error) };
  }

  let deadline = startedAt + fuel;
  while (activeWorkers >= MAX_WORKERS) {
    if (Date.now() >= deadline) return { error: "Fuel exhausted waiting for a worker", balance };
    await Bun.sleep(2);
  }

  const creationCost = WORKER_BASE_FUEL * (activeWorkers + 1);
  deadline -= creationCost;
  const workerFuel = Math.floor(deadline - Date.now());
  if (workerFuel <= 0) return { error: `Worker creation needs ${creationCost} fuel`, balance };

  let worker: Worker;
  try { worker = new Worker(new URL("./proc-worker.ts", import.meta.url), { smol: true }); }
  catch (error) { return { error: `Could not create invocation worker: ${errorMessage(error)}`, balance }; }
  activeWorkers++;

  return await new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      activeWorkers--;
      resolve(result);
    };
    const scheduleTimeout = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => finish({ error: "Fuel exhausted", balance }), Math.max(0, deadline - Date.now()));
    };

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (settled) return;
      const message = event.data;
      if (message && "fuelDelta" in message) {
        if (!Number.isSafeInteger(message.fuelDelta) || message.fuelDelta < 0) {
          finish({ error: "Invalid invocation worker response", balance });
          return;
        }
        deadline -= message.fuelDelta;
        scheduleTimeout();
        return;
      }
      if (Date.now() >= deadline) { finish({ error: "Fuel exhausted", balance }); return; }
      if (!message || !("resultJson" in message) || typeof message.resultJson !== "string"
        || !Array.isArray(message.reads) || !Array.isArray(message.operations) || typeof message.commit !== "boolean") {
        finish({ error: "Invalid invocation worker response", balance });
        return;
      }
      let result: Record<string, unknown>;
      try { result = requireObject(JSON.parse(message.resultJson)); }
      catch { finish({ error: "Invocation returned invalid JSON", balance }); return; }
      if (!message.commit) { finish({ ...result, balance }); return; }

      const refund = Math.max(0, Math.min(fuel, Math.floor(deadline - Date.now())));
      try {
        const settlement = storage.commitInvocation(user, message.reads, message.operations, refund);
        finish({
          ...result,
          fuel: { reserved: fuel, spent: fuel - refund, refunded: refund, deletionReward: settlement.deletionReward },
          balance: settlement.balance,
        });
      } catch (error) {
        if (error instanceof TransactionConflictError) {
          finish({ error: error.message, code: "conflict", retryable: true, balance });
        } else {
          finish({ error: errorMessage(error), balance });
        }
      }
    };
    worker.onerror = event => finish({ error: `Invocation worker failed: ${event.message}`, balance });
    scheduleTimeout();
    try {
      worker.postMessage({
        procHash: procedureHash,
        arg,
        databasePath: DATABASE_PATH,
        storageBytes: storage.byteLength,
        storageFuel: workerFuel,
      });
    } catch (error) {
      finish({ error: `Could not start invocation: ${errorMessage(error)}`, balance });
    }
  });
}

async function handleProc(req: Request): Promise<Response> {
  let user: string;
  try { user = userId(req); }
  catch (error) { return json({ error: errorMessage(error), code: "identity_required" }, 401); }
  try {
    const request = await requestBody(req);
    if ("register" in request) {
      const code = requireString(request, "register");
      validateProcCode(code);
      const hash = procHash(code);
      const registration = storage.registerProcedure(user, hash, code);
      return json({ ok: hash, registration });
    }
    if ("invoke" in request) {
      const hash = requireString(request, "invoke");
      const arg = requireString(request, "arg");
      const fuel = requireInteger(request, "fuel", 1, MAX_INVOCATION_FUEL);
      return json(await invokeOptimistically(hash, arg, fuel, user));
    }
    if ("inspect" in request) {
      const hash = requireString(request, "inspect");
      return json({ ok: storage.getProcedure(hash) });
    }
    throw new TypeError("Expected 'register', 'invoke', or 'inspect'");
  } catch (error) {
    return balanceError(error);
  }
}

async function handleFuel(req: Request): Promise<Response> {
  let user: string;
  try { user = userId(req); }
  catch (error) { return json({ error: errorMessage(error), code: "identity_required" }, 401); }
  try {
    const request = await requestBody(req);
    const amount = requireInteger(request, "amount", 1, MAX_FUND_AMOUNT);
    verifyProofOfWork(request, amount, `fuel\n${user}\n${amount}`);
    return json({ ok: { credited: amount, balance: storage.fund(user, amount) } });
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }
}

function pageUrl(hash: string): string {
  return `${PAGES_SCHEME}://${hash}.${PAGES_BASE_DOMAIN}/`;
}
function pageHashFromHostname(hostname: string): string | undefined {
  const suffix = `.${PAGES_BASE_DOMAIN}`;
  if (!hostname.endsWith(suffix)) return undefined;
  const hash = hostname.slice(0, -suffix.length);
  return /^(?:[a-z2-7]{16}|[a-z2-7]{52})$/.test(hash) ? hash : undefined;
}
function servePage(req: Request, hash: string, pathname: string): Response {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
  if (pathname !== "/") return new Response("Not Found", { status: 404 });
  const stored = hash === EXAMPLE_PAGE_HASH || hash === EXAMPLE_LEGACY_PAGE_HASH
    ? { html: EXAMPLE_HTML, expiresAt: Number.MAX_SAFE_INTEGER }
    : storage.getPage(hash);
  if (stored === undefined) return new Response("Page Not Found", { status: 404 });
  const etag = `"${hash}"`;
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=3600",
    "etag": etag,
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(req.method === "HEAD" ? null : stored.html, { headers });
}

async function handlePageUpload(req: Request): Promise<Response> {
  let user: string;
  try { user = userId(req); }
  catch (error) { return json({ error: errorMessage(error), code: "identity_required" }, 401); }
  try {
    const request = await requestBody(req);
    const html = requireString(request, "html");
    const htmlBytes = new TextEncoder().encode(html).byteLength;
    if (htmlBytes < 1 || htmlBytes > MAX_PAGE_BYTES) throw new Error(`Page HTML must contain 1 to ${MAX_PAGE_BYTES} UTF-8 bytes`);
    storage.purgeExpiredPages();
    const hash = pageHash(html);
    const result = storage.publishPage(user, hash, html, PAGE_COST, PAGE_LEASE_MS);
    return json({ ok: { hash, url: pageUrl(hash), expiresAt: result.expiresAt }, balance: result.balance });
  } catch (error) {
    return balanceError(error);
  }
}

function serverStats(): Response {
  storage.purgeExpiredPages();
  const storageBytes = storage.byteLength;
  return json({
    hashing: "SHA-256",
    fuel: {
      maximumInvocation: MAX_INVOCATION_FUEL,
      maximumFunding: MAX_FUND_AMOUNT,
      workerBaseCost: WORKER_BASE_FUEL,
      fundingDifficultyFormula: "baseDifficultyBits + ceil(log2(amount))",
    },
    workers: { active: activeWorkers, limit: MAX_WORKERS, concurrency: "optimistic per-key transactions" },
    storage: {
      backend: "sqlite",
      persistent: true,
      usedBytes: storageBytes,
      limitBytes: MAX_STORAGE_BYTES,
      pressureMultiplier: storagePressureMultiplier(storageBytes),
      operationLimitPerInvocation: MAX_STORAGE_OPERATIONS,
    },
    proofOfWork: {
      baseDifficultyBits: POW_BASE_BITS,
      challengeTtlMs: CHALLENGE_TTL_MS,
      liveChallenges: [...challenges.values()].filter(expiry => expiry >= Date.now()).length,
      challengeLimit: MAX_CHALLENGES,
    },
    pages: {
      baseDomain: PAGES_BASE_DOMAIN,
      hashEncoding: "16-character lowercase Base32 SHA-256 prefix (80 bits)",
      count: storage.pageCount + 1,
      maximumBytes: MAX_PAGE_BYTES,
      publicationCost: PAGE_COST,
      leaseMs: PAGE_LEASE_MS,
    },
    requestBodyLimitBytes: MAX_REQUEST_BYTES,
  });
}

Bun.serve({
  hostname: Bun.env.HOST ?? "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const isPagesHostname = url.hostname === PAGES_BASE_DOMAIN || url.hostname.endsWith(`.${PAGES_BASE_DOMAIN}`);
    if (isPagesHostname) {
      const hash = pageHashFromHostname(url.hostname);
      return hash === undefined ? new Response("Page Not Found", { status: 404 }) : servePage(req, hash, url.pathname);
    }
    if (req.method === "OPTIONS" && ["/balance", "/challenge", "/fuel", "/page", "/proc", "/stats"].includes(url.pathname)) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === "/") return new Response(null, { status: 302, headers: { location: "/example" } });
    if (url.pathname === "/health") return new Response("OK");
    if (url.pathname === "/stats") return req.method === "GET" ? serverStats() : json({ error: "Method Not Allowed" }, 405);
    if (url.pathname === "/challenge") return req.method === "POST" ? issueChallenge() : json({ error: "Method Not Allowed" }, 405);
    if (url.pathname === "/balance") {
      if (req.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
      try { const user = userId(req); return json({ ok: { user, balance: storage.balance(user) } }); }
      catch (error) { return json({ error: errorMessage(error), code: "identity_required" }, 401); }
    }
    if (url.pathname === "/fuel") return req.method === "POST" ? handleFuel(req) : json({ error: "Method Not Allowed" }, 405);
    if (url.pathname === "/client.js") {
      if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      return new Response(await CLIENT_FILE.text(), {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
      });
    }
    if (url.pathname === "/docs") {
      if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      return new Response(await DOCS_FILE.text(), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'" } });
    }
    if (url.pathname === "/example" || url.pathname === "/example/") {
      return req.method === "GET" ? Response.redirect(pageUrl(EXAMPLE_PAGE_HASH), 302) : new Response("Method Not Allowed", { status: 405 });
    }
    if (url.pathname === "/page") return req.method === "POST" ? handlePageUpload(req) : json({ error: "Method Not Allowed" }, 405);
    if (url.pathname === "/proc") return req.method === "POST" ? handleProc(req) : json({ error: "Method Not Allowed" }, 405);
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`boxOS listening on http://localhost:${PORT}`);
