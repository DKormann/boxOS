import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rm } from "fs/promises";
import { procHash } from "./hash.ts";

const port = 41_000 + Math.floor(Math.random() * 10_000);
const origin = `http://localhost:${port}`;
const bun = Bun.which("bun")!;
const environment = Object.fromEntries(
  Object.entries(Bun.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
const databasePath = `/tmp/boxos-${port}.sqlite`;
environment.PORT = String(port);
environment.BOXOS_DB_PATH = databasePath;

let server: ReturnType<typeof Bun.spawn>;

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

function commitment(operation: Record<string, unknown>): string {
  if (typeof operation.register === "string") return `register\n${operation.register}`;
  if (typeof operation.invoke === "string") return `invoke\n${operation.shard}\n${operation.invoke}\n${operation.arg}`;
  return `inspect\n${operation.inspect}`;
}

async function signedRequest(operation: Record<string, unknown>, fuel: number): Promise<Record<string, unknown>> {
  const challenge = await fetch(`${origin}/challenge`, { method: "POST" }).then(response => response.json()) as {
    challenge: string;
    baseDifficultyBits: number;
  };
  const difficulty = challenge.baseDifficultyBits + Math.ceil(Math.log2(fuel));
  let nonce = 0;
  while (leadingZeroBits(createHash("sha256")
    .update(JSON.stringify([challenge.challenge, fuel, commitment(operation), nonce]))
    .digest("hex")) < difficulty) {
    nonce++;
  }

  return await fetch(`${origin}/proc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...operation, fuel, challenge: challenge.challenge, nonce }),
  }).then(response => response.json()) as Record<string, unknown>;
}

async function signedPayload(operation: Record<string, unknown>, fuel: number): Promise<string> {
  const challenge = await fetch(`${origin}/challenge`, { method: "POST" }).then(response => response.json()) as {
    challenge: string;
    baseDifficultyBits: number;
  };
  const difficulty = challenge.baseDifficultyBits + Math.ceil(Math.log2(fuel));
  let nonce = 0;
  while (leadingZeroBits(createHash("sha256")
    .update(JSON.stringify([challenge.challenge, fuel, commitment(operation), nonce]))
    .digest("hex")) < difficulty) {
    nonce++;
  }
  return JSON.stringify({ ...operation, fuel, challenge: challenge.challenge, nonce });
}

async function removeTestDatabase(): Promise<void> {
  await Promise.all([
    rm(databasePath, { force: true }),
    rm(`${databasePath}-wal`, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
  ]);
}

async function startServer(): Promise<void> {
  server = Bun.spawn({
    cmd: [bun, "server.ts"],
    env: environment,
    stdout: "ignore",
    stderr: "inherit",
  });

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${origin}/health`)).ok) return;
    } catch { /* server is still starting */ }
    await Bun.sleep(20);
  }
  throw new Error("Test server did not start");
}

async function stopServer(): Promise<void> {
  server.kill();
  await server.exited;
}

beforeAll(async () => {
  await removeTestDatabase();
  await startServer();
});

afterAll(async () => {
  await stopServer();
  await removeTestDatabase();
});

