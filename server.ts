import { procHash, sha256 } from "./hash.ts";
import { validateProcCode } from "./parser.ts";
import {
  entryBytes,
  MAX_STORAGE_BYTES,
  MAX_STORAGE_OPERATIONS,
  MAX_WORKERS,
  storageFuelCost,
  totalStorageBytes,
  WORKER_BASE_FUEL,
} from "./resources.ts";

const PORT = Number(Bun.env.PORT ?? "4000");
const MAX_FUEL_MS = 100;
const POW_BASE_BITS = 8;
const CHALLENGE_TTL_MS = 60_000;
const MAX_CHALLENGES = 10_000;
const MAX_REQUEST_BYTES = 1_000_000;
const EXAMPLE_FILE = Bun.file(new URL("./example.html", import.meta.url));
type Operation =
  | { type: "store"; key: string; value: string }
  | { type: "delete"; key: string };
type WorkerMessage =
  | { fuelDelta: number }
  | { resultJson: string; operations: Operation[] };

const storage = new Map<string, string>();
const challenges = new Map<string, number>();
let activeWorkers = 0;

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

function commitOperations(operations: Operation[]): string | undefined {
  if (operations.length > MAX_STORAGE_OPERATIONS) return "Too many storage operations";

  const pending = new Map<string, string | undefined>();
  let usedBytes = totalStorageBytes(storage);
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

  for (const [key, value] of pending) {
    if (value === undefined) storage.delete(key);
    else storage.set(key, value);
  }
  return undefined;
}

async function invokeIsolated(procHash: string, arg: string, fuel: number): Promise<unknown> {
  if (!storage.has(procHash)) return { error: `Unknown procedure: ${procHash}` };
  if (activeWorkers >= MAX_WORKERS) return { error: "Worker limit reached; try again later" };

  const creationCost = WORKER_BASE_FUEL * (activeWorkers + 1);
  if (fuel <= creationCost) return { error: `Worker creation needs ${creationCost} fuel` };
  const workerFuel = fuel - creationCost;
  const storageBytes = totalStorageBytes(storage);
  const worker = new Worker(new URL("./proc-worker.ts", import.meta.url), { smol: true });
  activeWorkers++;

  return await new Promise(resolve => {
    let settled = false;
    let fuelDeadline = Date.now() + workerFuel;
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
        storage: [...storage.entries()],
        storageBytes,
        storageFuel: workerFuel,
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
      const usedBytes = totalStorageBytes(storage);
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
      const arg = requireString(request, "arg");
      const fuel = requireFuel(request);
      verifyProofOfWork(request, fuel, `invoke\n${hash}\n${arg}`);
      return json(await invokeIsolated(hash, arg, fuel));
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
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("OK", { status: 200 });
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
