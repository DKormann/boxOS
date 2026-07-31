import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { procHash } from "./hash.ts";

const port = 41_000 + Math.floor(Math.random() * 10_000);
const origin = `http://localhost:${port}`;
const bun = Bun.which("bun")!;
const environment = Object.fromEntries(
  Object.entries(Bun.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
environment.PORT = String(port);

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
  if (typeof operation.invoke === "string") return `invoke\n${operation.invoke}\n${operation.arg}`;
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

beforeAll(async () => {
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
});

afterAll(async () => {
  server.kill();
  await server.exited;
});

describe("boxOS HTTP server", () => {
  test("serves the example client", async () => {
    const response = await fetch(`${origin}/example`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>boxOS example</title>");
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

    const invoked = await signedRequest({ invoke: registered.ok, arg: "world" }, 100);
    expect(invoked.ok).toBe("hello, world");
  });

  test("charges worker creation fuel", async () => {
    const code = "return arg;";
    const registered = await signedRequest({ register: code }, 1);
    const invoked = await signedRequest({ invoke: registered.ok, arg: "x" }, 5);
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

    const unpaidWrite = await signedRequest({ invoke: registered.ok, arg: "write" }, 20);
    expect(unpaidWrite.error).toContain("Storage write needs");

    const seeded = await signedRequest({ invoke: registered.ok, arg: "seed" }, 100);
    expect(seeded.ok).toBe("seeded");

    // With 20 requested fuel, 5 pays for worker creation and only 15 remains.
    // Deleting the 20 KiB value earns enough fuel to write it under another key.
    const moved = await signedRequest({ invoke: registered.ok, arg: "move" }, 20);
    expect(moved.ok).toBe("moved");
  }, 20_000);

  test("limits concurrent workers", async () => {
    const code = "while (true) {}";
    const registered = await signedRequest({ register: code }, 1);
    const operation = { invoke: registered.ok, arg: "" };
    const payloads = await Promise.all(Array.from({ length: 5 }, () => signedPayload(operation, 100)));
    const requests = payloads.map(body => fetch(`${origin}/proc`, { method: "POST", body })
      .then(response => response.json()) as Promise<Record<string, unknown>>);
    const results = await Promise.all(requests);
    expect(results.some(result => typeof result.error === "string" && result.error.includes("Worker limit"))).toBe(true);
  }, 20_000);
});
