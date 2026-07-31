import { procHash, sha256 } from "./hash.ts";
import { validateProcCode } from "./parser.ts";
import {
  entryBytes,
  MAX_STORAGE_BYTES,
  MAX_STORAGE_OPERATIONS,
  MAX_WORKERS,
  storageFuelCost,
  storagePressureMultiplier,
  WORKER_BASE_FUEL,
} from "./resources.ts";
import { PersistentStorage } from "./storage.ts";

const PORT = Number(Bun.env.PORT ?? "4000");
const MAX_FUEL_MS = 100;
const POW_BASE_BITS = 8;
const CHALLENGE_TTL_MS = 60_000;
const MAX_CHALLENGES = 10_000;
const MAX_REQUEST_BYTES = 1_000_000;
const EXAMPLE_FILE = Bun.file(new URL("./example.html", import.meta.url));
const DOCS_FILE = Bun.file(new URL("./docs.html", import.meta.url));
const DATABASE_PATH = Bun.env.BOXOS_DB_PATH ?? "boxos.sqlite";
type Operation =
  | { type: "store"; key: string; value: string }
  | { type: "delete"; key: string };
type WorkerMessage =
  | { fuelDelta: number }
  | { resultJson: string; operations: Operation[] };

const storage = new PersistentStorage(DATABASE_PATH);
const challenges = new Map<string, number>();
let activeWorkers = 0;
const lockedShards = new Set<string>();

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new TypeError(`Expected '${key}' to be a string`);
  return value;
}

function requireShard(request: Record<string, unknown>): string {
  const shard = requireString(request, "shard");
  if (shard.length === 0 || shard.length > 128) {
    throw new TypeError("Expected 'shard' to contain 1 to 128 characters");
  }
  return shard;
}

function requireFuel(request: Record<string, unknown>): number {
  const fuel = request.fuel;
  if (!Number.isInteger(fuel) || (fuel as number) < 1 || (fuel as number) > MAX_FUEL_MS) {
    throw new TypeError(`Expected 'fuel' to be an integer from 1 to ${MAX_FUEL_MS}`);
  }
  return fuel as number;
}

function leadingZeroBits(hex: string): number {
  let count = 0;
  for (const character of hex) {
    const nibble = Number.parseInt(character, 16);
    if (nibble === 0) {
      count += 4;
      continue;
    }
    if (nibble < 2) count += 3;
    else if (nibble < 4) count += 2;
    else if (nibble < 8) count += 1;
    break;
  }
  return count;
}

function verifyProofOfWork(request: Record<string, unknown>, fuel: number, commitment: string): void {
  const challenge = requireString(request, "challenge");
  const nonce = request.nonce;
  if (!Number.isSafeInteger(nonce) || (nonce as number) < 0) {
    throw new TypeError("Expected 'nonce' to be a non-negative safe integer");
  }

  const expiresAt = challenges.get(challenge);
  challenges.delete(challenge); // Every challenge is one-use, including failed proofs.
  if (expiresAt === undefined || expiresAt < Date.now()) throw new Error("Invalid or expired challenge");

  const difficulty = POW_BASE_BITS + Math.ceil(Math.log2(fuel));
  const digest = sha256(JSON.stringify([challenge, fuel, commitment, nonce]));
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
  return json({ challenge, expiresAt, baseDifficultyBits: POW_BASE_BITS, maxFuel: MAX_FUEL_MS });
}

