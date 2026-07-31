import { validateProcCode } from "./parser.ts";

const PORT = 4000;
const INVOCATION_FUEL_MS = 100;
const MAX_REQUEST_BYTES = 1_000_000;

type Proc = { $: "proc"; code: string };
type Operation =
  | { type: "store"; key: string; value: string }
  | { type: "delete"; key: string };
type WorkerReply = { resultJson: string; operations: Operation[] };

const storage = new Map<string, string>();

function procHash(proc: Proc): string {
  return Bun.hash.adler32(proc.code).toString(16);
}

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

async function invokeIsolated(procHash: string, arg: string): Promise<unknown> {
  if (!storage.has(procHash)) return { error: `Unknown procedure: ${procHash}` };

  const worker = new Worker(new URL("./proc-worker.ts", import.meta.url), { smol: true });

  return await new Promise(resolve => {
    let settled = false;
    const finish = (result: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ error: `Fuel exhausted after ${INVOCATION_FUEL_MS}ms` });
    }, INVOCATION_FUEL_MS);

    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (settled) return;
      const message = event.data;
      if (!message || typeof message.resultJson !== "string" || !Array.isArray(message.operations)) {
        finish({ error: "Invalid invocation worker response" });
        return;
      }

      // Timed-out workers never commit partial writes. Successful and caught-error
      // invocations commit their operations in order.
      for (const operation of message.operations) {
        if (operation.type === "store") storage.set(operation.key, operation.value);
        else if (operation.type === "delete") storage.delete(operation.key);
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

    worker.postMessage({ procHash, arg, storage: [...storage.entries()] });
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
      validateProcCode(code);
      const hash = procHash({ $: "proc", code });
      storage.set(hash, code);
      return json({ ok: hash });
    }

    if ("invoke" in request) {
      const hash = requireString(request, "invoke");
      const arg = requireString(request, "arg");
      // Keep the original API shape: dispatch succeeds, then the inner result is
      // either {ok: procedureResult} or {error: ...}.
      return json({ ok: await invokeIsolated(hash, arg) });
    }

    if ("inspect" in request) {
      const key = requireString(request, "inspect");
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
    if (url.pathname !== "/proc") return new Response("Not Found", { status: 404 });
    if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
    return handleProc(req);
  },
});

console.log(`boxOS listening on http://localhost:${PORT}`);