describe("boxOS HTTP server", () => {
  test("serves the example client", async () => {
    const rootResponse = await fetch(`${origin}/`);
    expect(rootResponse.url).toBe(`${origin}/example`);
    const response = await fetch(`${origin}/example`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("<title>boxOS example</title>");
    expect(body).toContain("ctx.load(\"count\")");
    expect(body).toContain("ctx.store(\"count\"");
  });

  test("serves unstyled client documentation", async () => {
    const response = await fetch(`${origin}/docs`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("boxOS client documentation");
    expect(body.includes("<style")).toBe(false);
  });

  test("reports current prices and limits", async () => {
    const response = await fetch(`${origin}/stats`);
    const stats = await response.json() as {
      workers: { active: number; limit: number };
      fuel: { nextWorkerCost: number };
      storage: { usedBytes: number; limitBytes: number; pressureMultiplier: number };
      proofOfWork: { baseDifficultyBits: number };
    };
    expect(response.status).toBe(200);
    expect(stats.workers.active).toBe(0);
    expect(stats.workers.limit).toBe(4);
    expect(stats.fuel.nextWorkerCost).toBe(5);
    expect(stats.storage.usedBytes).toBe(0);
    expect(stats.storage.limitBytes).toBe(32 * 1024 * 1024);
    expect(stats.storage.pressureMultiplier).toBe(1);
    expect(stats.proofOfWork.baseDifficultyBits).toBe(8);
  });

  test("allows browser clients from any origin", async () => {
    const preflight = await fetch(`${origin}/proc`, {
      method: "OPTIONS",
      headers: {
        origin: "https://client.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("content-type");

    const challenge = await fetch(`${origin}/challenge`, {
      method: "POST",
      headers: { origin: "https://client.example" },
    });
    expect(challenge.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("requires proof of work", async () => {
    const response = await fetch(`${origin}/proc`, {
      method: "POST",
      body: JSON.stringify({ register: "return arg;", fuel: 1 }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("challenge");
  });

  test("registers under SHA-256 and invokes a procedure", async () => {
    const code = 'return "hello, " + arg;';
    const registered = await signedRequest({ register: code }, 1);
    expect(registered.ok).toBe(procHash(code));

    const invoked = await signedRequest({ invoke: registered.ok, shard: "greeting", arg: "world" }, 100);
    expect(invoked.ok).toBe("hello, world");
  });

  test("charges worker creation fuel", async () => {
    const code = "return arg;";
    const registered = await signedRequest({ register: code }, 1);
    const invoked = await signedRequest({ invoke: registered.ok, shard: "fuel-test", arg: "x" }, 5);
    expect(invoked.error).toContain("Worker creation needs 5 fuel");
  });

  test("charges writes and rewards deletion", async () => {
    const code = `
      if (arg === "seed") {
        ctx.store("x", "x".repeat(20 * 1024));
        return "seeded";
      }
      if (arg === "move") {
        ctx.delete("x");
        ctx.store("y", "x".repeat(20 * 1024));
        return "moved";
      }
      ctx.store("z", "x".repeat(20 * 1024));
      return "written";
    `;
    const registered = await signedRequest({ register: code }, 2);

    const unpaidWrite = await signedRequest({ invoke: registered.ok, shard: "storage-test", arg: "write" }, 20);
    expect(unpaidWrite.error).toContain("Storage write needs");

    const seeded = await signedRequest({ invoke: registered.ok, shard: "storage-test", arg: "seed" }, 100);
    expect(seeded.ok).toBe("seeded");

    // With 20 requested fuel, 5 pays for worker creation and only 15 remains.
    // Deleting the 20 KiB value earns enough fuel to write it under another key.
    const moved = await signedRequest({ invoke: registered.ok, shard: "storage-test", arg: "move" }, 20);
    expect(moved.ok).toBe("moved");
  }, 20_000);

  test("serializes invocations of the same shard", async () => {
    const code = `
      let count = +(ctx.load("count") || "0");
      let spin = 0;
      while (spin < 100000) spin++;
      count += 1;
      ctx.store("count", "" + count);
      return count;
    `;
    const registered = await signedRequest({ register: code }, 1);
    const operation = { invoke: registered.ok, shard: "counter", arg: "" };
    const payloads = await Promise.all([
      signedPayload(operation, 100),
      signedPayload(operation, 100),
    ]);
    const results = await Promise.all(payloads.map(body => fetch(`${origin}/proc`, { method: "POST", body })
      .then(response => response.json()) as Promise<Record<string, unknown>>));
    expect(results.map(result => result.ok).sort().join(",")).toBe("1,2");
  });

  test("uses one lock for different procedures on the same shard", async () => {
    const first = await signedRequest({ register: "while (true) {} // same shard one" }, 1);
    const second = await signedRequest({ register: "while (true) {} // same shard two" }, 1);
    const payloads = await Promise.all([
      signedPayload({ invoke: first.ok, shard: "shared-lock", arg: "" }, 100),
      signedPayload({ invoke: second.ok, shard: "shared-lock", arg: "" }, 100),
    ]);
    const requests = payloads.map(body => fetch(`${origin}/proc`, { method: "POST", body }));
    await Bun.sleep(20);
    const stats = await fetch(`${origin}/stats`).then(response => response.json()) as {
      workers: { active: number; lockedShards: number };
    };
    expect(stats.workers.active).toBe(1);
    expect(stats.workers.lockedShards).toBe(1);
    await Promise.all(requests);
  });

  test("runs different shards in parallel up to the worker limit", async () => {
    const registrations = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      signedRequest({ register: `while (true) {} // shard ${index}` }, 1)));
    const payloads = await Promise.all(registrations.map((registered, index) =>
      signedPayload({ invoke: registered.ok, shard: `parallel-${index}`, arg: "" }, 100)));
    const requests = payloads.map(body => fetch(`${origin}/proc`, { method: "POST", body })
      .then(response => response.json()) as Promise<Record<string, unknown>>);
    await Bun.sleep(20);
    const stats = await fetch(`${origin}/stats`).then(response => response.json()) as {
      workers: { active: number; lockedShards: number };
    };
    expect(stats.workers.active).toBe(4);
    expect(stats.workers.lockedShards).toBe(4);

    const results = await Promise.all(requests);
    expect(results.some(result => typeof result.error === "string"
      && (result.error.includes("waiting for a shard or worker lock")
        || result.error.includes("Worker creation needs")))).toBe(true);
  }, 20_000);

  test("allows nested procedures only within the current shard and keeps proc storage separate", async () => {
    const calleeCode = `
      if (arg === "read") return ctx.load("value") || "missing";
      ctx.store("value", arg);
      return arg + "!";
    `;
    const callee = await signedRequest({ register: calleeCode }, 1);
    const callerCode = `return ctx.invoke("${callee.ok}", arg).ok;`;
    const caller = await signedRequest({ register: callerCode }, 1);

    const nested = await signedRequest({ invoke: caller.ok, shard: "nested-a", arg: "saved" }, 100);
    expect(nested.ok).toBe("saved!");

    const sameShard = await signedRequest({ invoke: callee.ok, shard: "nested-a", arg: "read" }, 100);
    expect(sameShard.ok).toBe("saved");

    const otherShard = await signedRequest({ invoke: callee.ok, shard: "nested-b", arg: "read" }, 100);
    expect(otherShard.ok).toBe("missing");
  });

  test("persists procedures across a server restart", async () => {
    const code = 'return arg + " persisted";';
    const registered = await signedRequest({ register: code }, 1);

    await stopServer();
    await startServer();

    const invoked = await signedRequest({ invoke: registered.ok, shard: "persistence", arg: "still" }, 100);
    expect(invoked.ok).toBe("still persisted");
  });
});