function serverStats(): Response {
  const storageBytes = storage.byteLength;
  const nextWorkerFuelCost = activeWorkers >= MAX_WORKERS
    ? null
    : WORKER_BASE_FUEL * (activeWorkers + 1);
  const now = Date.now();
  let liveChallenges = 0;
  for (const expiresAt of challenges.values()) {
    if (expiresAt >= now) liveChallenges++;
  }

  return json({
    hashing: "SHA-256",
    fuel: {
      minimum: 1,
      maximum: MAX_FUEL_MS,
      workerBaseCost: WORKER_BASE_FUEL,
      nextWorkerCost: nextWorkerFuelCost,
      minimumFuelForNextWorker: nextWorkerFuelCost === null ? null : nextWorkerFuelCost + 1,
      workerCostFormula: "workerBaseCost * (activeWorkers + 1)",
    },
    workers: {
      active: activeWorkers,
      limit: MAX_WORKERS,
      lockedShards: lockedShards.size,
      locking: "exclusive per requested shard",
    },
    storage: {
      backend: "sqlite",
      persistent: true,
      usedBytes: storageBytes,
      limitBytes: MAX_STORAGE_BYTES,
      pressureMultiplier: storagePressureMultiplier(storageBytes),
      fuelPerStartedKiB: storagePressureMultiplier(storageBytes),
      operationLimitPerInvocation: MAX_STORAGE_OPERATIONS,
    },
    proofOfWork: {
      baseDifficultyBits: POW_BASE_BITS,
      difficultyFormula: "baseDifficultyBits + ceil(log2(fuel))",
      challengeTtlMs: CHALLENGE_TTL_MS,
      liveChallenges,
      challengeLimit: MAX_CHALLENGES,
    },
    requestBodyLimitBytes: MAX_REQUEST_BYTES,
  });
}

function commitOperations(operations: Operation[]): string | undefined {
  if (operations.length > MAX_STORAGE_OPERATIONS) return "Too many storage operations";

  const pending = new Map<string, string | undefined>();
  let usedBytes = storage.byteLength;
  for (const operation of operations) {
    if (!operation || typeof operation.key !== "string") return "Invalid storage operation";
    const previous = pending.has(operation.key) ? pending.get(operation.key) : storage.get(operation.key);
    if (previous !== undefined) usedBytes -= entryBytes(operation.key, previous);

    if (operation.type === "store" && typeof operation.value === "string") {
      usedBytes += entryBytes(operation.key, operation.value);
      pending.set(operation.key, operation.value);
    } else if (operation.type === "delete") {
      pending.set(operation.key, undefined);
    } else {
      return "Invalid storage operation";
    }
    if (usedBytes > MAX_STORAGE_BYTES) return "Storage limit exceeded";
  }

  try {
    storage.apply(pending);
    return undefined;
  } catch (error) {
    return `Storage persistence failed: ${errorMessage(error)}`;
  }
}

async function invokeIsolated(procHash: string, shard: string, arg: string, fuel: number): Promise<unknown> {
  if (!storage.has(procHash)) return { error: `Unknown procedure: ${procHash}` };

  const requestDeadline = Date.now() + fuel;
  while (lockedShards.has(shard) || activeWorkers >= MAX_WORKERS) {
    const remaining = requestDeadline - Date.now();
    if (remaining <= 0) return { error: "Fuel exhausted waiting for a shard or worker lock" };
    await Bun.sleep(Math.min(remaining, 2));
  }

  const creationCost = WORKER_BASE_FUEL * (activeWorkers + 1);
  const fuelDeadlineAtCreation = requestDeadline - creationCost;
  const workerFuel = Math.floor(fuelDeadlineAtCreation - Date.now());
  if (workerFuel <= 0) return { error: `Worker creation needs ${creationCost} fuel` };

  const storageBytes = storage.byteLength;
  const stateRoot = `s:${sha256(shard)}:`;
  const shardStorage: [string, string][] = [];
  for (const entry of storage.entries()) {
    const isProcedure = /^[0-9a-f]{64}$/.test(entry[0]);
    if (isProcedure || entry[0].startsWith(stateRoot)) shardStorage.push(entry);
  }

  lockedShards.add(shard);
  let worker: Worker;
  try {
    worker = new Worker(new URL("./proc-worker.ts", import.meta.url), { smol: true });
  } catch (error) {
    lockedShards.delete(shard);
    return { error: `Could not create invocation worker: ${errorMessage(error)}` };
  }
  activeWorkers++;

  return await new Promise(resolve => {
    let settled = false;
    let fuelDeadline = fuelDeadlineAtCreation;
    let timer: ReturnType<typeof setTimeout>;
    const fuelError = (): { error: string } => ({
      error: `Fuel exhausted (${creationCost} fuel paid for worker creation)`,
    });
    const finish = (result: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      activeWorkers--;
      lockedShards.delete(shard);
      resolve(result);
    };
    const scheduleTimeout = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(fuelError()), Math.max(0, fuelDeadline - Date.now()));
    };

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (settled) return;
      const message = event.data;
      if (message && "fuelDelta" in message) {
        if (!Number.isSafeInteger(message.fuelDelta)) {
          finish({ error: "Invalid invocation worker response" });
          return;
        }
        fuelDeadline -= message.fuelDelta;
        scheduleTimeout();
        return;
      }
      if (Date.now() >= fuelDeadline) {
        finish(fuelError());
        return;
      }
      if (!message || !("resultJson" in message) || typeof message.resultJson !== "string" || !Array.isArray(message.operations)) {
        finish({ error: "Invalid invocation worker response" });
        return;
      }

      // Timed-out workers never commit partial writes. Completed invocations
      // commit their operation log atomically after enforcing the global limit.
      const storageError = commitOperations(message.operations);
      if (storageError !== undefined) {
        finish({ error: storageError });
        return;
      }

      try {
        finish(JSON.parse(message.resultJson));
      } catch {
        finish({ error: "Invocation returned invalid JSON" });
      }
    };

    worker.onerror = event => {
      finish({ error: `Invocation worker failed: ${event.message}` });
    };

    scheduleTimeout();
    try {
      worker.postMessage({
        procHash,
        arg,
        storage: shardStorage,
        storageBytes,
        storageFuel: workerFuel,
        stateRoot,
      });
    } catch (error) {
      finish({ error: `Could not start invocation: ${errorMessage(error)}` });
    }
  });
}

async function handleProc(req: Request): Promise<Response> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return json({ error: "Request body is too large" }, 413);
  }

  try {
    const body = await req.text();
    if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
      return json({ error: "Request body is too large" }, 413);
    }

    const value: unknown = JSON.parse(body);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("Expected a JSON object");
    }
    const request = value as Record<string, unknown>;

    if ("register" in request) {
      const code = requireString(request, "register");
      const fuel = requireFuel(request);
      verifyProofOfWork(request, fuel, `register\n${code}`);
      validateProcCode(code);
      const hash = procHash(code);
      const usedBytes = storage.byteLength;
      const previous = storage.get(hash);
      const nextBytes = usedBytes - (previous === undefined ? 0 : entryBytes(hash, previous)) + entryBytes(hash, code);
      if (nextBytes > MAX_STORAGE_BYTES) throw new Error("Storage limit exceeded");
      const cost = storageFuelCost(hash, code, usedBytes);
      if (cost > fuel) throw new Error(`Registration storage needs ${cost} fuel`);
      storage.set(hash, code);
      return json({ ok: hash });
    }

    if ("invoke" in request) {
      const hash = requireString(request, "invoke");
      const shard = requireShard(request);
      const arg = requireString(request, "arg");
      const fuel = requireFuel(request);
      verifyProofOfWork(request, fuel, `invoke\n${shard}\n${hash}\n${arg}`);
      return json(await invokeIsolated(hash, shard, arg, fuel));
    }

    if ("inspect" in request) {
      const key = requireString(request, "inspect");
      const fuel = requireFuel(request);
      verifyProofOfWork(request, fuel, `inspect\n${key}`);
      if (key.includes(":")) throw new Error("Invalid inspect key");
      return json({ ok: storage.get(key) });
    }

    throw new TypeError("Expected 'register', 'invoke', or 'inspect'");
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }
}

Bun.serve({
  hostname: Bun.env.HOST ?? "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("OK", { status: 200 });
    if (url.pathname === "/stats") {
      if (req.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
      return serverStats();
    }
    if (url.pathname === "/docs") {
      if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      return new Response(await DOCS_FILE.text(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'",
        },
      });
    }
    if (url.pathname === "/challenge") {
      if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      return issueChallenge();
    }
    if (url.pathname === "/example" || url.pathname === "/example/") {
      if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      return new Response(await EXAMPLE_FILE.text(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
        },
      });
    }
    if (url.pathname !== "/proc") return new Response("Not Found", { status: 404 });
    if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
    return handleProc(req);
  },
});

console.log(`boxOS listening on http://localhost:${PORT}`);
